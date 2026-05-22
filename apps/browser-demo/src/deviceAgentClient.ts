// Device Agent async client.
//
// Mirrors the shared Device Agent contract for the gated on-device runtime so
// the browser shell can route generation through the Android JS bridge while
// staying scaffold-only on Render and browser-dev.

import { BROWSER_DEVICE_AGENT_ENABLED } from './devGate.js';
import type { AiDiagnosticCode, AiDiagnosticEntry } from './planner.js';
import { fetchPolicyBundle, spliceBundle, enforceBlockingFailure, type PolicyBundle } from './policyEnrichClient.js';

export type DeviceAgentRuntimeState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'error';
export type DeviceAgentRuntimeKind = 'android-native' | 'tauri-native' | 'render-gated' | 'browser-dev' | 'browser-native';
export type DeviceAgentApiFormat = 'openai-compatible' | 'anthropic';
export type DeviceAgentMethod =
  | 'status'
  | 'configure'
  | 'start'
  | 'stop'
  | 'generatePlan'
  | 'reviewPlan'
  | 'ask';

export interface DeviceAgentStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  state: DeviceAgentRuntimeState;
  runtime: DeviceAgentRuntimeKind;
  provider?: string;
  apiFormat?: DeviceAgentApiFormat;
  baseUrl?: string;
  model?: string;
  walletAddress?: string;
  message?: string;
  checkedAt?: string;
  updatedAt?: string;
  lastError?: DeviceAgentError | null;
}

export interface DeviceAgentError {
  code: string;
  message: string;
  subcode?: string;
}

export interface DeviceAgentConfig {
  provider?: string;
  apiFormat?: DeviceAgentApiFormat;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clear?: boolean;
}

export interface DeviceAgentRequestEnvelope<P = unknown> {
  requestId: string;
  method: DeviceAgentMethod;
  payload: P;
}

export interface DeviceAgentSuccessEnvelope<R = unknown> {
  ok: true;
  status: DeviceAgentStatus;
  result?: R;
}

export interface DeviceAgentErrorEnvelope {
  ok: false;
  status: DeviceAgentStatus;
  error: DeviceAgentError;
}

export type DeviceAgentResponseEnvelope<R = unknown> =
  | DeviceAgentSuccessEnvelope<R>
  | DeviceAgentErrorEnvelope;

/**
 * Error type thrown by the Device Agent client when a request cannot be
 * delivered, the native bridge rejects, or the response envelope reports
 * `ok: false`. The {@link code} mirrors the Phase 2 contract code (see
 * `MainActivity.kt` validateDeviceAgentRequest / handleDeviceAgentRequest).
 * When Phase 2 attaches a {@link DeviceAgentError.subcode} to the envelope
 * `error` field, it is preserved here so callers can surface it in
 * diagnostics. {@link status} carries the runtime status snapshot Phase 2
 * sends alongside reject envelopes so the UI can update without a follow-up
 * status round-trip.
 */
export class DeviceAgentClientError extends Error {
  readonly code: string;
  readonly subcode?: string;
  readonly status?: DeviceAgentStatus;
  constructor(code: string, message: string, status?: DeviceAgentStatus, subcode?: string) {
    super(message);
    this.name = 'DeviceAgentClientError';
    this.code = code;
    if (status) this.status = status;
    if (subcode) this.subcode = subcode;
  }
}

// Phase 2 contract constants. Values must match
// apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt (lines 729-751).
export const DEVICE_AGENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
export const DEVICE_AGENT_MAX_SECURE_VALUE_CHARS = 8192;
export const DEVICE_AGENT_MAX_PAYLOAD_CHARS = 2_000_000;

interface DeviceAgentBridgeApi {
  deviceAgentRequest?: (requestId: string, method: string, payloadJson: string) => void;
  isDebugBuild?: () => boolean;
}

interface DeviceAgentCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, payload: unknown): void;
}

