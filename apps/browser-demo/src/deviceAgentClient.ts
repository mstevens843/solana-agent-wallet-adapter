// Device Agent async client.
//
// Mirrors the shared Device Agent contract for the gated on-device runtime so
// the browser shell can route generation through the Android JS bridge while
// staying scaffold-only on Render and browser-dev.

import { BROWSER_DEVICE_AGENT_ENABLED } from './devGate.js';
import {
  finalizeDeviceAgentPolicyResult,
  prepareDeviceAgentPolicyPayload,
} from './deviceAgentPolicyMiddleware.js';
import type { AiDiagnosticCode, AiDiagnosticEntry } from './planner.js';

export type DeviceAgentRuntimeState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'error';
export type DeviceAgentRuntimeKind =
  | 'android-native'
  | 'ios-native'
  | 'tauri-native'
  | 'render-gated'
  | 'browser-dev'
  | 'browser-native';
export type DeviceAgentApiFormat = 'openai-compatible' | 'anthropic';
export type DeviceAgentMethod =
  | 'status'
  | 'configure'
  | 'start'
  | 'stop'
  | 'generatePlan'
  | 'reviewPlan'
  | 'ask'
  | 'localize'
  // Native Plan-Connector chat: the paired-bridge runtime forwards this to the
  // desktop's non-streaming /bridge/ai/chat. (On-device/browser runtimes reject
  // it via the dispatcher default — chat is paired-connector only.)
  | 'chat'
  // On-device chat completion: one keyed model call per agentic-loop turn. The
  // loop runs in JS; native runs the provider call so the key stays native. Added
  // for the real on-device chat agent (native impl ships in a new APK/IPA).
  | 'complete'
  // Streaming variant of 'complete': native relays raw provider SSE chunks to JS via
  // the chunk channel; resolves with {httpStatus, body?} at the end. Gated on
  // capabilities.chatCompleteStream (native impl ships in a new APK/IPA).
  | 'completeStream'
  // Cancel the in-flight streaming request (JS Stop mid-stream) so the native request
  // doesn't run to completion/timeout. Best-effort; ships with completeStream.
  | 'cancelStream';

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
  // Optional runtime capability flags advertised by the native binary. `chatComplete`
  // = the keyed `complete` method (on-device chat loop); `chatCompleteGeneric` = the
  // generic url+headers fetch mode; `chatCompleteStream` = native token streaming.
  // Absent fields are treated as unsupported (older binaries default false).
  capabilities?: {
    chatComplete?: boolean;
    chatCompleteGeneric?: boolean;
    chatCompleteStream?: boolean;
    version?: string;
    supportedTransports?: string[];
  };
}

export function deviceAgentStatusReadyForDrafts(
  status: Pick<DeviceAgentStatus, 'available' | 'configured' | 'state' | 'runtime'> | null | undefined,
): boolean {
  if (!status?.available || !status.configured) return false;
  if (status.state === 'running') return true;
  return status.runtime === 'ios-native' && status.state === 'stopped';
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

interface IosDeviceAgentPlugin {
  deviceAgentRequest?: (payload: {
    requestId: string;
    method: DeviceAgentMethod;
    payloadJson: string;
    debugBaseUrl?: string;
  }) => Promise<unknown>;
  status?: () => Promise<unknown>;
  configure?: (payload?: Record<string, unknown>) => Promise<unknown>;
  start?: (payload?: Record<string, unknown>) => Promise<unknown>;
  stop?: () => Promise<unknown>;
  generatePlan?: (payload?: Record<string, unknown>) => Promise<unknown>;
  reviewPlan?: (payload?: Record<string, unknown>) => Promise<unknown>;
  ask?: (payload?: Record<string, unknown>) => Promise<unknown>;
  // Optional: present only once the native binary ships the localize verb. When absent the
  // dispatch falls through to unsupported_method and the caller uses the cloud fallback.
  localize?: (payload?: Record<string, unknown>) => Promise<unknown>;
}

interface DeviceAgentCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, payload: unknown): void;
  // Streaming chat (Android 'completeStream'): native pushes raw provider SSE chunks
  // here, then onStreamEnd; onStreamError on a mid-stream failure. Routed to the single
  // active chat-stream sink (chat is single-flight, so requestId matching is unneeded).
  onChunk?(requestId: string, chunk: unknown): void;
  onStreamEnd?(requestId: string): void;
  onStreamError?(requestId: string, message: unknown): void;
}

