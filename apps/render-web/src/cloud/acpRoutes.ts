import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AcpError,
  AcpParseError,
  AcpReceiptError,
  AcpValidationError,
  buildAcpOutboundReceipt,
  cartToTransferParams,
  hashCart,
  parseAcpCart,
  validateAcpCart,
  type AcpCart,
  type AcpReceipt,
} from '@solana-agent-wallet-adapter/acp-adapter';
import {
  WorkflowValidationError,
  type ApprovalRequestRecord,
  type AuditActor,
  type AuditEventRecord,
  type EvidenceReceiptRecord,
  type JsonObject,
  type WorkflowCluster,
  type WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';

const PREFIX = '/api/acp/cart/';
const MAX_JSON_BYTES = 64 * 1024;
const PREVIEW_PATH = '/api/acp/cart/preview';
const APPROVE_PATH = '/api/acp/cart/approve';
const RECEIPT_PATH_RE = /^\/api\/acp\/cart\/([A-Za-z0-9_-]+)\/receipt$/;
const ACP_OUTBOUND_SOURCE = 'acp_outbound';

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

export async function handleAcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: DevApiHandlerContext,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const path = url.pathname;
  if (path === PREVIEW_PATH) {
    await handlePreview(req, res, context);
    return true;
  }
  if (path === APPROVE_PATH) {
    await handleApprove(req, res, context);
    return true;
  }
  const receiptMatch = RECEIPT_PATH_RE.exec(path);
  if (receiptMatch) {
    const approvalId = receiptMatch[1];
    if (typeof approvalId === 'string') {
      await handleReceipt(req, res, context, approvalId);
      return true;
    }
  }
  return false;
}

async function handlePreview(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
    const cart = requested.cart;
    const validated = validateAcpCart(cart);
    const transfer = cartToTransferParams(validated, {
      ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
      ...(requested.note !== undefined ? { note: requested.note } : {}),
    });

    if (context.walletAddress) {
      await appendAcpAuditEvent(context, 'user', 'acp.cart.previewed', cart.id, {
        cartId: cart.id,
        merchantId: cart.merchant.id,
        totalAmount: cart.totalAmount,
        paymentAmount: validated.transferAmount,
        paymentToken: cart.paymentToken,
        cluster: cart.cluster,
        receivedAt: requested.receivedAt,
      });
    }

    writeJsonNoStore(res, 200, {
      preview: {
        cart,
        transfer,
        totalFiat: validated.totalFiat,
        resolvedTokenMint: validated.resolvedTokenMint,
      },
    });
  } catch (err) {
    writeAcpError(res, err);
  }
}

