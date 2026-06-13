// Phone-side HTTP client for the Plan Connector relay (the "use your ChatGPT/Claude/Gemini plan from
// your computer" path). Ported from Android's `BridgeAiClient.kt` so iOS behaves identically: claim a
// pairing for a device bearer, forward an allowlisted AI request, poll for the desktop's result, check
// presence, and unpair. The relay (agentic-signer.com, `apps/render-web/src/cloud/bridgeAiRelayHandler.ts`)
// is platform-agnostic — it only stores hashes and forwards JSON to a fixed allowlist of /bridge/ai/*
// paths. All AI compute runs on the user's own desktop CLI under their own subscription.
//
// This is deliberately SEPARATE from main.ts's `bridgeRequest`/`bridgeAiRequest` (those target a local
// LAN bridge gated by `isTrustedBridgeUrl`). This client is a cloud relay client with its own pinned
// relay-host allowlist (mirrors Android `BridgeRelayPolicy.kt`).

import {
  type BridgeE2eeSession,
  decryptResponse,
  deserializeE2eeSession,
  encryptRequest,
  prepareClaim,
  randomClientNonce,
  serializeE2eeSession,
} from './bridgeE2ee.js';
import type { PairingPayload } from './bridgePairing.js';
import { logDeviceAgentDiag } from './deviceAgent/runtime/diagnosticLog.js';

// Hosts the app trusts as relays. Subdomains accepted. Keep in lockstep with Android
// `BridgeRelayPolicy.ALLOWED_RELAY_HOSTS` and the iOS capacitor.config allowNavigation list.
const ALLOWED_RELAY_HOSTS = ['agentic-signer.com'];

// The phone may only forward these exact AI verbs (mirrors relay FORWARDABLE_AI_PATHS + Android).
export const FORWARDABLE_AI_PATHS: ReadonlySet<string> = new Set([
  '/bridge/ai/generate-plan',
  '/bridge/ai/review-plan',
  '/bridge/ai/ask-about-plan',
]);

// Below the relay's 1 MB body cap, leaving headroom for the {path, body} wrapper (matches Android).
const MAX_FORWARD_BODY_CHARS = 950_000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
// Must outlive the relay's 10-min in-flight lease so the phone never abandons a run the desktop is
// still metering. Invariant: phoneDeadline >= relayLease >= desktopConnectorTimeout.
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

/** Pairing credentials persisted after a successful claim (device bearer authenticates AI calls). */
export interface BridgePairCreds {
  relay: string;
  uuid: string;
  deviceBearer: string;
  connector?: string;
  /** base64url request/response keys; present only for v2 (E2EE) pairings. */
  e2ee?: { requestKey: string; responseKey: string };
}

export interface BridgeRelayStatus {
  paired: boolean;
  desktopOnline: boolean;
}

