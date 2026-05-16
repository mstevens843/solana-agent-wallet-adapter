// Phase 0 scaffolding — typed wrappers for the new Android JS-bridge methods
// (mppRequest, streamingRequest). When running inside the TWA the bridge is
// available on `window.AgenticAndroid`; otherwise we fall back to render-web
// HTTP via the corresponding browser client.
//
// Phase 2D will replace the streaming-session fallback's body with real
// per-voucher device-agent signing; Phase 1 will replace the mpp fallback
// with the real /api/mpp/challenge round-trip.

import { MppApiError } from './mppClient.js';
import { StreamingApiError } from './streamingClient.js';

interface AgenticAndroidNative {
  mppRequest?: (requestId: string, method: string, payloadJson: string) => string;
  streamingRequest?: (requestId: string, method: string, payloadJson: string) => string;
}

interface ScaffoldedEnvelope {
  ok: boolean;
  status: string;
  phase?: string;
  bridge?: 'mpp' | 'streaming';
  requestId?: string;
  method?: string;
  code?: string;
  message?: string;
}

function getNative(): AgenticAndroidNative | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as unknown as { AgenticAndroid?: AgenticAndroidNative }).AgenticAndroid;
  return candidate;
}

function newRequestId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function parseEnvelope(raw: string): ScaffoldedEnvelope {
  try {
    const parsed = JSON.parse(raw) as ScaffoldedEnvelope;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  return { ok: false, status: 'error', code: 'parse_error', message: 'Native response was not JSON.' };
}

export function hasNativeAndroidBridge(): boolean {
  const native = getNative();
  return Boolean(native?.mppRequest || native?.streamingRequest);
}

export async function callMppBridge(method: string, payload: unknown): Promise<ScaffoldedEnvelope> {
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
): Promise<ScaffoldedEnvelope> {
  const native = getNative();
  if (!native?.streamingRequest) {
    throw new StreamingApiError(
      'not_implemented',
      'Native AgenticAndroid.streamingRequest is unavailable; Phase 2D will provide a cloud-relay fallback here.',
    );
  }
  const requestId = newRequestId('stream');
  const payloadJson = JSON.stringify(payload ?? {});
  const raw = native.streamingRequest(requestId, method, payloadJson);
  return parseEnvelope(raw);
}
