import { MppApiError } from './mppClient.js';
import {
  StreamingApiError,
  submitStreamingVoucherRelay,
  type RelayVoucherBody,
} from './streamingClient.js';

interface AgenticAndroidNative {
  mppRequest?: (requestId: string, method: string, payloadJson: string) => string;
  streamingRequest?: (requestId: string, method: string, payloadJson: string) => string | void;
}

interface AgenticIosStreamingNative {
  prepareSessionSigner?: (options?: { metadata?: Record<string, unknown> }) => Promise<unknown>;
  createSession?: (options: {
    sessionId: string;
    ephemeralPrivkeyBase64: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  bindPreparedSession?: (options: {
    sessionId: string;
    signerId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  activateSession?: (options: {
    sessionId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  signVoucher?: (options: { sessionId: string; voucherJson: string }) => Promise<unknown>;
  signSettlementTx?: (options: { sessionId: string; settlement: Record<string, unknown> }) => Promise<unknown>;
  revokeLocalSession?: (options: { sessionId: string }) => Promise<unknown>;
  statusJson?: () => Promise<unknown>;
  notificationState?: () => Promise<unknown>;
}

interface StreamingCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, payload: unknown): void;
}

export interface BridgeEnvelope {
  ok: boolean;
  status: string | Record<string, unknown>;
  phase?: string;
  bridge?: 'mpp' | 'streaming';
  requestId?: string;
  method?: string;
  code?: string;
  message?: string;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

interface PendingStreamingRequest {
  method: string;
  resolve(value: BridgeEnvelope): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const STREAMING_BRIDGE_KEY = '__agenticAndroidStreamingBridge';
const STREAMING_TIMEOUT_MS = 30_000;
const pendingStreaming = new Map<string, PendingStreamingRequest>();

function getNative(): AgenticAndroidNative | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as unknown as { AgenticAndroid?: AgenticAndroidNative }).AgenticAndroid;
  return candidate;
}

function getIosStreamingNative(): AgenticIosStreamingNative | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { __agenticIosStreamingBridge?: AgenticIosStreamingNative })
    .__agenticIosStreamingBridge;
}

function newRequestId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function parseEnvelope(raw: unknown): BridgeEnvelope {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') return parsed as BridgeEnvelope;
  } catch {
    // fall through
  }
  return { ok: false, status: 'error', code: 'parse_error', message: 'Native response was not JSON.' };
}

export function hasNativeAndroidBridge(): boolean {
  const native = getNative();
  return Boolean(native?.mppRequest || native?.streamingRequest);
}

export function hasNativeStreamingBridge(): boolean {
  return Boolean(getNative()?.streamingRequest || getIosStreamingNative()?.signVoucher);
}

export function nativeStreamingRuntime(): 'android-native' | 'ios-native' | null {
  if (getNative()?.streamingRequest) return 'android-native';
  if (getIosStreamingNative()?.signVoucher) return 'ios-native';
  return null;
}

export async function callMppBridge(method: string, payload: unknown): Promise<BridgeEnvelope> {
  const native = getNative();
  if (!native?.mppRequest) {
    throw new MppApiError(
      'not_implemented',
      'Native AgenticAndroid.mppRequest is unavailable; Phase 1 will provide a render-web HTTP fallback here.',
    );
  }
  const requestId = newRequestId('mpp');
  const payloadJson = JSON.stringify(payload ?? {});
  const raw = native.mppRequest(requestId, method, payloadJson);
  return parseEnvelope(raw);
}

export async function callStreamingBridge(
  method: string,
  payload: unknown,
): Promise<BridgeEnvelope> {
  const requestId = newRequestId('stream');
  const native = getNative();
  if (!native?.streamingRequest) {
    const iosNative = getIosStreamingNative();
    if (iosNative) {
      return callIosStreamingBridge(requestId, iosNative, method, payload);
    }
    return callStreamingFallback(requestId, method, payload);
  }
  installStreamingCallbackBridge();
  const payloadJson = JSON.stringify(payload ?? {});
  return new Promise<BridgeEnvelope>((resolve, reject) => {
    const entry: PendingStreamingRequest = {
      method,
      resolve,
      reject,
      timer: setTimeout(() => {
        pendingStreaming.delete(requestId);
        reject(new StreamingApiError('network_error', `Native streaming ${method} request timed out.`));
      }, STREAMING_TIMEOUT_MS),
    };
    pendingStreaming.set(requestId, entry);
    try {
      const maybeSync = native.streamingRequest!(requestId, method, payloadJson);
      if (typeof maybeSync === 'string') {
        finalizeStreamingRequest(requestId);
        resolve(parseEnvelope(maybeSync));
      }
    } catch (err) {
      finalizeStreamingRequest(requestId);
      reject(new StreamingApiError('network_error', err instanceof Error ? err.message : String(err)));
    }
  });
}

async function callIosStreamingBridge(
  requestId: string,
  native: AgenticIosStreamingNative,
  method: string,
  payload: unknown,
): Promise<BridgeEnvelope> {
  try {
    const result = await invokeIosStreamingBridge(native, method, payload);
    if (isRecord(result) && result.ok === false) {
      return {
        ok: false,
        status: 'error',
        bridge: 'streaming',
        requestId,
        method,
        code: stringField(result.code) || 'native_error',
        message: stringField(result.message) || stringField(result.error) || `Native streaming ${method} failed.`,
        error: {
          code: stringField(result.code) || 'native_error',
          message: stringField(result.message) || stringField(result.error) || `Native streaming ${method} failed.`,
        },
        result,
      };
    }
    return {
      ok: true,
      status: 'ios_native',
      bridge: 'streaming',
      requestId,
      method,
      result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'error',
      bridge: 'streaming',
      requestId,
      method,
      code: 'network_error',
      message,
      error: { code: 'network_error', message },
    };
  }
}

async function invokeIosStreamingBridge(
  native: AgenticIosStreamingNative,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const record = isRecord(payload) ? payload : {};
  switch (method) {
    case 'prepareSessionSigner':
      if (!native.prepareSessionSigner) break;
      return native.prepareSessionSigner({ metadata: metadataFromPayload(record) });
    case 'createSession': {
      const sessionId = stringField(record.sessionId);
      const signerId = stringField(record.signerId);
      if (sessionId && signerId && native.bindPreparedSession) {
        return native.bindPreparedSession({ sessionId, signerId, metadata: metadataFromPayload(record) });
      }
      const ephemeralPrivkeyBase64 = stringField(record.ephemeralPrivkeyBase64);
      if (sessionId && ephemeralPrivkeyBase64 && native.createSession) {
        return native.createSession({ sessionId, ephemeralPrivkeyBase64, metadata: metadataFromPayload(record) });
      }
      throw new StreamingApiError('not_implemented', 'iOS streaming createSession requires sessionId plus signerId or ephemeralPrivkeyBase64.');
    }
    case 'bindPreparedSession': {
      if (!native.bindPreparedSession) break;
      const sessionId = stringField(record.sessionId);
      const signerId = stringField(record.signerId);
      if (!sessionId || !signerId) {
        throw new StreamingApiError('not_implemented', 'iOS streaming bindPreparedSession requires sessionId and signerId.');
      }
      return native.bindPreparedSession({ sessionId, signerId, metadata: metadataFromPayload(record) });
    }
    case 'activateSession': {
      if (!native.activateSession) break;
      const sessionId = stringField(record.sessionId);
      if (!sessionId) throw new StreamingApiError('not_implemented', 'iOS streaming activateSession requires sessionId.');
      return native.activateSession({ sessionId, metadata: metadataFromPayload(record) });
    }
    case 'signVoucher': {
      if (!native.signVoucher) break;
      const sessionId = stringField(record.sessionId);
      const voucherJson = stringField(record.voucherJson) || voucherJsonFromPayload(record);
      if (!sessionId || !voucherJson) {
        throw new StreamingApiError('not_implemented', 'iOS streaming signVoucher requires sessionId and voucher.');
      }
      return native.signVoucher({ sessionId, voucherJson });
    }
    case 'signSettlementTx': {
      if (!native.signSettlementTx) break;
      const sessionId = stringField(record.sessionId);
      const settlement = isRecord(record.settlement) ? record.settlement : record;
      if (!sessionId) throw new StreamingApiError('not_implemented', 'iOS streaming signSettlementTx requires sessionId.');
      return native.signSettlementTx({ sessionId, settlement });
    }
    case 'revokeLocalSession': {
      if (!native.revokeLocalSession) break;
      const sessionId = stringField(record.sessionId);
      if (!sessionId) throw new StreamingApiError('not_implemented', 'iOS streaming revokeLocalSession requires sessionId.');
      return native.revokeLocalSession({ sessionId });
    }
    case 'statusJson':
      if (!native.statusJson) break;
      return native.statusJson();
    case 'notificationState':
      if (!native.notificationState) break;
      return native.notificationState();
  }
  throw new StreamingApiError('not_implemented', `iOS native streaming bridge does not implement ${method}.`);
}

function metadataFromPayload(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.metadata) ? record.metadata : record;
}

