export type MppApiErrorCode = 'not_implemented' | 'network_error' | 'http_error' | 'invalid_response';

export class MppApiError extends Error {
  constructor(readonly code: MppApiErrorCode, message: string, readonly status?: number, readonly payload?: unknown) {
    super(message);
    this.name = 'MppApiError';
  }
}

export interface MppChallengeRequestBody {
  challenge: unknown;
  cluster?: string;
  agentLabel?: string;
}

export interface MppChallengeResponse {
  approvalId: string;
  requestId: string;
  expiresAt: string;
  challengeHash?: string;
  approval?: unknown;
}

export interface MppSettleRequestBody {
  approvalId: string;
  txid: string;
  settledAt?: string;
}

export interface MppSettleResponse {
  receiptId: string;
  receiptHash: string;
  approvalId?: string;
  receipt?: unknown;
  idempotent?: boolean;
}

export interface MppConfigResponse {
  acceptedRails: readonly string[];
  maxChallengeAmount?: string;
  endpoint?: string;
  allowedMints?: readonly string[];
}

export async function postMppChallenge(body: MppChallengeRequestBody): Promise<MppChallengeResponse> {
  return requestJson<MppChallengeResponse>('/api/mpp/challenge', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function postMppSettle(body: MppSettleRequestBody): Promise<MppSettleResponse> {
  return requestJson<MppSettleResponse>('/api/mpp/settle', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getMppConfig(): Promise<MppConfigResponse> {
  return requestJson<MppConfigResponse>('/api/mpp/config', { method: 'GET' });
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new MppApiError('network_error', err instanceof Error ? err.message : 'Network error');
  }

  const text = await response.text();
  const payload = text ? parseJson(text, path) : null;
  if (!response.ok) {
    const message = responseMessage(payload) ?? `MPP API returned HTTP ${response.status}.`;
    throw new MppApiError('http_error', message, response.status, payload);
  }
  if (payload === null || typeof payload !== 'object') {
    throw new MppApiError('invalid_response', `MPP API ${path} did not return a JSON object.`, response.status, payload);
  }
  return payload as T;
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MppApiError('invalid_response', `MPP API ${path} returned invalid JSON.`);
  }
}

function responseMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string'
      ? record.error
      : undefined;
}