async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  if (!context.walletAddress) {
    writeJsonNoStore(res, 401, {
      error: 'auth_required',
      message: 'Sign in to Agentic Cloud with your wallet to use merchant payments.',
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const requested = DevLayer1.acp.validateCreateAcpCartRequest(body);
    const cart = requested.cart;
    const validated = validateAcpCart(cart);
    const transfer = cartToTransferParams(validated, {
      ...(requested.dueAt !== undefined ? { dueAt: requested.dueAt } : {}),
      ...(requested.note !== undefined ? { note: requested.note } : {}),
    });
    const cluster: WorkflowCluster = requested.cluster ?? cart.cluster;
    const session: WorkflowSession = { walletAddress: context.walletAddress };
    const cartJson = cartAsJson(cart);
    const cartHash = hashCart(cart);

    const isSolPayment = cart.paymentToken === 'SOL';
    const approvalKind = isSolPayment ? 'transfer_sol' : 'transfer_spl';
    const params = isSolPayment
      ? {
          recipient: transfer.recipient,
          amountSol: transfer.amount,
          ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
        } satisfies JsonObject
      : {
          recipient: transfer.recipient,
          token: cart.paymentToken,
          amount: transfer.amount,
          tokenMint: validated.resolvedTokenMint,
          ...(cart.memo !== undefined ? { memo: cart.memo } : {}),
        } satisfies JsonObject;

    const approval = await context.workflowService.createApproval(session, {
      kind: approvalKind,
      summary: `ACP: ${cart.merchant.name} — ${transfer.amount} ${cart.paymentToken}`,
      params,
      cluster,
      ...(cart.expiresAt !== undefined ? { dueAt: cart.expiresAt } : {}),
      amount: transfer.amount,
      token: cart.paymentToken,
      recipient: transfer.recipient,
      ...(requested.note !== undefined ? { note: requested.note } : {}),
      metadata: {
        source: ACP_OUTBOUND_SOURCE,
        actionSource: ACP_OUTBOUND_SOURCE,
        acpCartId: cart.id,
        acpCartHash: cartHash,
        acpCart: cartJson,
        merchant: cartJson.merchant as JsonObject,
        totalAmount: cart.totalAmount,
        paymentAmount: transfer.amount,
        paymentToken: cart.paymentToken,
        resolvedTokenMint: validated.resolvedTokenMint,
        acpCluster: cart.cluster,
        totalFiat: validated.totalFiat,
        receivedAt: requested.receivedAt,
      },
    });

    await appendAcpAuditEvent(context, 'user', 'acp.cart.approved', approval.id, {
      approvalId: approval.id,
      cartId: cart.id,
      cartHash,
      merchantId: cart.merchant.id,
      totalAmount: cart.totalAmount,
      paymentAmount: transfer.amount,
      paymentToken: cart.paymentToken,
      cluster,
    });

    writeJsonNoStore(res, 201, {
      approval,
      approvalId: approval.id,
      cartId: cart.id,
      cartHash,
    });
  } catch (err) {
    writeAcpError(res, err);
  }
}

async function handleReceipt(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
  approvalId: string,
): Promise<void> {
  if (!context.walletAddress) {
    writeJsonNoStore(res, 401, {
      error: 'auth_required',
      message: 'Sign in to Agentic Cloud with your wallet to create merchant payment receipts.',
    });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const overrides = parseReceiptBody(body);
    const session: WorkflowSession = { walletAddress: context.walletAddress };

    const approval = await context.workflowStore.getApproval(context.walletAddress, approvalId);
    if (!approval) {
      writeJsonNoStore(res, 404, {
        error: 'approval_not_found',
        message: `No approval found for id ${approvalId}.`,
      });
      return;
    }
    const cart = extractAcpCartFromApproval(approval);
    if (!cart) {
      writeJsonNoStore(res, 409, {
        error: 'not_an_acp_approval',
        message: 'This approval does not carry an ACP outbound cart in its metadata.',
      });
      return;
    }
    const cartHash = hashCart(cart);
    const storedHash = approval.metadata?.acpCartHash;
    if (typeof storedHash === 'string' && storedHash !== cartHash) {
      writeJsonNoStore(res, 409, {
        error: 'cart_hash_mismatch',
        message: 'Stored cart hash on the approval does not match the canonical hash of its cart payload.',
      });
      return;
    }

    // Gate: only build a receipt when an on-chain finalization is confirmed.
    // Source of truth for txid is the finalization record, not the request body
    // — mirrors AP2 inbound receipt handling.
    const finalizations = await context.workflowService.listFinalizationsForApproval(session, approvalId);
    const confirmed = finalizations.find((f) => f.txid && f.status === 'confirmed');
    if (!confirmed?.txid) {
      writeJsonNoStore(res, 409, {
        error: 'not_finalized',
        message: 'Approval has not yet been confirmed on-chain.',
      });
      return;
    }

    const txid = confirmed.txid;
    const finalizedAt = confirmed.confirmedAt ?? confirmed.updatedAt ?? confirmed.createdAt;
    const nowIso = context.clock.now().toISOString();

    const receipt = buildAcpOutboundReceipt({
      cart,
      txid,
      walletAddress: context.walletAddress,
      settledAt: overrides.settledAt ?? finalizedAt ?? nowIso,
    });

    const record = buildEvidenceRecord({
      receipt,
      cart,
      approvalId: approval.id,
      cluster: approval.cluster,
      nowIso,
    });
    await context.evidenceStore.saveEvidence(context.walletAddress, record);

    const updatedApproval: ApprovalRequestRecord = {
      ...approval,
      metadata: {
        ...(approval.metadata ?? {}),
        acpOutboundReceipt: receiptAsJsonObject(receipt),
        acpOutboundReceiptIssuedAt: nowIso,
        acpEvidenceReceiptId: record.id,
      },
      updatedAt: nowIso,
    };
    await context.workflowStore.saveApproval(context.walletAddress, updatedApproval);

    await context.evidenceStore.appendEvidenceAuditEvent(context.walletAddress, {
      id: `audit_${randomUUID()}`,
      walletAddress: context.walletAddress,
      type: 'acp.receipt.created',
      recordType: 'evidence',
      recordId: record.id,
      createdAt: nowIso,
      metadata: {
        approvalId: approval.id,
        cartId: cart.id,
        cartHash,
        txid,
        receiptId: receipt.receiptId,
      },
    });

    await appendAcpAuditEvent(context, 'server', 'acp.receipt.created', approval.id, {
      approvalId: approval.id,
      cartId: cart.id,
      cartHash,
      txid,
      receiptId: receipt.receiptId,
      evidenceId: record.id,
      artifactHash: receipt.cartHash,
    });

    writeJsonNoStore(res, 201, {
      receipt: record,
      acp: receipt,
      approvalId: approval.id,
    });
  } catch (err) {
    writeAcpError(res, err);
  }
}

function parseReceiptBody(body: unknown): { settledAt?: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowValidationError('invalid_object', 'Expected a JSON object.', '$');
  }
  const record = body as Record<string, unknown>;
  if (record.settledAt === undefined) return {};
  const s = record.settledAt;
  if (typeof s !== 'string' || Number.isNaN(Date.parse(s))) {
    throw new WorkflowValidationError('invalid_timestamp', 'settledAt must be an ISO-8601 timestamp.', '$.settledAt');
  }
  return { settledAt: s };
}

