import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EvidenceReceiptRecord } from '@solana-agent-wallet-adapter/workflow';

import {
  StreamingService,
  StreamingServiceError,
  normalizeVoucher,
  streamingStoreFor,
  type CreateStreamingSessionInput,
  type StreamingSessionListStatus,
} from './streamingService.js';
import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';

const PREFIX = '/api/streaming/';
const SESSIONS_COLLECTION = '/api/streaming/sessions';
const SESSION_ITEM_RE =
  /^\/api\/streaming\/sessions\/([A-Za-z0-9_-]+)(?:\/(voucher|revoke|revoke-signed|grant-signed|receipt))?\/?$/;
const MAX_JSON_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'BodyTooLargeError';
  }
}

class InvalidJsonError extends Error {
  constructor() {
    super('Request body must be valid JSON.');
    this.name = 'InvalidJsonError';
  }
}

async function handleStreamingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DevApiHandlerContext,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false;

  try {
    const service = new StreamingService(streamingStoreFor(ctx.workflowStore), {
      clock: ctx.clock,
    });
    if (url.pathname === SESSIONS_COLLECTION) {
      await handleCollection(req, res, url, ctx, service);
      return true;
    }

    const itemMatch = url.pathname.match(SESSION_ITEM_RE);
    if (!itemMatch?.[1]) {
      writeJsonNoStore(req, res, 404, { error: 'not_found' });
      return true;
    }
    await handleSessionItem(req, res, ctx, service, itemMatch[1], itemMatch[2]);
  } catch (err) {
    writeStreamingError(req, res, err);
  }
  return true;
}