function voucherJsonFromPayload(record: Record<string, unknown>): string {
  const voucher = isRecord(record.voucher)
    ? record.voucher
    : isRecord(record.body)
      ? record.body
      : null;
  if (!voucher) return '';
  return JSON.stringify(voucher);
}

async function callStreamingFallback(
  requestId: string,
  method: string,
  payload: unknown,
): Promise<BridgeEnvelope> {
  if (method !== 'signVoucher') {
    throw new StreamingApiError(
      'not_implemented',
      `Native AgenticAndroid.streamingRequest is unavailable for ${method}.`,
    );
  }
  const body = streamingRelayBody(payload);
  const result = await submitStreamingVoucherRelay(body.sessionId, body.relayBody);
  return {
    ok: true,
    status: 'server_relayed',
    bridge: 'streaming',
    requestId,
    method,
    result,
  };
}

function streamingRelayBody(payload: unknown): { sessionId: string; relayBody: RelayVoucherBody } {
  if (!isRecord(payload)) {
    throw new StreamingApiError('not_implemented', 'Streaming fallback payload must be an object.');
  }
  const sessionId = stringField(payload.sessionId);
  if (!sessionId) {
    throw new StreamingApiError('not_implemented', 'Streaming fallback requires sessionId.');
  }
  if (isRecord(payload.body)) return { sessionId, relayBody: relayBodyFromRecord(payload.body) };
  if (isRecord(payload.voucher)) return { sessionId, relayBody: relayBodyFromRecord(payload.voucher) };
  const voucherJson = stringField(payload.voucherJson);
  if (voucherJson) {
    try {
      const voucher = JSON.parse(voucherJson) as unknown;
      if (!isRecord(voucher)) {
        throw new StreamingApiError('not_implemented', 'voucherJson must decode to an object.');
      }
      return { sessionId, relayBody: relayBodyFromRecord(voucher) };
    } catch (err) {
      if (err instanceof StreamingApiError) throw err;
      throw new StreamingApiError(
        'not_implemented',
        err instanceof Error ? err.message : 'voucherJson could not be parsed.',
      );
    }
  }
  throw new StreamingApiError('not_implemented', 'Streaming fallback requires body, voucher, or voucherJson.');
}