interface PendingRequest {
  method: DeviceAgentMethod;
  resolve(envelope: DeviceAgentResponseEnvelope): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

const DEVICE_AGENT_BRIDGE_KEY = '__agenticAndroidDeviceAgentBridge';
const DEFAULT_TIMEOUT_MS = 120_000;

const pending = new Map<string, PendingRequest>();
let nonce = 1;

// Install the JS callback bridge eagerly so Android dispatches that arrive
// before the first JS-initiated request still resolve through the same handler.
installCallbackBridge();

/**
 * Returns true when the Android JS bridge has installed
 * `AgenticAndroid.deviceAgentRequest` — i.e. the running app is the enabled
 * device-agent Android build defined in
 * `apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt`
 * (AndroidBridge.deviceAgentRequest). Browser dev and Render-gated runtimes
 * return false.
 */
export function isDeviceAgentBridgeAvailable(): boolean {
  return typeof getBridge()?.deviceAgentRequest === 'function';
}

export interface DeviceAgentRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Issues a Device Agent request over the Android JS bridge and resolves with
 * the parsed response envelope. Returns `{ ok: false, status, error }` for
 * native-reported failures (callers can inspect both fields), but **throws**
 * a {@link DeviceAgentClientError} when the bridge is missing, the payload
 * exceeds the per-method size cap (see {@link DEVICE_AGENT_MAX_PAYLOAD_CHARS}
 * / {@link DEVICE_AGENT_MAX_SECURE_VALUE_CHARS}), the request times out, the
 * caller's AbortSignal fires, or the JS bridge can't deliver the call.
 * Concurrent calls are safe — each gets a unique request id matching
 * {@link DEVICE_AGENT_REQUEST_ID_PATTERN}.
 */
export async function deviceAgentRequest<R = unknown>(
  method: DeviceAgentMethod,
  payload: unknown = {},
  options: DeviceAgentRequestOptions = {},
): Promise<DeviceAgentResponseEnvelope<R>> {
  if (options.signal?.aborted) {
    throw new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
  }
  const bridge = getBridge();
  if (!bridge?.deviceAgentRequest) {
    throw new DeviceAgentClientError(
      'bridge_unavailable',
      'Device Agent native bridge is not available in this runtime.',
    );
  }

  // BYOK enrichment: review/ask/generatePlan calls go to the user's own LLM via
  // the native bridge, bypassing the cloud's aiPlanner. Pre-fetch the policy
  // bundle from /api/policy/enrich so the on-device LLM sees the same provider-
  // resolved evidence (jupiter / coingecko / birdeye / helius / alternative_me /
  // web). Silent degradation on failure — request still goes through with raw
  // payload, the LLM falls back to un-enriched reasoning.
  let appliedBundle: PolicyBundle | null = null;
  if (shouldEnrichPolicyBundle(method, payload)) {
    appliedBundle = await fetchPolicyBundle(
      extractEnrichPayload(method, payload),
      { signal: options.signal },
    );
    if (appliedBundle) {
      payload = spliceBundle(payload, appliedBundle);
    }
  }

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload ?? {});
  } catch (err) {
    throw new DeviceAgentClientError(
      'invalid_payload',
      err instanceof Error ? err.message : String(err),
    );
  }
  const limit = payloadCharLimit(method);
  if (payloadJson.length > limit) {
    const message = `Device Agent ${method} payload exceeds ${limit} characters (${payloadJson.length}).`;
    logDeviceAgent(
      'request',
      'FAIL',
      {
        method,
        code: 'payload_too_large',
        message,
        payloadChars: payloadJson.length,
        limit,
      },
      'warn',
    );
    throw new DeviceAgentClientError('payload_too_large', message);
  }
  const requestId = generateRequestId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  logDeviceAgent('request', 'START', {
    method,
    requestId,
    payloadChars: payloadJson.length,
    payload: payloadPreview(method, payload),
  });
  return new Promise<DeviceAgentResponseEnvelope<R>>((resolve, reject) => {
    const entry: PendingRequest = {
      method,
      resolve: (envelope) => {
        if (envelope.ok) {
          // Mirror cloud-side applyServerSideReviewSafety: if the policy bundle
          // had blocking failures and the LLM still returned approve, force-deny.
          // This is the BYOK device-agent equivalent of the cloud's safety net.
          if (
            appliedBundle &&
            envelope.result &&
            typeof envelope.result === 'object' &&
            method === 'reviewPlan'
          ) {
            envelope = {
              ...envelope,
              result: enforceBlockingFailure(envelope.result as Record<string, unknown>, appliedBundle),
            };
          }
          logDeviceAgent('request', 'SUCCESS', {
            method,
            requestId,
            statusState: envelope.status.state,
            hasResult: envelope.result !== undefined,
          });
        } else {
          logDeviceAgent('request', 'FAIL', {
            method,
            requestId,
            code: envelope.error.code,
            message: envelope.error.message,
            statusState: envelope.status.state,
          }, 'warn');
        }
        resolve(envelope as DeviceAgentResponseEnvelope<R>);
      },
      reject: (err) => {
        const code = err instanceof DeviceAgentClientError ? err.code : 'bridge_error';
        logDeviceAgent('request', 'FAIL', { method, requestId, code, message: err.message }, 'warn');
        reject(err);
      },
      timer: setTimeout(() => {
        finalize(requestId);
        const err = new DeviceAgentClientError('request_timeout', `Device Agent ${method} request timed out.`);
        logDeviceAgent('request', 'FAIL', { method, requestId, code: err.code, message: err.message }, 'warn');
        reject(err);
      }, timeoutMs),
    };
    if (options.signal) {
      entry.signal = options.signal;
      entry.onAbort = () => {
        finalize(requestId);
        const err = new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
        logDeviceAgent('request', 'FAIL', { method, requestId, code: err.code, message: err.message }, 'warn');
        reject(err);
      };
      options.signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    pending.set(requestId, entry);
    try {
      bridge.deviceAgentRequest!(requestId, method, payloadJson);
    } catch (err) {
      finalize(requestId);
      const wrapped = new DeviceAgentClientError(
        'bridge_error',
        err instanceof Error ? err.message : String(err),
      );
      logDeviceAgent('request', 'FAIL', { method, requestId, code: wrapped.code, message: wrapped.message }, 'warn');
      reject(wrapped);
    }
  });
}