// The single active native chat-stream consumer (set by main.ts before a streaming
// turn). Decouples the native push channel (Android global / iOS Capacitor event)
// from the consumer so both platforms feed one sink.
export interface NativeChatStreamSink {
  onChunk(text: string): void;
  onEnd(): void;
  onError(message: string): void;
}
let activeNativeChatStreamSink: NativeChatStreamSink | null = null;
export function setNativeChatStreamSink(sink: NativeChatStreamSink | null): void {
  activeNativeChatStreamSink = sink;
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

export function isIosDeviceAgentBridgeAvailable(): boolean {
  const bridge = getIosBridge();
  if (typeof bridge?.deviceAgentRequest === 'function') return true;
  return Boolean(
    bridge?.status &&
      bridge.configure &&
      bridge.start &&
      bridge.stop &&
      bridge.generatePlan &&
      bridge.reviewPlan &&
      bridge.ask,
  );
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

  // BYOK enrichment: review/ask calls go to the user's own LLM via the native
  // bridge, bypassing the cloud's aiPlanner. The shared middleware pre-fetches
  // policyBundle evidence from /api/policy/enrich and silently degrades on
  // failure, matching cloud-side aiPlanner behavior.
  const policyPreparation = await prepareDeviceAgentPolicyPayload(method, payload, {
    signal: options.signal,
  });
  if (options.signal?.aborted) {
    throw new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
  }
  payload = policyPreparation.payload;

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
          if (policyPreparation.bundle && envelope.result !== undefined) {
            envelope = {
              ...envelope,
              result: finalizeDeviceAgentPolicyResult(method, envelope.result, policyPreparation.bundle),
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

export async function iosDeviceAgentRequestOrThrow<R = unknown>(
  method: DeviceAgentMethod,
  payload: unknown = {},
  options: DeviceAgentRequestOptions = {},
): Promise<{ status: DeviceAgentStatus; result?: R }> {
  if (options.signal?.aborted) {
    throw new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
  }
  const bridge = getIosBridge();
  if (!bridge) {
    throw new DeviceAgentClientError(
      'bridge_unavailable',
      'iOS Device Agent native bridge is not available in this runtime.',
    );
  }
  let effectivePayload = payload;
  const policyPreparation = await prepareDeviceAgentPolicyPayload(method, effectivePayload, {
    signal: options.signal,
  });
  if (options.signal?.aborted) {
    throw new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
  }
  effectivePayload = policyPreparation.payload;
  const requestId = generateRequestId();
  const debugBaseUrl = mobileDeviceAgentDebugBaseUrl();
  const payloadRecord: Record<string, unknown> = {
    ...(isRecord(effectivePayload) ? effectivePayload : {}),
    __agenticRequestId: requestId,
    ...(debugBaseUrl ? { __agenticDebugBaseUrl: debugBaseUrl } : {}),
  };
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payloadRecord);
  } catch (err) {
    throw new DeviceAgentClientError(
      'invalid_payload',
      err instanceof Error ? err.message : String(err),
    );
  }
  payloadRecord.__agenticPayloadChars = payloadJson.length;
  payloadJson = JSON.stringify(payloadRecord);
  const limit = payloadCharLimit(method);
  if (payloadJson.length > limit) {
    logDeviceAgent(
      'ios-request',
      'FAIL',
      {
        method,
        code: 'payload_too_large',
        payloadChars: payloadJson.length,
        limit,
      },
      'warn',
    );
    void emitMobileDeviceAgentDebug({
      method,
      step: 'payload_too_large',
      code: 'payload_too_large',
      payloadChars: payloadJson.length,
    });
    throw new DeviceAgentClientError(
      'payload_too_large',
      `Device Agent ${method} payload exceeds ${limit} characters (${payloadJson.length}).`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nativeResult: unknown;
  try {
    logDeviceAgent('ios-request', 'START', {
      method,
      requestId,
      payloadChars: payloadJson.length,
      payload: payloadPreview(method, payloadRecord),
    });
    void emitMobileDeviceAgentDebug({
      method,
      requestId,
      step: 'start',
      payloadChars: payloadJson.length,
    });
    nativeResult = await invokeIosDeviceAgentBridgeWithTimeout(
      bridge,
      method,
      payloadRecord,
      payloadJson,
      timeoutMs,
      options.signal,
      requestId,
    );
  } catch (err) {
    const wrapped = iosDeviceAgentErrorFromUnknown(err);
    logDeviceAgent('ios-request', 'FAIL', {
      method,
      requestId,
      code: wrapped.code,
      subcode: wrapped.subcode,
      message: wrapped.message,
    }, 'warn');
    void emitMobileDeviceAgentDebug({
      method,
      requestId,
      step: 'fail',
      code: wrapped.code,
      subcode: wrapped.subcode,
      message: wrapped.message,
    });
    throw wrapped;
  }
  if (options.signal?.aborted) {
    throw new DeviceAgentClientError('aborted', 'Device Agent request was aborted.');
  }
  if (isDeviceAgentResponseEnvelopeLike(nativeResult)) {
    const envelope = parseDeviceAgentResponseEnvelope<R>(nativeResult, 'ios-native');
    if (envelope.ok === false) {
      logDeviceAgent('ios-request', 'FAIL', {
        method,
        requestId,
        code: envelope.error.code,
        subcode: envelope.error.subcode,
        message: envelope.error.message,
        statusState: envelope.status.state,
      }, 'warn');
      void emitMobileDeviceAgentDebug({
        method,
        requestId,
        step: 'fail',
        code: envelope.error.code,
        subcode: envelope.error.subcode,
        message: envelope.error.message,
        statusState: envelope.status.state,
        configured: envelope.status.configured,
      });
      throw new DeviceAgentClientError(
        envelope.error.code,
        envelope.error.message,
        envelope.status,
        envelope.error.subcode,
      );
    }
    let result = envelope.result as unknown;
    result = finalizeDeviceAgentPolicyResult(method, result, policyPreparation.bundle);
    logDeviceAgent('ios-request', 'SUCCESS', {
      method,
      requestId,
      statusState: envelope.status.state,
      configured: envelope.status.configured,
      hasResult: result !== undefined,
    });
    void emitMobileDeviceAgentDebug({
      method,
      requestId,
      step: 'success',
      statusState: envelope.status.state,
      configured: envelope.status.configured,
    });
    return {
      status: envelope.status,
      ...(result !== undefined ? { result: result as R } : {}),
    };
  }
  if (method === 'status' || method === 'configure' || method === 'start' || method === 'stop') {
    const status = parseDeviceAgentStatus(nativeResult, 'ios-native');
    logDeviceAgent('ios-request', 'SUCCESS', {
      method,
      requestId,
      statusState: status.state,
      configured: status.configured,
    });
    void emitMobileDeviceAgentDebug({
      method,
      requestId,
      step: 'success',
      statusState: status.state,
      configured: status.configured,
    });
    return { status };
  }
  let result = normalizeIosDeviceAgentResult(nativeResult);
  result = finalizeDeviceAgentPolicyResult(method, result, policyPreparation.bundle);
  const statusPayload = await bridge.status?.().catch(() => undefined);
  const status = parseDeviceAgentStatus(statusPayload, 'ios-native');
  logDeviceAgent('ios-request', 'SUCCESS', {
    method,
    requestId,
    statusState: status.state,
    configured: status.configured,
    hasResult: result !== undefined,
  });
  void emitMobileDeviceAgentDebug({
    method,
    requestId,
    step: 'success',
    statusState: status.state,
    configured: status.configured,
  });
  return {
    status,
    result: result as R,
  };
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
  const updatedAt = timestampField(parsed.updatedAt) ?? timestampField(parsed.lastTransitionAt);
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
    ...(timestampField(parsed.checkedAt) && { checkedAt: timestampField(parsed.checkedAt)! }),
    ...(updatedAt && { updatedAt }),
    ...parseDeviceAgentCapabilities(parsed.capabilities),
    ...parseOptionalLastError(parsed.lastError),
  };
}

// Pass through the optional native capability flags so the JS chat loop can detect
// what the binary supports (chatComplete / chatCompleteGeneric / chatCompleteStream /
// version / supportedTransports) without guessing. Only emits a capabilities object
// when at least one meaningful flag is present.
function parseDeviceAgentCapabilities(value: unknown): { capabilities?: DeviceAgentStatus['capabilities'] } {
  if (!isRecord(value)) return {};
  const caps: NonNullable<DeviceAgentStatus['capabilities']> = {};
  if (value.chatComplete === true) caps.chatComplete = true;
  if (value.chatCompleteGeneric === true) caps.chatCompleteGeneric = true;
  if (value.chatCompleteStream === true) caps.chatCompleteStream = true;
  if (typeof value.version === 'string' && value.version.trim()) caps.version = value.version.trim();
  if (Array.isArray(value.supportedTransports)) {
    const transports = value.supportedTransports.filter((t): t is string => typeof t === 'string');
    if (transports.length > 0) caps.supportedTransports = transports;
  }
  return Object.keys(caps).length > 0 ? { capabilities: caps } : {};
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
    if (getIosBridge()) return true;
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
    onChunk(_requestId, chunk) {
      activeNativeChatStreamSink?.onChunk(typeof chunk === 'string' ? chunk : String(chunk ?? ''));
    },
    onStreamEnd() {
      activeNativeChatStreamSink?.onEnd();
    },
    onStreamError(_requestId, message) {
      activeNativeChatStreamSink?.onError(typeof message === 'string' ? message : String(message ?? 'stream error'));
    },
  };
}

// iOS pushes streaming chunks as a Capacitor plugin event ('agenticDeviceAgentChunk')
// rather than via a JS global. Register the listener once; it routes to the same sink.
let iosChatStreamListenerInstalled = false;
export function installIosChatStreamListener(): void {
  if (iosChatStreamListenerInstalled) return;
  const bridge = getIosBridge() as (IosDeviceAgentPlugin & { addListener?: (event: string, cb: (ev: Record<string, unknown>) => void) => unknown }) | undefined;
  if (!bridge || typeof bridge.addListener !== 'function') return;
  iosChatStreamListenerInstalled = true;
  bridge.addListener('agenticDeviceAgentChunk', (ev) => {
    if (!activeNativeChatStreamSink) return;
    if (ev.error !== undefined) activeNativeChatStreamSink.onError(String(ev.error ?? 'stream error'));
    else if (ev.end === true) activeNativeChatStreamSink.onEnd();
    else if (typeof ev.chunk === 'string') activeNativeChatStreamSink.onChunk(ev.chunk);
  });
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

function getIosBridge(): IosDeviceAgentPlugin | undefined {
  return (globalThis as typeof globalThis & { __agenticIosDeviceAgentBridge?: IosDeviceAgentPlugin })
    .__agenticIosDeviceAgentBridge;
}

async function invokeIosDeviceAgentBridge(
  bridge: IosDeviceAgentPlugin,
  method: DeviceAgentMethod,
  payload: Record<string, unknown>,
  payloadJson: string,
  requestId: string,
): Promise<unknown> {
  if (typeof bridge.deviceAgentRequest === 'function') {
    return bridge.deviceAgentRequest({
      requestId,
      method,
      payloadJson,
      ...(typeof payload.__agenticDebugBaseUrl === 'string' ? { debugBaseUrl: payload.__agenticDebugBaseUrl } : {}),
    });
  }
  switch (method) {
    case 'status':
      if (!bridge.status) break;
      return bridge.status();
    case 'configure':
      if (!bridge.configure) break;
      return bridge.configure(payload);
    case 'start':
      if (!bridge.start) break;
      return bridge.start(payload);
    case 'stop':
      if (!bridge.stop) break;
      return bridge.stop();
    case 'generatePlan':
      if (!bridge.generatePlan) break;
      return bridge.generatePlan(payload);
    case 'reviewPlan':
      if (!bridge.reviewPlan) break;
      return bridge.reviewPlan(payload);
    case 'ask':
      if (!bridge.ask) break;
      return bridge.ask(payload);
    case 'localize':
      if (!bridge.localize) break;
      return bridge.localize(payload);
  }
  throw new DeviceAgentClientError(
    'unsupported_method',
    `iOS Device Agent bridge does not implement ${method}.`,
  );
}

function invokeIosDeviceAgentBridgeWithTimeout(
  bridge: IosDeviceAgentPlugin,
  method: DeviceAgentMethod,
  payload: Record<string, unknown>,
  payloadJson: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  requestId: string,
): Promise<unknown> {
  if (signal?.aborted) {
    return Promise.reject(new DeviceAgentClientError('aborted', 'Device Agent request was aborted.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      fn();
    };
    timer = setTimeout(() => {
      finish(() => reject(new DeviceAgentClientError(
        'request_timeout',
        `iOS Device Agent ${method} request timed out.`,
      )));
    }, timeoutMs);
    if (signal) {
      abortHandler = () => {
        finish(() => reject(new DeviceAgentClientError('aborted', 'Device Agent request was aborted.')));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    invokeIosDeviceAgentBridge(bridge, method, payload, payloadJson, requestId).then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    ).catch((err) => {
      finish(() => reject(err));
    });
    if (!DEVICE_AGENT_REQUEST_ID_PATTERN.test(requestId)) {
      finish(() => reject(new DeviceAgentClientError(
        'invalid_request_id',
        `Generated Device Agent request id "${requestId}" does not match the contract pattern.`,
      )));
    }
  });
}

function isDeviceAgentResponseEnvelopeLike(payload: unknown): boolean {
  const parsed = typeof payload === 'string' ? safeJsonParse(payload) : payload;
  return isRecord(parsed) && (parsed.ok === true || parsed.ok === false);
}

function normalizeIosDeviceAgentResult(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (payload.output_text !== undefined || payload.choices !== undefined || payload.content !== undefined) return payload;
  const text = stringField(payload.text);
  if (!text) return payload;
  return {
    ...payload,
    output_text: text,
  };
}

function iosDeviceAgentErrorFromUnknown(err: unknown): DeviceAgentClientError {
  if (err instanceof DeviceAgentClientError) return err;
  const record = errorRecord(err);
  const code = stringField(record?.code) ?? 'bridge_error';
  const message =
    stringField(record?.message) ??
    stringField(record?.errorMessage) ??
    (err instanceof Error ? err.message : 'iOS Device Agent bridge request failed.');
  const subcode = stringField(record?.subcode);
  return new DeviceAgentClientError(code, message, undefined, subcode);
}

function errorRecord(err: unknown): Record<string, unknown> | undefined {
  if (isRecord(err)) return err;
  if (err instanceof Error && isRecord((err as Error & { data?: unknown }).data)) {
    return (err as Error & { data?: Record<string, unknown> }).data;
  }
  return undefined;
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

function payloadPreview(method: DeviceAgentMethod, payload: unknown): string | undefined {
  if (!deviceAgentDebugEnabled()) return undefined;
  const redacted = redactSensitivePayload(method, payload);
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return '[unserializable]';
  }
  return serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized;
}

function redactSensitivePayload(method: DeviceAgentMethod, payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const keys = Object.keys(payload).sort();
  const copy: Record<string, unknown> = { method };
  if (typeof payload.__agenticRequestId === 'string') copy.__agenticRequestId = payload.__agenticRequestId;
  if (typeof payload.__agenticPayloadChars === 'number') copy.__agenticPayloadChars = payload.__agenticPayloadChars;

  if (method === 'configure' || method === 'start') {
    for (const key of ['provider', 'apiFormat', 'model', 'baseUrl', 'walletAddress'] as const) {
      if (typeof payload[key] === 'string') copy[key] = payload[key];
    }
    if (typeof payload.clear === 'boolean') copy.clear = payload.clear;
    if ('apiKey' in payload) copy.apiKey = '[redacted]';
    copy.keys = keys;
    return copy;
  }

  copy.hasInstruction = typeof payload.instruction === 'string' && payload.instruction.length > 0;
  copy.hasQuestion = typeof payload.question === 'string' && payload.question.length > 0;
  copy.hasPrompt = (typeof payload.prompt === 'string' && payload.prompt.length > 0)
    || (typeof payload.userPrompt === 'string' && payload.userPrompt.length > 0);
  copy.hasPlan = isRecord(payload.plan);
  copy.hasContext = isRecord(payload.context);
  copy.hasResearch = isRecord(payload.research);
  if (typeof payload.walletAddress === 'string') copy.hasWalletAddress = payload.walletAddress.length > 0;
  if (isRecord(payload.plan) && typeof payload.plan.actionType === 'string') copy.actionType = payload.plan.actionType;
  if (isRecord(payload.context)) {
    copy.hasTransactionBase64 = typeof payload.context.transactionBase64 === 'string' && payload.context.transactionBase64.length > 0;
    copy.hasPolicyBundle = isRecord(payload.context.policyBundle);
    copy.hasResearchEvidence = isRecord(payload.context.researchEvidence);
  }
  if ('apiKey' in payload) copy.apiKey = '[redacted]';
  copy.keys = keys;
  return copy;
}

export interface MobileDeviceAgentDebugEvent {
  method: DeviceAgentMethod;
  requestId?: string;
  step: string;
  phase?: string;
  source?: string;
  code?: string;
  subcode?: string;
  message?: string;
  payloadChars?: number;
  statusState?: DeviceAgentRuntimeState;
  configured?: boolean;
  guardrailVerdict?: string;
  guardrailCodes?: string;
  repairApplied?: boolean;
}

export function mobileDeviceAgentDebugBreadcrumb(event: MobileDeviceAgentDebugEvent): void {
  void emitMobileDeviceAgentDebug(event);
}

async function emitMobileDeviceAgentDebug(event: MobileDeviceAgentDebugEvent): Promise<void> {
  if (!getIosBridge()) return;
  const baseUrl = mobileDeviceAgentDebugBaseUrl();
  if (!baseUrl) return;
  try {
    const endpoint = new URL('/api/mobile-device-agent-debug', baseUrl).toString();
    const payload: Record<string, string | number | boolean> = {
      method: event.method,
      step: event.step,
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.source ? { source: event.source } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.code ? { code: event.code } : {}),
      ...(event.subcode ? { subcode: event.subcode } : {}),
      ...(event.message ? { message: event.message.slice(0, 240) } : {}),
      ...(typeof event.payloadChars === 'number' ? { payloadChars: event.payloadChars } : {}),
      ...(event.statusState ? { statusState: event.statusState } : {}),
      ...(typeof event.configured === 'boolean' ? { configured: event.configured } : {}),
      ...(event.guardrailVerdict ? { guardrailVerdict: event.guardrailVerdict } : {}),
      ...(event.guardrailCodes ? { guardrailCodes: event.guardrailCodes } : {}),
      ...(typeof event.repairApplied === 'boolean' ? { repairApplied: event.repairApplied } : {}),
    };
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentic-client': 'ios-bundled',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // Debug telemetry must never affect the Device Agent request path.
  }
}

function mobileDeviceAgentDebugBaseUrl(): string | undefined {
  const locationLike = (globalThis as typeof globalThis & { location?: Location }).location;
  if (!locationLike && typeof window === 'undefined') return undefined;
  return locationLike?.origin?.startsWith('http')
    ? locationLike.origin
    : 'https://agentic-signer.com';
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
    || value === 'ios-native'
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

function timestampField(value: unknown): string | undefined {
  const text = stringField(value);
  if (text) return text;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const iso = new Date(millis).toISOString();
  return iso === 'Invalid Date' ? undefined : iso;
}

function parseOptionalLastError(value: unknown): { lastError?: DeviceAgentError | null } {
  if (value === undefined) return {};
  if (value === null) return { lastError: null };
  if (typeof value === 'string' && value.trim()) {
    return { lastError: { code: 'runtime_error', message: value.trim() } };
  }
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
