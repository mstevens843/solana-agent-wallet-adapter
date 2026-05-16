import type {
  StreamingSessionRecord,
  StreamingSessionStatus,
  StreamingSettlementRecord,
  StreamingVoucherRecord,
  WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';

export type StreamingApiErrorCode =
  | 'network_error'
  | 'http_error'
  | 'not_implemented'
  | 'invalid_response';

export class StreamingApiError extends Error {
  constructor(readonly code: StreamingApiErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'StreamingApiError';
  }
}

export interface UnsignedStreamingTx {
  txBase64: string;
  cluster?: WorkflowCluster;
  description?: string;
  kind?: string;
  tokenMint?: string;
  tokenDecimals?: number;
  sourceAta?: string;
  totalAmount?: string;
  instructionCount?: number;
}

export interface CreateSessionRequestBody {
  tokenMint: string;
  capAmount: string;
  expiresAt: string;
  recipientAllowlist?: readonly string[];
  cluster?: WorkflowCluster;
  tokenDecimals?: number;
}

export interface CreateSessionResponse {
  session: StreamingSessionRecord;
  approveTx: UnsignedStreamingTx;
}

export interface StreamingSessionDetail {
  session: StreamingSessionRecord;
  vouchers: StreamingVoucherRecord[];
  settlement?: StreamingSettlementRecord;
  receiptUrl?: string;
  receipt?: unknown;
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
  voucher?: StreamingVoucherRecord;
}

export interface RevokeSessionResponse {
  session?: StreamingSessionRecord;
  revokeTx: UnsignedStreamingTx;
}

export interface SignedStreamingTxBody {
  txid?: string;
  approveTxid?: string;
  revokeTxid?: string;
  signature?: string;
  approvalId?: string;
  status?: 'submitted' | 'confirmed';
  txStatus?: string;
}

export interface SignedStreamingTxResponse {
  status: StreamingSessionStatus;
  session?: StreamingSessionRecord;
}

type JsonRecord = Record<string, unknown>;

export async function createStreamingSession(body: CreateSessionRequestBody): Promise<CreateSessionResponse> {
  const payload = await streamingRequest('/api/streaming/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const record = asRecord(payload, 'create session response');
  const session = parseSession(record.session ?? record, 'session');
  const tx = parseUnsignedTx(record.approveTx ?? record.approveTransaction ?? record.tx ?? record.transaction, 'approveTx', session);
  return { session, approveTx: tx };
}

export async function listStreamingSessions(): Promise<StreamingSessionRecord[]> {
  const payload = await streamingRequest('/api/streaming/sessions', { method: 'GET' });
  if (Array.isArray(payload)) {
    return payload.map((item, index) => parseSession(item, `sessions[${index}]`));
  }
  const record = asRecord(payload, 'sessions response');
  const sessions = record.sessions ?? record.items ?? record.data;
  if (!Array.isArray(sessions)) {
    throw invalidResponse('sessions response did not include a sessions array.');
  }
  return sessions.map((item, index) => parseSession(item, `sessions[${index}]`));
}

export async function getStreamingSession(sessionId: string): Promise<StreamingSessionDetail> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}`, { method: 'GET' });
  return parseDetail(payload);
}

export async function submitStreamingVoucher(
  sessionId: string,
  body: SubmitVoucherBody,
): Promise<SubmitVoucherResponse> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}/voucher`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const record = asRecord(payload, 'voucher response');
  return {
    accepted: record.accepted === true,
    remaining: typeof record.remaining === 'string' ? record.remaining : '',
    ...(record.voucher ? { voucher: parseVoucher(record.voucher, 'voucher') } : {}),
  };
}

export async function revokeStreamingSession(sessionId: string): Promise<RevokeSessionResponse> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    body: '{}',
  });
  const record = asRecord(payload, 'revoke response');
  const session = record.session ? parseSession(record.session, 'session') : undefined;
  const fallbackSession = session ?? (record.id || record.sessionId ? parseSession(record, 'session') : undefined);
  const revokeTx = parseUnsignedTx(record.revokeTx ?? record.revokeTransaction ?? record.tx ?? record.transaction, 'revokeTx', fallbackSession);
  return {
    ...(fallbackSession ? { session: fallbackSession } : {}),
    revokeTx,
  };
}