/**
 * Like {@link deviceAgentRequest} but unwraps the envelope: on success returns
 * `{ status, result? }`; on failure envelopes throws a
 * {@link DeviceAgentClientError} carrying the native code, message, parsed
 * status, and the optional `subcode` (e.g. `provider_invalid_response` →
 * `json_parse`).
 */
export async function deviceAgentRequestOrThrow<R = unknown>(
  method: DeviceAgentMethod,
  payload: unknown = {},
  options: DeviceAgentRequestOptions = {},
): Promise<{ status: DeviceAgentStatus; result?: R }> {
  const envelope = await deviceAgentRequest<R>(method, payload, options);
  if (envelope.ok === false) {
    throw new DeviceAgentClientError(
      envelope.error.code,
      envelope.error.message,
      envelope.status,
      envelope.error.subcode,
    );
  }
  return { status: envelope.status, result: envelope.result };
}

/**
 * Parses an arbitrary value into a normalized {@link DeviceAgentResponseEnvelope}.
 * Accepts both already-parsed objects and JSON strings. When `ok: false`,
 * preserves `error.subcode` if present. When the status field lacks a
 * `runtime`, falls back to `defaultRuntime` (or `'browser-dev'`). Throws
 * {@link DeviceAgentClientError}(`invalid_response`) on non-object payloads.
 */
export function parseDeviceAgentResponseEnvelope<R = unknown>(
  payload: unknown,
  defaultRuntime?: DeviceAgentRuntimeKind,
): DeviceAgentResponseEnvelope<R> {
  const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  if (!isRecord(parsed)) {
    throw new DeviceAgentClientError('invalid_response', 'Device Agent returned an invalid response payload.');
  }
  if (parsed.ok !== true && parsed.ok !== false) {
    throw new DeviceAgentClientError('invalid_response', 'Device Agent response envelope is missing ok.');
  }
  const status = parseDeviceAgentStatus(parsed.status, defaultRuntime);
  if (parsed.ok === false) {
    const error = isRecord(parsed.error) ? parsed.error : {};
    const code = typeof error.code === 'string' && error.code.trim() ? error.code.trim() : 'unknown_error';
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : 'Device Agent reported an unspecified error.';
    return {
      ok: false,
      status,
      error: {
        code,
        message,
        ...(stringField(error.subcode) && { subcode: stringField(error.subcode)! }),
      },
    };
  }
  return {
    ok: true,
    status,
    ...(parsed.result !== undefined ? { result: parsed.result as R } : {}),
  };
}

/**
 * Normalizes a payload (object or JSON string) into a {@link DeviceAgentStatus}.
 * Optional `defaultRuntime` is used when the payload lacks a valid `runtime`
 * field — main.ts passes the active surface (Android / Render / browser-dev).
 * Optional `lastError` (also `null` for an explicit clear) and `subcode` are
 * preserved when present. Non-object input returns an "unavailable" status.
 */