export interface ForwardOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Stable error code so callers can show actionable copy. `transient` marks blips safe to re-poll. */
export class BridgeRelayError extends Error {
  constructor(readonly code: string, message: string, readonly transient = false) {
    super(message);
    this.name = 'BridgeRelayError';
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function isAllowedRelay(url: string | undefined | null): boolean {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_RELAY_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function bearerHeaders(creds: BridgePairCreds): Record<string, string> {
  return { Authorization: `Bearer ${creds.deviceBearer}` };
}

function mapRelayStatusCode(status: number): { code: string; transient: boolean } {
  if (status === 401 || status === 403) return { code: 'auth', transient: false };
  if (status === 404 || status === 410) return { code: 'invalid_config', transient: false };
  if (status === 408 || status === 504) return { code: 'timeout', transient: true };
  if (status === 429) return { code: 'rate_limited', transient: true };
  if (status >= 500 && status <= 599) return { code: 'upstream', transient: true };
  return { code: 'invalid_response', transient: false };
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeRelayError('aborted', 'Cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BridgeRelayError('aborted', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function relayFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Caller cancelled (AbortSignal) — propagate as terminal, never retried.
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new BridgeRelayError('aborted', 'Cancelled.');
    }
    // Network-level failure (offline, dropped connection) — transient; runForward keeps polling.
    throw new BridgeRelayError('network', err instanceof Error ? err.message : 'Network error.', true);
  }
}

/** Exchange a one-time pair token (from the QR) for a long-lived device bearer. Validates the relay
 *  host BEFORE any network call so a malicious QR can't pair us against an attacker's relay. */
export async function claimPairing(payload: PairingPayload): Promise<BridgePairCreds> {
  if (!isAllowedRelay(payload.relay)) {
    throw new BridgeRelayError('relay_not_allowed', 'This pairing QR points at an untrusted relay. Generate a fresh QR on your computer.');
  }
  const relay = stripTrailingSlash(payload.relay);
  let prepared: Awaited<ReturnType<typeof prepareClaim>> | undefined;
  if (payload.e2ee) {
    try {
      prepared = await prepareClaim(payload.uuid, payload.e2ee);
    } catch {
      throw new BridgeRelayError('invalid_e2ee', 'This pairing QR uses an unsupported encrypted format. Update the app, then generate a fresh QR.');
    }
  }
  const body: Record<string, unknown> = { pairToken: payload.token };
  if (prepared) body.e2ee = prepared.claim;

  const response = await relayFetch(`${relay}/api/bridge-pair/${payload.uuid}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw claimError(response.status, await safeJson(response));
  }
  const json = await safeJson(response);
  const deviceBearer = typeof json?.deviceBearer === 'string' ? json.deviceBearer.trim() : '';
  if (!deviceBearer) {
    throw new BridgeRelayError('invalid_response', 'Pairing succeeded but returned no device token.');
  }
  return {
    relay,
    uuid: payload.uuid,
    deviceBearer,
    ...(payload.connector ? { connector: payload.connector } : {}),
    ...(prepared ? { e2ee: serializeE2eeSession(prepared.session) } : {}),
  };
}

function claimError(status: number, body: Record<string, unknown> | null): BridgeRelayError {
  if (status === 400) {
    const code = typeof body?.error === 'string' ? body.error : '';
    if (code === 'e2ee_required') {
      return new BridgeRelayError('e2ee_required', 'This pairing QR requires encrypted setup. Update the app if needed, then generate a fresh QR on your computer.');
    }
    return new BridgeRelayError('invalid_config', 'Pairing QR is not compatible. Generate a fresh QR on your computer and try again.');
  }
  if (status === 403) return new BridgeRelayError('auth', 'Pairing code is invalid. Generate a fresh QR on your computer and scan again.');
  if (status === 409) return new BridgeRelayError('already_paired', 'This pairing code was already used. Generate a fresh QR on your computer.');
  if (status === 410) return new BridgeRelayError('expired', 'Pairing code expired. Generate a fresh QR on your computer and scan within a minute.');
  const mapped = mapRelayStatusCode(status);
  return new BridgeRelayError(mapped.code, `Pairing failed (HTTP ${status}). Generate a fresh QR on your computer and try again.`, mapped.transient);
}

function sessionFromCreds(creds: BridgePairCreds): BridgeE2eeSession | undefined {
  return creds.e2ee ? deserializeE2eeSession(creds.e2ee) : undefined;
}

/** Lightweight health probe: is the relay session live and is the desktop currently polling? */
export async function relayStatus(creds: BridgePairCreds, signal?: AbortSignal): Promise<BridgeRelayStatus> {
  const response = await relayFetch(`${stripTrailingSlash(creds.relay)}/api/bridge-ai/${creds.uuid}/status`, {
    method: 'GET',
    headers: bearerHeaders(creds),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return { paired: false, desktopOnline: false };
  if (!response.ok) {
    const mapped = mapRelayStatusCode(response.status);
    throw new BridgeRelayError(mapped.code, `Bridge relay status check failed (HTTP ${response.status}).`, mapped.transient);
  }
  const json = await safeJson(response);
  return { paired: Boolean(json?.paired), desktopOnline: Boolean(json?.desktopOnline) };
}

export async function unpairRelay(creds: BridgePairCreds): Promise<void> {
  try {
    await relayFetch(`${stripTrailingSlash(creds.relay)}/api/bridge-ai/${creds.uuid}/unpair`, {
      method: 'POST',
      headers: bearerHeaders(creds),
    });
  } catch {
    // Best-effort: the relay sweeps stale sessions on its own TTL, so a failed unpair signal is non-fatal.
  }
}

interface ForwardedRequest {
  requestId: string;
  clientNonce?: string;
}

async function forward(creds: BridgePairCreds, session: BridgeE2eeSession | undefined, path: string, body: unknown, signal?: AbortSignal): Promise<ForwardedRequest> {
  let clientNonce: string | undefined;
  let outboundBody: unknown = body;
  if (session) {
    clientNonce = randomClientNonce();
    outboundBody = await encryptRequest(session, { v: 2, path, clientNonce, body });
  }
  const payloadString = JSON.stringify({ path, body: outboundBody });
  if (payloadString.length > MAX_FORWARD_BODY_CHARS) {
    throw new BridgeRelayError('too_large', 'This request is too large to send to your paired computer. Try a shorter prompt.');
  }
  const response = await relayFetch(`${stripTrailingSlash(creds.relay)}/api/bridge-ai/${creds.uuid}/forward`, {
    method: 'POST',
    headers: { ...bearerHeaders(creds), 'content-type': 'application/json' },
    body: payloadString,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const mapped = mapRelayStatusCode(response.status);
    throw new BridgeRelayError(mapped.code, `Bridge relay rejected the request (HTTP ${response.status}).`, mapped.transient);
  }
  const json = await safeJson(response);
  const requestId = typeof json?.requestId === 'string' ? json.requestId.trim() : '';
  if (!requestId) throw new BridgeRelayError('invalid_response', 'Bridge relay did not return a request id.');
  return { requestId, ...(clientNonce ? { clientNonce } : {}) };
}

async function pollResult(
  creds: BridgePairCreds,
  session: BridgeE2eeSession | undefined,
  forwarded: ForwardedRequest,
  path: string,
  signal?: AbortSignal,
): Promise<{ resolved: boolean; payload: Record<string, unknown> | null }> {
  const response = await relayFetch(`${stripTrailingSlash(creds.relay)}/api/bridge-ai/${creds.uuid}/result/${forwarded.requestId}`, {
    method: 'GET',
    headers: bearerHeaders(creds),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const mapped = mapRelayStatusCode(response.status);
    throw new BridgeRelayError(mapped.code, `Bridge relay result poll failed (HTTP ${response.status}).`, mapped.transient);
  }
  const json = await safeJson(response);
  if (!json) return { resolved: false, payload: null };
  if (json.status !== 'resolved') return { resolved: false, payload: null };
  const result = (json.result ?? {}) as Record<string, unknown>;
  if (!session) return { resolved: true, payload: result };
  return { resolved: true, payload: await decodeResult(session, path, forwarded, result) };
}

async function decodeResult(
  session: BridgeE2eeSession,
  path: string,
  forwarded: ForwardedRequest,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let decrypted: Record<string, unknown>;
  try {
    decrypted = (await decryptResponse(session, result)) as Record<string, unknown>;
  } catch {
    throw new BridgeRelayError('invalid_response', 'Encrypted bridge response could not be read.');
  }
  if (decrypted.path !== path) {
    throw new BridgeRelayError('invalid_response', 'Encrypted bridge response did not match the request.');
  }
  if (Number(decrypted.v) !== 2 || decrypted.requestId !== forwarded.requestId || (decrypted.clientNonce ?? '') !== (forwarded.clientNonce ?? '')) {
    throw new BridgeRelayError('invalid_response', 'Encrypted bridge response did not match the request.');
  }
  return (decrypted.result ?? {}) as Record<string, unknown>;
}

/** Submit an allowlisted AI request and block until the desktop returns its result (or times out).
 *  Returns the desktop bridge's response JSON verbatim (the canonical bridge AI response object). */
export async function forwardAi<T = unknown>(creds: BridgePairCreds, path: string, body: unknown, options: ForwardOptions = {}): Promise<T> {
  if (!FORWARDABLE_AI_PATHS.has(path)) {
    throw new BridgeRelayError('path_not_allowed', `Path not allowed for the paired computer: ${path}`);
  }
  const session = sessionFromCreds(creds);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = options.signal;

  // Preflight: if the desktop isn't currently polling, fail fast (seconds) instead of the full timeout.
  // A status() blip is non-fatal (proceed). Only check BEFORE enqueue (mid-run the desktop legitimately
  // stops heartbeating while busy running a connector).
  let live: BridgeRelayStatus | null = null;
  try {
    live = await relayStatus(creds, signal);
  } catch (err) {
    if (err instanceof BridgeRelayError && err.code === 'aborted') throw err;
    live = null;
  }
  if (live && live.paired && !live.desktopOnline) {
    throw new BridgeRelayError('desktop_offline', "Your computer isn't connected right now. Open the Agentic desktop app (and keep it awake), then try again.");
  }

  const forwarded = await forward(creds, session, path, body, signal);
  logDeviceAgentDiag('info', 'bridge-relay.forward', { path, requestId: forwarded.requestId });
  const deadline = now() + requestTimeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs, signal);
    let outcome: { resolved: boolean; payload: Record<string, unknown> | null };
    try {
      outcome = await pollResult(creds, session, forwarded, path, signal);
    } catch (err) {
      // Transient transport blip — keep polling; the relay holds a resolved result for a grace window
      // so a re-poll recovers a run the desktop already completed/metered. Terminal codes propagate.
      if (err instanceof BridgeRelayError && err.transient) {
        logDeviceAgentDiag('info', 'bridge-relay.poll_retry', { requestId: forwarded.requestId, code: err.code });
        continue;
      }
      throw err;
    }
    if (outcome.resolved) {
      const payload = outcome.payload ?? {};
      const error = payload.error;
      if (typeof error === 'string' && error.trim()) {
        // The desktop relays a connector failure as an { error } envelope — re-raise the real message.
        throw new BridgeRelayError('upstream', error);
      }
      logDeviceAgentDiag('info', 'bridge-relay.resolved', { path, requestId: forwarded.requestId });
      return payload as T;
    }
  }
  throw new BridgeRelayError('timeout', "Your computer didn't respond in time. Make sure it's awake, the connector page is open, and the connector is signed in.");
}