export async function recordGrantSigned(
  sessionId: string,
  body: SignedStreamingTxBody,
): Promise<SignedStreamingTxResponse> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}/grant-signed`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSignedResponse(payload);
}

export async function recordRevokeSigned(
  sessionId: string,
  body: SignedStreamingTxBody,
): Promise<SignedStreamingTxResponse> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}/revoke-signed`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSignedResponse(payload);
}

export async function getStreamingReceipt(sessionId: string): Promise<unknown> {
  const payload = await streamingRequest(`/api/streaming/sessions/${encodeURIComponent(sessionId)}/receipt`, {
    method: 'GET',
  });
  return payload;
}

async function streamingRequest(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new StreamingApiError('network_error', err instanceof Error ? err.message : 'Network error');
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const message = errorMessageFromPayload(payload, response.status);
    const code: StreamingApiErrorCode = response.status === 501 ? 'not_implemented' : 'http_error';
    throw new StreamingApiError(code, message, response.status);
  }
  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse(`Streaming API returned non-JSON response for HTTP ${response.status}.`);
  }
}

function errorMessageFromPayload(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as JsonRecord;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
  }
  return `Streaming API request failed with HTTP ${status}.`;
}

function parseDetail(payload: unknown): StreamingSessionDetail {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as JsonRecord;
    const session = parseSession(record.session ?? record, 'session');
    const vouchers = parseVouchers(record.vouchers ?? record.items ?? sessionMetadataArray(session, 'vouchers'));
    const settlement = record.settlement ? parseSettlement(record.settlement, 'settlement') : undefined;
    const receiptUrl = typeof record.receiptUrl === 'string'
      ? record.receiptUrl
      : typeof record.settlementReceiptUrl === 'string'
        ? record.settlementReceiptUrl
        : undefined;
    return {
      session,
      vouchers,
      ...(settlement ? { settlement } : {}),
      ...(receiptUrl ? { receiptUrl } : {}),
      ...(record.receipt !== undefined ? { receipt: record.receipt } : {}),
    };
  }
  return {
    session: parseSession(payload, 'session'),
    vouchers: [],
  };
}

function parseSignedResponse(payload: unknown): SignedStreamingTxResponse {
  const record = asRecord(payload, 'signed transaction response');
  const session = record.session ? parseSession(record.session, 'session') : undefined;
  const rawStatus = typeof record.status === 'string' ? record.status : session?.status;
  const status = parseSessionStatus(rawStatus, 'status');
  return {
    status,
    ...(session ? { session } : {}),
  };
}

function parseUnsignedTx(value: unknown, label: string, session?: StreamingSessionRecord): UnsignedStreamingTx {
  if (typeof value === 'string' && value.trim()) {
    return {
      txBase64: value.trim(),
      ...(session ? { cluster: session.cluster, tokenMint: session.tokenMint } : {}),
    };
  }
  const record = asRecord(value, label);
  const txBase64 = stringField(record.txBase64) ||
    stringField(record.transactionBase64) ||
    stringField(record.base64) ||
    stringField(record.tx);
  if (!txBase64) throw invalidResponse(`${label} did not include txBase64.`);
  const clusterRaw = stringField(record.cluster) || session?.cluster;
  return {
    txBase64,
    ...(parseClusterOrUndefined(clusterRaw) ? { cluster: parseClusterOrUndefined(clusterRaw) } : {}),
    ...(stringField(record.description) ? { description: stringField(record.description) } : {}),
    ...(stringField(record.kind) ? { kind: stringField(record.kind) } : {}),
    ...(stringField(record.tokenMint) || session?.tokenMint ? { tokenMint: stringField(record.tokenMint) || session?.tokenMint } : {}),
    ...(typeof record.tokenDecimals === 'number' ? { tokenDecimals: record.tokenDecimals } : {}),
    ...(stringField(record.sourceAta) ? { sourceAta: stringField(record.sourceAta) } : {}),
    ...(stringField(record.totalAmount) ? { totalAmount: stringField(record.totalAmount) } : {}),
    ...(typeof record.instructionCount === 'number' ? { instructionCount: record.instructionCount } : {}),
  };
}