export function parseDeviceAgentStatus(
  payload: unknown,
  defaultRuntime?: DeviceAgentRuntimeKind,
): DeviceAgentStatus {
  const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  if (!isRecord(parsed)) {
    return unavailableStatus('Device Agent returned an invalid status payload.', defaultRuntime);
  }
  const runtimeRaw = parsed.runtime;
  const runtime: DeviceAgentRuntimeKind = isRuntimeKind(runtimeRaw)
    ? runtimeRaw
    : defaultRuntime ?? 'browser-dev';
  const stateRaw = parsed.state;
  const state: DeviceAgentRuntimeState = isRuntimeState(stateRaw)
    ? stateRaw
    : parsed.available === true ? 'stopped' : 'unavailable';
  const apiFormat = parsed.apiFormat === 'anthropic'
    ? 'anthropic'
    : parsed.apiFormat === 'openai-compatible' || parsed.apiFormat === 'openai'
      ? 'openai-compatible'
      : undefined;
  const updatedAt = stringField(parsed.updatedAt) ?? stringField(parsed.lastTransitionAt);
  return {
    available: parsed.available === true,
    enabled: parsed.enabled === true,
    configured: parsed.configured === true,
    state,
    runtime,
    ...(stringField(parsed.provider) && { provider: stringField(parsed.provider)! }),
    ...(apiFormat && { apiFormat }),
    ...(stringField(parsed.baseUrl) && { baseUrl: stringField(parsed.baseUrl)! }),
    ...(stringField(parsed.model) && { model: stringField(parsed.model)! }),
    ...(stringField(parsed.walletAddress) && { walletAddress: stringField(parsed.walletAddress)! }),
    ...(stringField(parsed.message) && { message: stringField(parsed.message)! }),
    ...(stringField(parsed.checkedAt) && { checkedAt: stringField(parsed.checkedAt)! }),
    ...(updatedAt && { updatedAt }),
    ...parseOptionalLastError(parsed.lastError),
  };
}

// === Diagnostic integration ============================================
//
// Map Device Agent error codes onto the existing AiDiagnosticCode taxonomy
// used by hosted/session/bridge paths. main.ts wraps DeviceAgentClientError
// in an AiPlanConnectionError that carries these entries; the standard
// `aiDiagnosticsFromError` flow then surfaces them through the same UI.

/**
 * Maps a Device Agent error code (from {@link DeviceAgentClientError.code} or
 * a Phase 2 reject envelope's `error.code`) onto the existing
 * {@link AiDiagnosticCode} taxonomy that the AI diagnostics panel and toast
 * helpers consume. Contract-violation codes (`bridge_unavailable`,
 * `INVALID_REQUEST`, `UNSUPPORTED_METHOD`, `device_agent_unavailable`,
 * `agent_not_implemented`) collapse to `AI_ROUTE_MISMATCH`; transport / quota
 * codes collapse to `AI_HTTP`; everything else is reported as
 * `AI_PROVIDER_ERROR`. Update this map when Phase 2/3 introduce new codes —
 * see `apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt`
 * (validateDeviceAgentRequest + handleDeviceAgentRequest).
 */
export function deviceAgentDiagnosticCode(code: string): AiDiagnosticCode {
  if (
    code === 'bridge_unavailable'
    || code === 'agent_not_implemented'
    || code === 'device_agent_unavailable'
    || code === 'INVALID_REQUEST'
    || code === 'UNSUPPORTED_METHOD'
    || code === 'unsupported_method'
  ) return 'AI_ROUTE_MISMATCH';
  if (
    code === 'request_timeout'
    || code === 'provider_timeout'
    || code === 'provider_rate_limited'
  ) return 'AI_HTTP';
  return 'AI_PROVIDER_ERROR';
}

export interface DeviceAgentDiagnosticContext {
  action: string;
  provider?: string;
  model?: string;
}

/**
 * Builds the {@link AiDiagnosticEntry} array that main.ts wraps in an
 * `AiPlanConnectionError` so device-agent failures flow through the standard
 * `aiDiagnosticsFromError` → `applyAiErrorDiagnostics` UI pipeline. Always
 * returns a leading `AI_ROUTE` entry (so the toast-title helper recognizes
 * the device-agent path) followed by a typed error entry. When the input is a
 * {@link DeviceAgentClientError} with a `subcode`, both message and detail
 * include `subcode=…`.
 */