function extractAcpCartFromApproval(approval: ApprovalRequestRecord): AcpCart | null {
  const meta = approval.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const source = (meta as Record<string, unknown>).source;
  if (source !== ACP_OUTBOUND_SOURCE) return null;
  const candidate = (meta as Record<string, unknown>).acpCart;
  if (!candidate || typeof candidate !== 'object') return null;
  try {
    return parseAcpCart(candidate);
  } catch {
    return null;
  }
}

function buildEvidenceRecord(input: {
  receipt: AcpReceipt;
  cart: AcpCart;
  approvalId: string;
  cluster: string | undefined;
  nowIso: string;
}): EvidenceReceiptRecord {
  const { receipt, cart, approvalId, cluster, nowIso } = input;
  const payload = receiptAsJsonObject(receipt);
  return {
    id: `evidence_acp_${randomUUID()}`,
    walletAddress: receipt.walletAddress,
    ...(cluster !== undefined ? { cluster } : {}),
    title: `ACP Outbound: ${cart.merchant.name}`,
    kind: 'acp_outbound',
    status: 'approved',
    payload,
    preSignatureHash: receipt.cartHash,
    signingMessage: `acp-outbound:${cart.id}@${receipt.txid}`,
    signature: receipt.txid,
    verified: true,
    artifactHash: receipt.cartHash,
    createdAt: nowIso,
    updatedAt: nowIso,
    receiptType: 'acp_outbound',
    summary: `Paid ${cart.paymentAmount ?? cart.totalAmount} ${cart.paymentToken} to ${cart.merchant.name}.`,
    metadata: {
      approvalId,
      cartId: cart.id,
      cartHash: receipt.cartHash,
      txid: receipt.txid,
      receiptId: receipt.receiptId,
    },
  };
}

function cartAsJson(cart: AcpCart): JsonObject {
  return JSON.parse(JSON.stringify(cart)) as JsonObject;
}

function receiptAsJsonObject(receipt: AcpReceipt): JsonObject {
  return JSON.parse(JSON.stringify(receipt)) as JsonObject;
}

async function appendAcpAuditEvent(
  context: DevApiHandlerContext,
  actor: AuditActor,
  type: string,
  recordId: string,
  metadata: JsonObject,
): Promise<void> {
  if (!context.walletAddress) return;
  const record: AuditEventRecord = {
    id: `audit_${randomUUID()}`,
    walletAddress: context.walletAddress,
    type,
    createdAt: context.clock.now().toISOString(),
    actor,
    recordType: 'approval',
    recordId,
    metadata,
  };
  await context.workflowStore.appendAuditEvent(context.walletAddress, record);
}

function writeAcpError(res: ServerResponse, err: unknown): void {
  if (err instanceof BodyTooLargeError) {
    writeJsonNoStore(res, 413, { error: 'body_too_large', message: err.message });
    return;
  }
  if (err instanceof InvalidJsonError) {
    writeJsonNoStore(res, 400, { error: 'invalid_json', message: err.message });
    return;
  }
  if (err instanceof WorkflowValidationError) {
    const code = err.code ?? 'invalid_input';
    const payload: JsonObject = { error: code, message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  if (err instanceof AcpParseError) {
    const payload: JsonObject = { error: `parse_error:${err.code}`, message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  if (err instanceof AcpValidationError) {
    const payload: JsonObject = { error: `validation_error:${err.code}`, message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  if (err instanceof AcpReceiptError) {
    const payload: JsonObject = { error: `receipt_error:${err.code}`, message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  if (err instanceof AcpError) {
    const payload: JsonObject = { error: 'acp_error', message: err.message };
    if (err.path) payload.path = err.path;
    writeJsonNoStore(res, 400, payload);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[acpRoutes] internal error', err);
  writeJsonNoStore(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : 'Unexpected server error.',
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

function writeJsonNoStore(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

const acpHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['POST'],
  handle: handleAcpRequest,
};

registerDevApiHandler(acpHandler);
