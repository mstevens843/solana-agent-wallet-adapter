// Phase 0 scaffolding — Phase 2C implements typed fetch wrappers over the
// /api/streaming/* render-web endpoints. Types here mirror the cross-stream
// contract in `packages/streaming-sessions/src/types.ts`; once Phase 2A locks
// that file in, switch these to `import type` from the package directly.

export type StreamingApiErrorCode = 'not_implemented' | 'network_error' | 'http_error';

export class StreamingApiError extends Error {
  constructor(readonly code: StreamingApiErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'StreamingApiError';
  }
}

export type StreamingSessionStatus = 'pending' | 'active' | 'expired' | 'revoked' | 'settled';

export interface StreamingSessionSummary {
  sessionId: string;
  tokenMint: string;
  capAmount: string;
  spentAmount: string;
  expiresAt: string;
  status: StreamingSessionStatus;
  ephemeralSignerPubkey: string;
  recipientAllowlist?: readonly string[];
}

export interface CreateSessionRequestBody {
  tokenMint: string;
  capAmount: string;
  expiresAt: string;
  recipientAllowlist?: readonly string[];
}

export interface CreateSessionResponse {
  sessionId: string;
  approveTx: string;
  ephemeralSignerPubkey: string;
  expiresAt: string;
}

export interface SubmitVoucherBody {
  voucher: {
    sessionId: string;
    nonce: string;
    amount: string;
    recipient: string;
    issuedAt: string;
    signature: string;
  };
}

export interface SubmitVoucherResponse {
  accepted: boolean;
  remaining: string;
}

async function notImplemented(symbol: string): Promise<never> {
  throw new StreamingApiError(
    'not_implemented',
    `${symbol} is Phase 2C (browser client). The render-web endpoint also returns 501 today.`,
  );
}

export async function createStreamingSession(_body: CreateSessionRequestBody): Promise<CreateSessionResponse> {
  return notImplemented('createStreamingSession');
}

export async function listStreamingSessions(): Promise<StreamingSessionSummary[]> {
  return notImplemented('listStreamingSessions');
}

export async function getStreamingSession(_sessionId: string): Promise<StreamingSessionSummary> {
  return notImplemented('getStreamingSession');
}

export async function submitStreamingVoucher(
  _sessionId: string,
  _body: SubmitVoucherBody,
): Promise<SubmitVoucherResponse> {
  return notImplemented('submitStreamingVoucher');
}

export async function revokeStreamingSession(_sessionId: string): Promise<{ revokeTx: string }> {
  return notImplemented('revokeStreamingSession');
}

export async function recordGrantSigned(
  _sessionId: string,
  _body: { approveTxid: string },
): Promise<{ status: StreamingSessionStatus }> {
  return notImplemented('recordGrantSigned');
}
