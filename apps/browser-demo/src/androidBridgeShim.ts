import { MppApiError } from './mppClient.js';
import {
  StreamingApiError,
  submitStreamingVoucher,
  type SubmitVoucherBody,
} from './streamingClient.js';

interface AgenticAndroidNative {
  mppRequest?: (requestId: string, method: string, payloadJson: string) => string;
  streamingRequest?: (requestId: string, method: string, payloadJson: string) => string | void;
}

interface StreamingCallbackBridge {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, payload: unknown): void;
}

interface BridgeEnvelope {
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
  const body = streamingSubmitBody(payload);
  const result = await submitStreamingVoucher(body.sessionId, body.submitBody);
  return {
    ok: true,
    status: 'server_relayed',
    bridge: 'streaming',
    requestId,
    method,
    result,
  };
}

function streamingSubmitBody(payload: unknown): { sessionId: string; submitBody: SubmitVoucherBody } {
  if (!isRecord(payload)) {
    throw new StreamingApiError('not_implemented', 'Streaming fallback payload must be an object.');
  }
  const sessionId = stringField(payload.sessionId);
  if (!sessionId) {
    throw new StreamingApiError('not_implemented', 'Streaming fallback requires sessionId.');
  }
  if (isRecord(payload.body)) {
    return { sessionId, submitBody: payload.body as unknown as SubmitVoucherBody };
  }
  if (isRecord(payload.voucher)) {
    return { sessionId, submitBody: { voucher: payload.voucher as SubmitVoucherBody['voucher'] } };
  }
  const voucherJson = stringField(payload.voucherJson);
  if (voucherJson) {
    try {
      return { sessionId, submitBody: { voucher: JSON.parse(voucherJson) as SubmitVoucherBody['voucher'] } };
    } catch (err) {
      throw new StreamingApiError(
        'not_implemented',
        err instanceof Error ? err.message : 'voucherJson could not be parsed.',
      );
    }
  }
  throw new StreamingApiError('not_implemented', 'Streaming fallback requires body, voucher, or voucherJson.');
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