function relayBodyFromRecord(record: Record<string, unknown>): RelayVoucherBody {
  const amount = stringField(record.amount);
  const recipient = stringField(record.recipient);
  if (!amount || !recipient) {
    throw new StreamingApiError('not_implemented', 'Streaming fallback requires amount and recipient.');
  }
  return {
    amount,
    recipient,
    ...(stringField(record.nonce) ? { nonce: stringField(record.nonce) } : {}),
    ...(stringField(record.issuedAt) ? { issuedAt: stringField(record.issuedAt) } : {}),
  };
}

function installStreamingCallbackBridge(): void {
  if (typeof window === 'undefined') return;
  const globalWindow = window as Window & { __agenticAndroidStreamingBridge?: StreamingCallbackBridge };
  if (globalWindow.__agenticAndroidStreamingBridge) return;
  globalWindow.__agenticAndroidStreamingBridge = {
    resolve(requestId, payload) {
      const pending = pendingStreaming.get(requestId);
      if (!pending) return;
      finalizeStreamingRequest(requestId);
      pending.resolve(parseEnvelope(payload));
    },
    reject(requestId, payload) {
      const pending = pendingStreaming.get(requestId);
      if (!pending) return;
      finalizeStreamingRequest(requestId);
      const parsed = parseEnvelope(payload);
      const code = parsed.error?.code ?? parsed.code ?? 'network_error';
      const message = parsed.error?.message ?? parsed.message ?? `Native streaming ${pending.method} request failed.`;
      pending.reject(new StreamingApiError(code === 'http_error' ? 'http_error' : 'network_error', message));
    },
  };
}

function finalizeStreamingRequest(requestId: string): void {
  const pending = pendingStreaming.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingStreaming.delete(requestId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