async function handleCollection(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DevApiHandlerContext,
  service: StreamingService,
): Promise<void> {
  const walletAddress = requireWallet(ctx);
  if (req.method === 'POST') {
    const input = parseCreateBody(await readJsonBody(req), walletAddress);
    const result = await service.createSession(input);
    writeJsonNoStore(req, res, 201, {
      sessionId: result.session.sessionId,
      session: result.session,
      approveTx: result.approveTx,
      ephemeralSignerPubkey: result.ephemeralSignerPubkey,
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const sessions = await service.listSessions({
      walletAddress,
      status: parseStatus(url.searchParams.get('status')),
    });
    writeJsonNoStore(req, res, 200, { sessions });
    return;
  }
  methodNotAllowed(req, res);
}

async function handleSessionItem(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DevApiHandlerContext,
  service: StreamingService,
  sessionId: string,
  subResource: string | undefined,
): Promise<void> {
  const walletAddress = requireWallet(ctx);

  if (!subResource && (req.method === 'GET' || req.method === 'HEAD')) {
    const detail = await service.getSession({ walletAddress, sessionId });
    writeJsonNoStore(req, res, 200, detail);
    return;
  }

  if (subResource === 'grant-signed' && req.method === 'POST') {
    const body = recordBody(await readJsonBody(req));
    const session = await service.recordGrantSigned({
      walletAddress,
      sessionId,
      approveTxid: requiredString(body.approveTxid, 'approveTxid'),
    });
    writeJsonNoStore(req, res, 200, { session });
    return;
  }

  if (subResource === 'voucher' && req.method === 'POST') {
    const body = recordBody(await readJsonBody(req));
    const result = await service.acceptVoucher({
      walletAddress,
      sessionId,
      voucher: normalizeVoucher(body.voucher),
    });
    writeJsonNoStore(req, res, 200, {
      accepted: result.accepted,
      remaining: result.remaining,
      spentAmount: result.spentAmount,
      voucherId: result.voucher.id,
      voucherHash: result.voucherHash,
      session: result.session,
    });
    return;
  }

  if (subResource === 'revoke' && req.method === 'POST') {
    const result = await service.revokeSession({ walletAddress, sessionId });
    writeJsonNoStore(req, res, 200, {
      session: result.session,
      revokeTx: result.revokeTx,
    });
    return;
  }

  if (subResource === 'revoke-signed' && req.method === 'POST') {
    const body = recordBody(await readJsonBody(req));
    const session = await service.recordRevokeSigned({
      walletAddress,
      sessionId,
      revokeTxid: requiredString(body.revokeTxid, 'revokeTxid'),
    });
    writeJsonNoStore(req, res, 200, { session });
    return;
  }

  if (subResource === 'receipt' && (req.method === 'GET' || req.method === 'HEAD')) {
    const detail = await service.getSession({ walletAddress, sessionId });
    const receipts = (await ctx.evidenceStore.listEvidence(walletAddress))
      .filter((record) => isStreamingSettlementReceipt(record, detail.session.sessionId));
    writeJsonNoStore(req, res, 200, { receipts });
    return;
  }

  methodNotAllowed(req, res);
}

function parseCreateBody(body: unknown, walletAddress: string): CreateStreamingSessionInput {
  const record = recordBody(body);
  const cluster = optionalString(record.cluster, 'cluster');
  const tokenDecimals = optionalNumber(record.tokenDecimals, 'tokenDecimals');
  const recipientAllowlist = optionalStringArray(record.recipientAllowlist, 'recipientAllowlist');
  const metadata = optionalRecord(record.metadata, 'metadata');
  return {
    walletAddress,
    tokenMint: requiredString(record.tokenMint, 'tokenMint'),
    capAmount: requiredString(record.capAmount, 'capAmount'),
    expiresAt: requiredString(record.expiresAt, 'expiresAt'),
    ...(cluster ? { cluster: cluster as CreateStreamingSessionInput['cluster'] } : {}),
    ...(tokenDecimals !== undefined ? { tokenDecimals } : {}),
    ...(recipientAllowlist ? { recipientAllowlist } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseStatus(raw: string | null): StreamingSessionListStatus {
  if (!raw || raw === 'active') return 'active';
  if (
    raw === 'all' ||
    raw === 'pending' ||
    raw === 'active' ||
    raw === 'expired' ||
    raw === 'revoked' ||
    raw === 'settled'
  ) {
    return raw;
  }
  throw new StreamingServiceError(400, 'invalid_status', 'status must be active, pending, expired, revoked, settled, or all.');
}

function requireWallet(ctx: DevApiHandlerContext): string {
  if (!ctx.walletAddress) {
    throw new StreamingServiceError(403, 'dev_layer1_disabled', 'This route is only available to allowlisted dev wallets.');
  }
  return ctx.walletAddress;
}

function isStreamingSettlementReceipt(record: EvidenceReceiptRecord, sessionId: string): boolean {
  return record.kind === 'streaming_settlement' && record.metadata?.sessionId === sessionId;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StreamingServiceError(400, 'invalid_body', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StreamingServiceError(400, 'missing_field', `${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new StreamingServiceError(400, 'invalid_field', `${field} must be a string.`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StreamingServiceError(400, 'invalid_field', `${field} must be a number.`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new StreamingServiceError(400, 'invalid_field', `${field} must be an array of strings.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new StreamingServiceError(400, 'invalid_field', `${field}[${index}] must be a string.`);
    }
    return entry.trim();
  }).filter(Boolean);
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StreamingServiceError(400, 'invalid_field', `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
  writeJsonNoStore(req, res, 405, { error: 'method_not_allowed' });
}

function writeStreamingError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof StreamingServiceError) {
    writeJsonNoStore(req, res, err.status, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof BodyTooLargeError) {
    writeJsonNoStore(req, res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJsonNoStore(req, res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'internal_error';
  const status = statusForStreamingCode(code);
  const message = err instanceof Error ? err.message : 'Unexpected streaming session error.';
  writeJsonNoStore(req, res, status, { error: code, message });
}

function statusForStreamingCode(code: string): number {
  switch (code) {
    case 'invalid_input':
    case 'invalid_amount':
    case 'invalid_public_key':
    case 'invalid_schema':
    case 'voucher_invalid_signature':
      return 400;
    case 'voucher_recipient_not_allowed':
      return 403;
    case 'session_expired':
    case 'session_revoked':
    case 'session_not_active':
    case 'voucher_replay':
    case 'voucher_exceeds_remaining':
      return 409;
    default:
      return 500;
  }
}

function writeJsonNoStore(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
}

const streamingHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'HEAD', 'POST'],
  handle: handleStreamingRequest,
};

registerDevApiHandler(streamingHandler);
