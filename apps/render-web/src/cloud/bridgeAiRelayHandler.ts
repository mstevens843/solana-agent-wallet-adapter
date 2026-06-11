// Cloud relay for the Android "use your ChatGPT/Claude plan from your phone"
// flow. The phone can't reach the user's desktop bridge directly (the bridge
// binds loopback-only — see bridgeServer.ts assertBridgeBindAllowed — and sits
// behind NAT), so the desktop bridge dials OUT to this relay and long-polls for
// work, while the phone POSTs AI requests here. We never touch the bridge's
// bind guard and never open an inbound hole on the user's machine.
//
// This is the message-passing dual of pairingHandler.ts, with the roles
// swapped: there the desktop submits and the phone (wallet-host) polls; here the
// PHONE submits AI requests and the DESKTOP bridge polls its inbox, runs the
// connector CLI under the user's own legitimate session, and posts the result
// back. The relay only ever forwards JSON to a fixed allowlist of /bridge/ai/*
// paths — never executable code (Play Store hard-line).
//
// Trust model: the desktop generates pairUuid + a one-time pairToken (shown in
// the QR) + a long-lived bridgeSecret. The relay stores only SHA-256 hashes. The
// phone claims the pairing with the one-time token and receives a deviceBearer
// (minted relay-side) that authenticates all later AI calls. Tokens are the
// secret — they are high-entropy and never logged. TTL: 30 min since last
// activity (sweeper every 60s); pairTokens expire in ~90s.
//
// Routes (two prefixes, one handler):
//   POST /api/bridge-pair/:uuid/register        desktop registers {pairToken, bridgeSecret}
//   POST /api/bridge-pair/:uuid/claim           phone claims {pairToken} -> {deviceBearer}
//   GET  /api/bridge-pair/:uuid/poll            desktop (x-bridge-secret) polls inbox + paired signal
//   POST /api/bridge-pair/:uuid/respond/:reqId  desktop (x-bridge-secret) posts AI result
//   POST /api/bridge-pair/:uuid/unpair          desktop (x-bridge-secret) revokes the session
//   POST /api/bridge-ai/:uuid/forward           phone (Bearer) submits {path, body} -> {requestId}
//   GET  /api/bridge-ai/:uuid/result/:reqId     phone (Bearer) polls for the result
//   GET  /api/bridge-ai/:uuid/status            phone (Bearer) -> {paired, desktopOnline}
//
// Tests live in `__tests__/bridgeAiRelayHandler.test.ts`; the handler is driven
// through its public `handle(req, res, url)` entry point.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const PAIR_PATH_PREFIX = '/api/bridge-pair/';
const AI_PATH_PREFIX = '/api/bridge-ai/';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SMALL_BODY_BYTES = 8 * 1024; // pairing control messages
const AI_BODY_BYTES = 512 * 1024; // plan/review payloads (policy bundles, prompts) can be large
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PAIR_TOKEN_TTL_MS = 90 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_INBOX_PER_SESSION = 16;
const REQUESTS_PER_MINUTE = 120;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_IN_FLIGHT_LEASE_MS = 5 * 60 * 1000; // a connector run can take minutes
const DESKTOP_ONLINE_WINDOW_MS = 20 * 1000;
const MIN_SECRET_LEN = 20;

// The phone may only forward to these exact bridge AI paths — JSON to known AI
// endpoints, nothing else. Keep in sync with the desktop bridge's /bridge/ai/*
// routes (bridgeServer.ts) and bridgePairingClient.ts's dispatcher.
export const FORWARDABLE_AI_PATHS: ReadonlySet<string> = new Set([
  '/bridge/ai/status',
  '/bridge/ai/session-key',
  '/bridge/ai/connector/detect',
  '/bridge/ai/connector/login',
  '/bridge/ai/generate-plan',
  '/bridge/ai/review-plan',
  '/bridge/ai/ask-about-plan',
  '/bridge/ai/chat',
]);

