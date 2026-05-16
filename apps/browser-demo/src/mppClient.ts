// Phase 0 scaffolding — Phase 1 implements typed fetch wrappers over the
// /api/mpp/* render-web endpoints. Until then these helpers return the 501
// payload (or throw) so callers fail loudly with a structured error.

export type MppApiErrorCode = 'not_implemented' | 'network_error' | 'http_error';

export class MppApiError extends Error {
  constructor(readonly code: MppApiErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'MppApiError';
  }
}

export interface MppChallengeRequestBody {
  challenge: unknown;
}

export interface MppChallengeResponse {
  approvalId: string;
  requestId: string;
  expiresAt: string;
}

export interface MppSettleRequestBody {
  approvalId: string;
  txid: string;
}

export interface MppSettleResponse {
  receiptId: string;
  receiptHash: string;
}

export interface MppConfigResponse {
  acceptedRails: readonly string[];
  maxChallengeAmount?: string;
  endpoint?: string;
}

async function postNotImplemented(path: string): Promise<never> {
  throw new MppApiError(
    'not_implemented',
    `${path} is Phase 1 (browser client). The render-web endpoint also returns 501 today.`,
  );
}

export async function postMppChallenge(_body: MppChallengeRequestBody): Promise<MppChallengeResponse> {
  return postNotImplemented('postMppChallenge');
}

export async function postMppSettle(_body: MppSettleRequestBody): Promise<MppSettleResponse> {
  return postNotImplemented('postMppSettle');
}

export async function getMppConfig(): Promise<MppConfigResponse> {
  return postNotImplemented('getMppConfig');
}