export function deviceAgentDiagnosticsFromError(
  err: unknown,
  context: DeviceAgentDiagnosticContext,
): AiDiagnosticEntry[] {
  const path = `/api/device-agent/${context.action}`;
  const providerLabel = context.provider?.trim() || '';
  const modelLabel = context.model?.trim() || 'model configured';
  const detailParts = [providerLabel, modelLabel].filter(Boolean).join(' ');
  const routeEntry: AiDiagnosticEntry = {
    code: 'AI_ROUTE',
    message: 'Device Agent route selected.',
    detail: detailParts,
    method: 'POST',
    path,
  };
  if (!(err instanceof DeviceAgentClientError)) {
    return [
      routeEntry,
      {
        code: 'AI_PROVIDER_ERROR',
        message: err instanceof Error ? err.message : String(err),
        detail: detailParts,
        method: 'POST',
        path,
      },
    ];
  }
  const codeLabel = err.subcode ? `${err.code}:${err.subcode}` : err.code;
  const detailPieces = [err.message];
  if (err.subcode) detailPieces.push(`subcode=${err.subcode}`);
  if (detailParts) detailPieces.push(detailParts);
  return [
    routeEntry,
    {
      code: deviceAgentDiagnosticCode(err.code),
      message: `Device Agent ${context.action} failed (${codeLabel}).`,
      detail: detailPieces.join(' · '),
      method: 'POST',
      path,
    },
  ];
}

// === Telemetry =========================================================

type LogLevel = 'info' | 'warn';

/**
 * True when the Android bridge advertises a debug build (mirrors
 * `androidNative.ts` :: `androidNativeDebugEnabled`). Telemetry is gated by
 * this — production builds emit no Device Agent log lines.
 */
export function deviceAgentDebugEnabled(): boolean {
  try {
    return getBridge()?.isDebugBuild?.() === true;
  } catch {
    return false;
  }
}

/**
 * Emits a structured `[AgentDeviceAgent] {operation} | {phase}` log line on
 * the appropriate console method when {@link deviceAgentDebugEnabled} is true.
 * No-op in production builds. Fields are rendered as `key=value` pairs;
 * undefined / null / empty-string fields are dropped. Callers must redact
 * provider key material before passing it in (see `redactSensitivePayload`).
 */