function parseSession(value: unknown, label: string): StreamingSessionRecord {
  const record = asRecord(value, label);
  const id = stringField(record.id) || stringField(record.sessionId);
  if (!id) throw invalidResponse(`${label} is missing id.`);
  return {
    id,
    walletAddress: requiredString(record.walletAddress, `${label}.walletAddress`),
    cluster: parseCluster(requiredString(record.cluster, `${label}.cluster`), `${label}.cluster`),
    tokenMint: requiredString(record.tokenMint, `${label}.tokenMint`),
    delegatePubkey: requiredString(record.delegatePubkey, `${label}.delegatePubkey`),
    ephemeralSignerPubkey: requiredString(record.ephemeralSignerPubkey, `${label}.ephemeralSignerPubkey`),
    capAmount: requiredString(record.capAmount, `${label}.capAmount`),
    spentAmount: typeof record.spentAmount === 'string' ? record.spentAmount : '0',
    expiresAt: requiredString(record.expiresAt, `${label}.expiresAt`),
    status: parseSessionStatus(record.status, `${label}.status`),
    ...(parseStringArray(record.recipientAllowlist) ? { recipientAllowlist: parseStringArray(record.recipientAllowlist) } : {}),
    ...(stringField(record.approveTxid) ? { approveTxid: stringField(record.approveTxid) } : {}),
    ...(stringField(record.revokeTxid) ? { revokeTxid: stringField(record.revokeTxid) } : {}),
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    ...(isRecord(record.metadata) ? { metadata: record.metadata as StreamingSessionRecord['metadata'] } : {}),
  };
}

function parseVoucher(value: unknown, label: string): StreamingVoucherRecord {
  const record = asRecord(value, label);
  return {
    id: requiredString(record.id, `${label}.id`),
    sessionId: requiredString(record.sessionId, `${label}.sessionId`),
    nonce: requiredString(record.nonce, `${label}.nonce`),
    amount: requiredString(record.amount, `${label}.amount`),
    recipient: requiredString(record.recipient, `${label}.recipient`),
    voucherHash: requiredString(record.voucherHash, `${label}.voucherHash`),
    signature: requiredString(record.signature, `${label}.signature`),
    issuedAt: requiredString(record.issuedAt, `${label}.issuedAt`),
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    ...(stringField(record.settledAt) ? { settledAt: stringField(record.settledAt) } : {}),
    ...(stringField(record.settlementTxid) ? { settlementTxid: stringField(record.settlementTxid) } : {}),
  };
}

function parseSettlement(value: unknown, label: string): StreamingSettlementRecord {
  const record = asRecord(value, label);
  return {
    id: requiredString(record.id, `${label}.id`),
    sessionId: requiredString(record.sessionId, `${label}.sessionId`),
    walletAddress: requiredString(record.walletAddress, `${label}.walletAddress`),
    cluster: parseCluster(requiredString(record.cluster, `${label}.cluster`), `${label}.cluster`),
    totalAmount: requiredString(record.totalAmount, `${label}.totalAmount`),
    voucherCount: typeof record.voucherCount === 'number' ? record.voucherCount : 0,
    ...(stringField(record.txid) ? { txid: stringField(record.txid) } : {}),
    status: parseSettlementStatus(record.status),
    createdAt: requiredString(record.createdAt, `${label}.createdAt`),
    updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    ...(stringField(record.receiptId) ? { receiptId: stringField(record.receiptId) } : {}),
  };
}

function parseVouchers(value: unknown): StreamingVoucherRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => parseVoucher(item, `vouchers[${index}]`));
}

function sessionMetadataArray(session: StreamingSessionRecord, key: string): unknown {
  const metadata = session.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as JsonRecord)[key]
    : undefined;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  throw invalidResponse(`${label} was not an object.`);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredString(value: unknown, label: string): string {
  const text = stringField(value);
  if (!text) throw invalidResponse(`${label} is missing.`);
  return text;
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return values.length ? values : undefined;
}

function parseSessionStatus(value: unknown, label: string): StreamingSessionStatus {
  if (
    value === 'pending' ||
    value === 'active' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'settled'
  ) {
    return value;
  }
  throw invalidResponse(`${label} is not a valid streaming session status.`);
}

function parseSettlementStatus(value: unknown): StreamingSettlementRecord['status'] {
  if (value === 'pending' || value === 'submitted' || value === 'confirmed' || value === 'failed') return value;
  return 'pending';
}

function parseCluster(value: string, label: string): WorkflowCluster {
  const cluster = parseClusterOrUndefined(value);
  if (!cluster) throw invalidResponse(`${label} is not a supported cluster.`);
  return cluster;
}

function parseClusterOrUndefined(value: unknown): WorkflowCluster | undefined {
  if (value === 'mainnet-beta' || value === 'devnet' || value === 'testnet' || value === 'localnet') return value;
  return undefined;
}

function invalidResponse(message: string): StreamingApiError {
  return new StreamingApiError('invalid_response', message);
}