export interface RelayClock {
  now(): number;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

type RateGroup = 'register' | 'claim' | 'poll' | 'respond' | 'forward' | 'result' | 'status' | 'other';

interface AiRequestEntry {
  requestId: string;
  path: string;
  body: unknown;
  status: 'pending' | 'in_flight' | 'resolved';
  result: unknown | undefined;
  inFlightUntil: number | undefined;
}

interface RelaySession {
  uuid: string;
  pairTokenHash: string | null;
  pairTokenExpiresAt: number;
  bridgeSecretHash: string;
  deviceBearerHash: string | null;
  paired: boolean;
  /** One-shot flag so the desktop's first poll after a claim learns it paired. */
  pairedSignal: boolean;
  inbox: AiRequestEntry[];
  lastDesktopPollAt: number;
  createdAt: number;
  lastSeenAt: number;
  rate: Partial<Record<RateGroup, RateBucket>>;
}

export interface BridgeAiRelayOptions {
  clock?: RelayClock;
  ttlMs?: number;
  pairTokenTtlMs?: number;
  inFlightLeaseMs?: number;
  /** Test hooks for deterministic ids/secrets. */
  generateRequestId?: () => string;
  generateDeviceBearer?: () => string;
}

export interface BridgeAiRelayHandler {
  /** Returns true when the route matched (response written), false otherwise. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  shutdown(): void;
}

export function createBridgeAiRelayHandler(options: BridgeAiRelayOptions = {}): BridgeAiRelayHandler {
  const clock = options.clock ?? { now: () => Date.now() };
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const pairTokenTtlMs = options.pairTokenTtlMs ?? DEFAULT_PAIR_TOKEN_TTL_MS;
  const inFlightLeaseMs = options.inFlightLeaseMs ?? DEFAULT_IN_FLIGHT_LEASE_MS;
  const generateRequestId = options.generateRequestId ?? (() => randomToken(12));
  const generateDeviceBearer = options.generateDeviceBearer ?? (() => randomToken(32));
  const store = new Map<string, RelaySession>();

  const sweeper = setInterval(() => {
    const cutoff = clock.now() - ttlMs;
    for (const [uuid, session] of store) {
      if (session.lastSeenAt < cutoff) store.delete(uuid);
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  function touch(session: RelaySession): void {
    session.lastSeenAt = clock.now();
  }

  function checkRate(session: RelaySession, group: RateGroup): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = clock.now();
    const bucket = session.rate[group] ?? { windowStart: now, count: 0 };
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    session.rate[group] = bucket;
    if (bucket.count >= REQUESTS_PER_MINUTE) {
      return { ok: false, retryAfterMs: Math.max(1000, RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) };
    }
    bucket.count += 1;
    return { ok: true };
  }

  function requireSession(uuid: string): RelaySession {
    const session = store.get(uuid);
    if (!session) throw new RelayError(404, 'pairing_not_found');
    return session;
  }

  function requireBridgeSecret(req: IncomingMessage, session: RelaySession): void {
    const provided = headerValue(req, 'x-bridge-secret');
    if (!provided || !safeEqualHashOf(provided, session.bridgeSecretHash)) {
      throw new RelayError(401, 'bridge_auth_failed');
    }
  }

  function requireDeviceBearer(req: IncomingMessage, session: RelaySession): void {
    if (!session.paired || !session.deviceBearerHash) throw new RelayError(403, 'not_paired');
    const bearer = bearerToken(req);
    if (!bearer || !safeEqualHashOf(bearer, session.deviceBearerHash)) {
      throw new RelayError(401, 'device_auth_failed');
    }
  }

  return {
    async handle(req, res, url) {
      const isPair = url.pathname.startsWith(PAIR_PATH_PREFIX);
      const isAi = url.pathname.startsWith(AI_PATH_PREFIX);
      if (!isPair && !isAi) return false;

      // Tokens are the secret, not the origin — wildcard CORS is safe and the
      // Node bridge / native OkHttp clients aren't subject to it anyway.
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-bridge-secret');
      res.setHeader('access-control-max-age', '600');
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
      }

      const prefix = isPair ? PAIR_PATH_PREFIX : AI_PATH_PREFIX;
      const segments = url.pathname.slice(prefix.length).split('/').filter((s) => s.length > 0);
      if (segments.length < 2) {
        writeJson(res, 404, { error: 'not_found' });
        return true;
      }
      const uuid = segments[0]!;
      if (!UUID_V4_PATTERN.test(uuid)) {
        writeJson(res, 400, { error: 'invalid_pairing_id' });
        return true;
      }
      const action = segments[1]!;
      const trailing = segments[2];
      const method = req.method ?? 'GET';
      const tag = relayTag(uuid);

      try {
        const handled = isPair
          ? await handlePair(req, res, uuid, action, trailing, method)
          : await handleAi(req, res, uuid, action, trailing, method);
        logRelayEvent({ phase: 'req', tag, prefix: isPair ? 'pair' : 'ai', action, method, status: res.statusCode });
        return handled;
      } catch (err) {
        const code = err instanceof RelayError ? err.code : 'internal_error';
        const status = err instanceof RelayError ? err.status : 500;
        writeJson(res, status, { error: code });
        logRelayEvent({ phase: 'req', tag, prefix: isPair ? 'pair' : 'ai', action, method, status, error: code });
        return true;
      }
    },
    shutdown(): void {
      clearInterval(sweeper);
    },
  };

  // --- /api/bridge-pair/* (registration, claim, desktop poll/respond) -------

  async function handlePair(
    req: IncomingMessage,
    res: ServerResponse,
    uuid: string,
    action: string,
    trailing: string | undefined,
    method: string,
  ): Promise<boolean> {
    // `register` bootstraps the session, so it can't go through requireSession.
    if (action === 'register' && method === 'POST' && !trailing) {
      return await postRegister(req, res, uuid);
    }
    const session = requireSession(uuid);
    const rate = checkRate(session, pairRateGroup(action, method, Boolean(trailing)));
    if (!rate.ok) return writeRateLimited(res, rate.retryAfterMs);
    touch(session);

    if (action === 'claim' && method === 'POST' && !trailing) return await postClaim(req, res, session);
    if (action === 'poll' && method === 'GET' && !trailing) return getPoll(req, res, session);
    if (action === 'respond' && method === 'POST' && trailing) return await postRespond(req, res, session, trailing);
    if (action === 'unpair' && method === 'POST' && !trailing) return postUnpair(req, res, session);
    writeJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  async function postRegister(req: IncomingMessage, res: ServerResponse, uuid: string): Promise<boolean> {
    const body = (await readJsonBody(req, SMALL_BODY_BYTES)) as Record<string, unknown>;
    const pairToken = trimmedString(body.pairToken);
    const bridgeSecret = trimmedString(body.bridgeSecret);
    if (pairToken.length < MIN_SECRET_LEN || bridgeSecret.length < MIN_SECRET_LEN) {
      writeJson(res, 400, { error: 'invalid_register_payload' });
      return true;
    }
    const now = clock.now();
    const existing = store.get(uuid);
    if (existing) {
      // Re-registration is only allowed by the same desktop (lets it refresh
      // the QR/pairToken); a mismatched secret means UUID collision/hijack.
      if (!safeEqualHashOf(bridgeSecret, existing.bridgeSecretHash)) {
        writeJson(res, 409, { error: 'pairing_id_in_use' });
        return true;
      }
      existing.pairTokenHash = sha256(pairToken);
      existing.pairTokenExpiresAt = now + pairTokenTtlMs;
      existing.lastSeenAt = now;
      writeJson(res, 200, { ok: true });
      return true;
    }
    store.set(uuid, {
      uuid,
      pairTokenHash: sha256(pairToken),
      pairTokenExpiresAt: now + pairTokenTtlMs,
      bridgeSecretHash: sha256(bridgeSecret),
      deviceBearerHash: null,
      paired: false,
      pairedSignal: false,
      inbox: [],
      lastDesktopPollAt: 0,
      createdAt: now,
      lastSeenAt: now,
      rate: {},
    });
    writeJson(res, 200, { ok: true });
    return true;
  }

  async function postClaim(req: IncomingMessage, res: ServerResponse, session: RelaySession): Promise<boolean> {
    const body = (await readJsonBody(req, SMALL_BODY_BYTES)) as Record<string, unknown>;
    const pairToken = trimmedString(body.pairToken);
    if (session.paired) {
      writeJson(res, 409, { error: 'already_paired' });
      return true;
    }
    if (!session.pairTokenHash || clock.now() > session.pairTokenExpiresAt) {
      writeJson(res, 410, { error: 'pairing_expired' });
      return true;
    }
    if (pairToken.length < MIN_SECRET_LEN || !safeEqualHashOf(pairToken, session.pairTokenHash)) {
      writeJson(res, 403, { error: 'invalid_pair_token' });
      return true;
    }
    const deviceBearer = generateDeviceBearer();
    session.deviceBearerHash = sha256(deviceBearer);
    session.paired = true;
    session.pairedSignal = true;
    session.pairTokenHash = null; // one-time: burn it
    logRelayEvent({ phase: 'claim', tag: relayTag(session.uuid), status: 'paired' });
    writeJson(res, 200, { status: 'paired', deviceBearer });
    return true;
  }

  function getPoll(req: IncomingMessage, res: ServerResponse, session: RelaySession): boolean {
    requireBridgeSecret(req, session);
    const now = clock.now();
    session.lastDesktopPollAt = now;
    // Hand out pending requests plus stale in-flight ones (phone-side retries
    // shouldn't be lost if the desktop crashed mid-run). Fresh in-flight stay
    // hidden so the desktop never double-runs a connector.
    const ready = session.inbox.filter(
      (e) => e.status === 'pending' || (e.status === 'in_flight' && (e.inFlightUntil ?? 0) <= now),
    );
    for (const entry of ready) {
      entry.status = 'in_flight';
      entry.inFlightUntil = now + inFlightLeaseMs;
    }
    const paired = session.pairedSignal;
    session.pairedSignal = false;
    logRelayEvent({ phase: 'poll', tag: relayTag(session.uuid), paired: session.paired, justPaired: paired, count: ready.length });
    writeJson(res, 200, {
      paired: session.paired,
      justPaired: paired,
      requests: ready.map((e) => ({ requestId: e.requestId, path: e.path, body: e.body })),
    });
    return true;
  }

  async function postRespond(
    req: IncomingMessage,
    res: ServerResponse,
    session: RelaySession,
    requestId: string,
  ): Promise<boolean> {
    requireBridgeSecret(req, session);
    const entry = session.inbox.find((e) => e.requestId === requestId);
    if (!entry) {
      writeJson(res, 404, { error: 'request_not_found' });
      return true;
    }
    const body = await readJsonBody(req, AI_BODY_BYTES);
    if (!body || typeof body !== 'object') {
      writeJson(res, 400, { error: 'invalid_result_payload' });
      return true;
    }
    entry.status = 'resolved';
    entry.result = body;
    entry.inFlightUntil = undefined;
    const hasError =
      Boolean(body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string');
    logRelayEvent({ phase: 'respond', tag: relayTag(session.uuid), requestId, path: entry.path, hasError, ...bodyDigest(body) });
    writeJson(res, 200, { ok: true });
    return true;
  }

  function postUnpair(req: IncomingMessage, res: ServerResponse, session: RelaySession): boolean {
    requireBridgeSecret(req, session);
    store.delete(session.uuid);
    writeJson(res, 200, { ok: true });
    return true;
  }

  // --- /api/bridge-ai/* (phone submits + polls results) --------------------

  async function handleAi(
    req: IncomingMessage,
    res: ServerResponse,
    uuid: string,
    action: string,
    trailing: string | undefined,
    method: string,
  ): Promise<boolean> {
    const session = requireSession(uuid);
    const rate = checkRate(session, aiRateGroup(action, method, Boolean(trailing)));
    if (!rate.ok) return writeRateLimited(res, rate.retryAfterMs);
    touch(session);

    if (action === 'forward' && method === 'POST' && !trailing) return await postForward(req, res, session);
    if (action === 'result' && method === 'GET' && trailing) return getResult(req, res, session, trailing);
    if (action === 'status' && method === 'GET' && !trailing) return getStatus(req, res, session);
    writeJson(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  async function postForward(req: IncomingMessage, res: ServerResponse, session: RelaySession): Promise<boolean> {
    requireDeviceBearer(req, session);
    const body = (await readJsonBody(req, AI_BODY_BYTES)) as Record<string, unknown>;
    const path = trimmedString(body.path);
    if (!FORWARDABLE_AI_PATHS.has(path)) {
      writeJson(res, 400, { error: 'path_not_allowed' });
      return true;
    }
    const now = clock.now();
    // Drop the oldest resolved entry to make room before rejecting; if nothing
    // is resolved, the phone is firing faster than the desktop can answer.
    if (session.inbox.length >= MAX_INBOX_PER_SESSION) {
      const idx = session.inbox.findIndex((e) => e.status === 'resolved');
      if (idx === -1) {
        writeJson(res, 429, { error: 'inbox_full' });
        return true;
      }
      session.inbox.splice(idx, 1);
    }
    const requestId = generateRequestId();
    session.inbox.push({
      requestId,
      path,
      body: body.body ?? {},
      status: 'pending',
      result: undefined,
      inFlightUntil: undefined,
    });
    void now;
    logRelayEvent({ phase: 'forward', tag: relayTag(session.uuid), requestId, path, ...bodyDigest(body.body ?? {}) });
    writeJson(res, 200, { requestId, status: 'pending' });
    return true;
  }

  function getResult(req: IncomingMessage, res: ServerResponse, session: RelaySession, requestId: string): boolean {
    requireDeviceBearer(req, session);
    const entry = session.inbox.find((e) => e.requestId === requestId);
    if (!entry) {
      writeJson(res, 404, { error: 'request_not_found' });
      return true;
    }
    logRelayEvent({ phase: 'result', tag: relayTag(session.uuid), requestId, resolved: entry.status === 'resolved', state: entry.status });
    if (entry.status === 'resolved') {
      writeJson(res, 200, { status: 'resolved', result: entry.result ?? null });
      return true;
    }
    writeJson(res, 200, { status: entry.status });
    return true;
  }

  function getStatus(req: IncomingMessage, res: ServerResponse, session: RelaySession): boolean {
    requireDeviceBearer(req, session);
    const desktopOnline = clock.now() - session.lastDesktopPollAt < DESKTOP_ONLINE_WINDOW_MS;
    writeJson(res, 200, { paired: session.paired, desktopOnline });
    return true;
  }
}

// --- helpers ---------------------------------------------------------------

class RelayError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'RelayError';
  }
}

function pairRateGroup(action: string, method: string, hasTrailing: boolean): RateGroup {
  if (action === 'claim' && method === 'POST') return 'claim';
  if (action === 'poll' && method === 'GET') return 'poll';
  if (action === 'respond' && method === 'POST' && hasTrailing) return 'respond';
  if (action === 'register' && method === 'POST') return 'register';
  return 'other';
}

function aiRateGroup(action: string, method: string, hasTrailing: boolean): RateGroup {
  if (action === 'forward' && method === 'POST') return 'forward';
  if (action === 'result' && method === 'GET' && hasTrailing) return 'result';
  if (action === 'status' && method === 'GET') return 'status';
  return 'other';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualHashOf(plaintext: string, expectedHashHex: string): boolean {
  const actual = Buffer.from(sha256(plaintext), 'hex');
  const expected = Buffer.from(expectedHashHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return (raw[0] ?? '').trim();
  return (raw ?? '').trim();
}

function bearerToken(req: IncomingMessage): string {
  const auth = headerValue(req, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1]!.trim() : '';
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new RelayError(413, 'request_too_large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RelayError(400, 'invalid_json');
  }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function writeRateLimited(res: ServerResponse, retryAfterMs: number): boolean {
  res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  writeJson(res, 429, { error: 'rate_limited', retryAfterMs });
  return true;
}

// --- deterministic, secret-safe relay logging ------------------------------------------------
//
// One stable JSON line per relay event, prefixed `[bridge-relay]`, so a single AI request is
// traceable across hops. `tag` = first 8 hex of sha256(pairUuid): the SAME value the desktop
// (bridgePairingClient) and phone (BridgeAiClient) derive from the uuid, so logs from all three
// hops line up — without ever logging the uuid itself (the uuid IS a bearer-grade secret). We
// NEVER log pairTokens, deviceBearers, or bridgeSecrets. Forward/respond BODIES (AI prompts/plans
// — user data, not credentials) are logged only when BRIDGE_RELAY_LOG_BODIES=1, deep-redacted.

const LOG_RELAY_BODIES = (process.env.BRIDGE_RELAY_LOG_BODIES ?? '').trim() === '1';
// Silence under vitest/node test runners so the suites stay clean (mirrors diagnosticLog.ts).
const RELAY_LOG_SILENCED = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';

export function relayTag(uuid: string): string {
  return createHash('sha256').update(uuid, 'utf8').digest('hex').slice(0, 8);
}

function logRelayEvent(event: Record<string, unknown>): void {
  if (RELAY_LOG_SILENCED) return;
  try {
    console.error(`[bridge-relay] ${JSON.stringify(event)}`);
  } catch {
    // logging must never affect the relay result
  }
}

/** Size + content hash of a value; full deep-redacted body only under BRIDGE_RELAY_LOG_BODIES. */
function bodyDigest(value: unknown): Record<string, unknown> {
  let serialized = '';
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    serialized = '';
  }
  const digest: Record<string, unknown> = {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha8: createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 8),
  };
  if (LOG_RELAY_BODIES) digest.body = redactDeep(value);
  return digest;
}

const SECRET_KEY_PATTERN = /token|secret|bearer|api[_-]?key|authorization|private|seed|mnemonic|passphrase/i;

/** Recursively replace credential-ish values so a verbose body dump can't leak secrets. */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactDeep(val);
    }
    return out;
  }
  return value;
}