export function logDeviceAgent(
  operation: string,
  phase: string,
  fields: Record<string, unknown>,
  level: LogLevel = 'info',
): void {
  if (!deviceAgentDebugEnabled()) return;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${stringifyLogValue(value)}`);
  const detail = parts.length ? ` ${parts.join(' ')}` : '';
  const line = `[AgentDeviceAgent] ${operation} | ${phase}${detail}`;
  if (level === 'warn') console.warn(line);
  else console.info(line);
}

export function __resetDeviceAgentClientForTests(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }
  pending.clear();
  nonce = 1;
  const win = globalThis as typeof globalThis & { [DEVICE_AGENT_BRIDGE_KEY]?: DeviceAgentCallbackBridge };
  delete win[DEVICE_AGENT_BRIDGE_KEY];
  installCallbackBridge();
}

// === Internals ==========================================================

function finalize(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort);
  }
  pending.delete(requestId);
}

function installCallbackBridge(): void {
  const win = globalThis as typeof globalThis & { [DEVICE_AGENT_BRIDGE_KEY]?: DeviceAgentCallbackBridge };
  if (win[DEVICE_AGENT_BRIDGE_KEY]) return;
  win[DEVICE_AGENT_BRIDGE_KEY] = {
    resolve(requestId, payload) {
      const entry = pending.get(requestId);
      if (!entry) return;
      finalize(requestId);
      try {
        const envelope = parseDeviceAgentResponseEnvelope(payload);
        entry.resolve(envelope);
      } catch (err) {
        entry.reject(err instanceof Error
          ? err
          : new DeviceAgentClientError('invalid_response', String(err)));
      }
    },
    reject(requestId, payload) {
      const entry = pending.get(requestId);
      if (!entry) return;
      finalize(requestId);
      const { code, message, status, subcode } = extractRejectFields(payload);
      entry.reject(new DeviceAgentClientError(code, message, status, subcode));
    },
  };
}

function extractRejectFields(payload: unknown): {
  code: string;
  message: string;
  status?: DeviceAgentStatus;
  subcode?: string;
} {
  // Phase 2 dispatches the full failure envelope { ok: false, status, error: { code, message } }.
  // Older shims may still pass either a bare { code, message } object or a nested { error }.
  try {
    const envelope = parseDeviceAgentResponseEnvelope(payload);
    if (envelope.ok === false) {
      return {
        code: envelope.error.code,
        message: envelope.error.message,
        status: envelope.status,
        ...(envelope.error.subcode && { subcode: envelope.error.subcode }),
      };
    }
    // Envelope parsed as success but reject was called — treat as bridge_error.
    return {
      code: 'bridge_error',
      message: 'Device Agent bridge rejected the request despite an ok envelope.',
      status: envelope.status,
    };
  } catch {
    // Fallback paths: bare { code, message } or nested { error: { code, message } }.
    const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
    if (isRecord(parsed)) {
      const nested = isRecord(parsed.error) ? parsed.error : null;
      const codeRaw = nested?.code ?? parsed.code;
      const messageRaw = nested?.message ?? parsed.message;
      const subcodeRaw = nested?.subcode ?? parsed.subcode;
      const code = typeof codeRaw === 'string' && codeRaw.trim() ? codeRaw.trim() : 'bridge_error';
      const message = typeof messageRaw === 'string' && messageRaw.trim()
        ? messageRaw.trim()
        : 'Device Agent bridge rejected the request.';
      const subcode = typeof subcodeRaw === 'string' && subcodeRaw.trim()
        ? subcodeRaw.trim()
        : undefined;
      return { code, message, ...(subcode && { subcode }) };
    }
    return {
      code: 'bridge_error',
      message: 'Device Agent bridge rejected the request.',
    };
  }
}

function getBridge(): DeviceAgentBridgeApi | undefined {
  return (globalThis as typeof globalThis & { AgenticAndroid?: DeviceAgentBridgeApi }).AgenticAndroid;
}

function generateRequestId(): string {
  const id = `device-agent-${Date.now().toString(36)}-${nonce.toString(36)}`;
  nonce += 1;
  if (!DEVICE_AGENT_REQUEST_ID_PATTERN.test(id)) {
    // Should be unreachable given the alphabet, but guarantees Phase 2 validation never rejects us.
    throw new DeviceAgentClientError(
      'invalid_request_id',
      `Generated Device Agent request id "${id}" does not match the contract pattern.`,
    );
  }
  return id;
}

function payloadCharLimit(method: DeviceAgentMethod): number {
  if (method === 'configure' || method === 'start') {
    return DEVICE_AGENT_MAX_SECURE_VALUE_CHARS;
  }
  return DEVICE_AGENT_MAX_PAYLOAD_CHARS;
}

/**
 * Only LLM-bound methods get policy enrichment — status/configure/start/stop are
 * orchestration calls that don't need facts. Skips enrichment if the payload
 * already carries a policyBundle (caller pre-built one).
 */
function shouldEnrichPolicyBundle(method: DeviceAgentMethod, payload: unknown): boolean {
  if (method !== 'reviewPlan' && method !== 'ask' && method !== 'generatePlan') return false;
  if (!payload || typeof payload !== 'object') return true;
  const ctx = (payload as { context?: unknown }).context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    if ((ctx as { policyBundle?: unknown }).policyBundle) return false;
  }
  return true;
}

/**
 * Extract the fields the enrich endpoint cares about from the device-agent
 * payload. Different methods carry the instruction text in different shapes
 * (reviewPlan: `instruction`, ask: `question`, generatePlan: `userPrompt`).
 */
function extractEnrichPayload(method: DeviceAgentMethod, payload: unknown): Record<string, unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const plan = (p.plan && typeof p.plan === 'object' ? p.plan : {}) as Record<string, unknown>;
  const ctx = (p.context && typeof p.context === 'object' ? p.context : {}) as Record<string, unknown>;
  let instruction = '';
  if (method === 'reviewPlan') {
    instruction = (typeof p.instruction === 'string' ? p.instruction : '');
  } else if (method === 'ask') {
    instruction = (typeof p.question === 'string' ? p.question : '') || (typeof p.instruction === 'string' ? p.instruction : '');
  } else if (method === 'generatePlan') {
    instruction = (typeof p.userPrompt === 'string' ? p.userPrompt : '') || (typeof p.prompt === 'string' ? p.prompt : '');
  }
  return {
    instruction,
    userNotes: typeof plan.userNotes === 'string' ? plan.userNotes : undefined,
    intent: typeof plan.intent === 'string' ? plan.intent : undefined,
    walletAddress: typeof p.walletAddress === 'string' ? p.walletAddress : undefined,
    draftParameters: plan.parameters && typeof plan.parameters === 'object' && !Array.isArray(plan.parameters)
      ? plan.parameters as Record<string, string>
      : undefined,
    transactionBase64: typeof ctx.transactionBase64 === 'string' ? ctx.transactionBase64 : undefined,
    actionType: typeof plan.actionType === 'string' ? plan.actionType : undefined,
    knownTokenSymbols: Array.isArray(p.knownTokenSymbols)
      ? (p.knownTokenSymbols as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  };
}

function payloadPreview(method: DeviceAgentMethod, payload: unknown): string | undefined {
  if (!deviceAgentDebugEnabled()) return undefined;
  const redacted = redactSensitivePayload(method, payload);
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return '[unserializable]';
  }
  return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized;
}

function redactSensitivePayload(method: DeviceAgentMethod, payload: unknown): unknown {
  if (method !== 'configure' && method !== 'start') return payload;
  if (!isRecord(payload)) return payload;
  const copy: Record<string, unknown> = { ...payload };
  if ('apiKey' in copy) {
    copy.apiKey = '[redacted]';
  }
  return copy;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuntimeKind(value: unknown): value is DeviceAgentRuntimeKind {
  return (
    value === 'android-native'
    || value === 'tauri-native'
    || value === 'render-gated'
    || value === 'browser-dev'
    || value === 'browser-native'
  );
}

function isRuntimeState(value: unknown): value is DeviceAgentRuntimeState {
  return value === 'unavailable'
    || value === 'stopped'
    || value === 'starting'
    || value === 'running'
    || value === 'error';
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalLastError(value: unknown): { lastError?: DeviceAgentError | null } {
  if (value === undefined) return {};
  if (value === null) return { lastError: null };
  if (!isRecord(value)) return {};
  const code = stringField(value.code);
  const message = stringField(value.message);
  if (!code || !message) return {};
  return {
    lastError: {
      code,
      message,
      ...(stringField(value.subcode) && { subcode: stringField(value.subcode)! }),
    },
  };
}

function stringifyLogValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function unavailableStatus(message: string, defaultRuntime?: DeviceAgentRuntimeKind): DeviceAgentStatus {
  return {
    available: false,
    enabled: false,
    configured: false,
    state: 'unavailable',
    runtime: defaultRuntime ?? 'browser-dev',
    message,
  };
}

/**
 * Returns true when the browser-native Device Agent runtime is compiled into
 * this bundle (gated by `VITE_AGENTIC_BROWSER_DEVICE_AGENT`). Symmetric to
 * {@link isDeviceAgentBridgeAvailable} for the Android JS bridge: a pure sync
 * check on the build flag. Phase 6 in main.ts additionally combines this with
 * `!IS_ANDROID_APP` and `isBrowserNativeRuntimeEligible(...)` from devGate.
 */
export function isBrowserNativeRuntimeAvailable(): boolean {
  return BROWSER_DEVICE_AGENT_ENABLED;
}

/**
 * Routes a Device Agent request through the on-tab browser-native runtime.
 * Mirrors {@link deviceAgentRequestOrThrow} for symmetry, but bypasses the
 * Android JS bridge and runs entirely in the current tab. The dispatcher module
 * is loaded lazily so the Android-only chunk does not pull in the runtime/
 * storage/provider/prompts tree.
 *
 * Throws {@link DeviceAgentClientError} on validation failures, storage errors,
 * provider failures, or aborts (same contract as the Android path).
 */
export async function browserNativeDeviceAgentRequestOrThrow<R = unknown>(
  method: DeviceAgentMethod,
  payload?: unknown,
  options?: DeviceAgentRequestOptions,
): Promise<{ status: DeviceAgentStatus; result?: R }> {
  const mod = await import('./deviceAgent/index.js');
  const dispatchOptions = options?.signal ? { signal: options.signal } : undefined;
  return mod.browserDeviceAgentRequest<R>(
    method,
    (payload ?? undefined) as Record<string, unknown> | undefined,
    dispatchOptions,
  );
}
