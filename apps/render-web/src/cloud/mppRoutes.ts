import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  MppParseError,
  MppReceiptError,
  MppVerifyError,
  buildMppPaymentReceipt,
  challengeToApprovalParams,
  parseMppChallenge,
  selectSupportedPaymentMethod,
  verifyMppChallenge,
  type JsonObject,
  type MppChallenge,
  type MppCluster,
  type MppPaymentMethod,
  type MppReceipt,
} from '@solana-agent-wallet-adapter/mpp-adapter';
import {
  WorkflowValidationError,
  type ApprovalRequestRecord,
  type EvidenceReceiptRecord,
  type WorkflowCluster,
  type WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';

const PREFIX = '/api/mpp/';
const CHALLENGE_PATH = '/api/mpp/challenge';
const SETTLE_PATH = '/api/mpp/settle';
const CONFIG_PATH = '/api/mpp/config';
const MAX_JSON_BYTES = 64 * 1024;
const MPP_CONFIG_NAMESPACE = 'mpp-config';
const MPP_ACTION_SOURCE = 'mpp_challenge';
const MPP_EVIDENCE_KIND = 'mpp_session';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface MppConfig {
  acceptedRails: string[];
  maxChallengeAmount?: string;
  endpoint?: string;
  allowedMints?: string[];
}

interface MppPreferenceRecord {
  namespace: string;
  payload: unknown;
  updatedAt: string;
  version: number;
}

interface MppPreferenceStore {
  getPreference(walletAddress: string, namespace: string): Promise<MppPreferenceRecord | undefined>;
}

class JsonBodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

async function handleMppRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DevApiHandlerContext,
): Promise<boolean> {
  if (
    url.pathname !== CHALLENGE_PATH &&
    url.pathname !== SETTLE_PATH &&
    url.pathname !== CONFIG_PATH
  ) {
    return false;
  }

  if (!ctx.walletAddress) {
    writeJsonNoStore(req, res, 403, {
      error: 'dev_layer1_disabled',
      message: 'This route is only available to allowlisted dev wallets.',
    });
    return true;
  }

  try {
    if (url.pathname === CONFIG_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJsonNoStore(req, res, 405, { error: 'method_not_allowed' });
        return true;
      }
      await handleGetConfig(req, res, ctx);
      return true;
    }

    if (req.method !== 'POST') {
      writeJsonNoStore(req, res, 405, { error: 'method_not_allowed' });
      return true;
    }

    if (url.pathname === CHALLENGE_PATH) {
      await handlePostChallenge(req, res, ctx);
      return true;
    }
    await handlePostSettle(req, res, ctx);
    return true;
  } catch (err) {
    writeMppError(req, res, err);
    return true;
  }
}

async function handlePostChallenge(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  const session = sessionFromContext(context);
  const body = await readJsonBody(req);
  const config = await readMppConfig(context);
  const requested = DevLayer1.mpp.validateCreateMppRequest(body);
  const expectedCluster = requested.cluster as MppCluster | undefined;
  const allowedMints = allowedMintsForConfig(config);
  const verified = verifyMppChallenge(requested.challenge, {
    clockNow: context.clock.now(),
    ...(expectedCluster ? { expectedCluster } : {}),
    ...(config.maxChallengeAmount ? { maxAmount: config.maxChallengeAmount } : {}),
    ...(allowedMints.length ? { allowedMints } : {}),
  });
  const approvalParams = challengeToApprovalParams(requested.challenge, session.walletAddress, {
    paymentMethod: verified.paymentMethod,
  });
  const cluster: WorkflowCluster = requested.cluster ?? approvalParams.cluster;
  const approval = await context.workflowService.createApproval(session, {
    kind: approvalParams.kind,
    summary: approvalParams.summary,
    cluster,
    amount: approvalParams.amount,
    token: approvalParams.token,
    recipient: approvalParams.recipient,
    dueAt: requested.challenge.expiresAt,
    params: approvalParams.params,
    metadata: {
      ...approvalParams.metadata,
      mppReceivedAt: requested.receivedAt,
      ...(requested.agentLabel ? { agentLabel: requested.agentLabel } : {}),
    },
  });

  await context.workflowStore.appendAuditEvent(session.walletAddress, {
    id: `audit_${randomUUID()}`,
    walletAddress: session.walletAddress,
    type: 'mpp.challenge.created',
    actor: 'server',
    recordType: 'approval',
    recordId: approval.id,
    createdAt: context.clock.now().toISOString(),
    metadata: {
      approvalId: approval.id,
      challengeHash: verified.challengeHash,
      nonce: requested.challenge.nonce,
      resourceUrl: requested.challenge.resourceUrl,
      amount: requested.challenge.amount,
      currency: requested.challenge.currency,
      cluster,
    },
  });

  writeJsonNoStore(req, res, 201, {
    approvalId: approval.id,
    requestId: approval.id,
    expiresAt: requested.challenge.expiresAt,
    challengeHash: verified.challengeHash,
    approval: normalizeApprovalForResponse(approval),
  });
}

async function handlePostSettle(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  const session = sessionFromContext(context);
  const body = await readJsonBody(req);
  const settle = parseSettleBody(body);
  const approval = await context.workflowStore.getApproval(session.walletAddress, settle.approvalId);
  if (!approval || !isMppApproval(approval)) {
    writeJsonNoStore(req, res, 404, { error: 'approval_not_found' });
    return;
  }

  const existingId = stringFromMetadata(approval.metadata, 'mppEvidenceReceiptId');
  if (existingId) {
    const existing = await context.evidenceStore.getEvidence(session.walletAddress, existingId);
    if (existing?.artifactHash) {
      writeJsonNoStore(req, res, 200, {
        receiptId: existing.id,
        receiptHash: existing.artifactHash,
        receipt: existing.payload,
        approvalId: approval.id,
        idempotent: true,
      });
      return;
    }
  }

  const confirmed = await confirmedFinalizationForTxid(context, session, approval.id, settle.txid);
  if (!confirmed) {
    writeJsonNoStore(req, res, 409, {
      error: 'not_finalized',
      message: 'Approval has not yet been confirmed on-chain with the supplied txid.',
    });
    return;
  }

  const challenge = extractMppChallengeFromApproval(approval);
  if (!challenge) {
    writeJsonNoStore(req, res, 409, {
      error: 'missing_challenge',
      message: 'Approval is missing its source MPP challenge; cannot build receipt.',
    });
    return;
  }
  const paymentMethod = paymentMethodForApproval(challenge, approval);
  const settledAt = settle.settledAt ?? confirmed.confirmedAt ?? confirmed.updatedAt ?? confirmed.createdAt ?? context.clock.now().toISOString();
  const issuedAt = context.clock.now().toISOString();
  const receipt = buildMppPaymentReceipt({
    challenge,
    credential: {
      kind: paymentMethod.kind,
      signature: settle.txid,
      txid: settle.txid,
      payerWallet: session.walletAddress,
      settledAt,
    },
    walletAddress: session.walletAddress,
    cluster: (approval.cluster ?? paymentMethod.network) as MppCluster,
    txid: settle.txid,
    settledAt,
    issuedAt,
    paymentMethod,
  });
  const evidenceRecord = buildMppEvidenceRecord({ receipt, approval, challenge, issuedAt });
  await context.evidenceStore.saveEvidence(session.walletAddress, evidenceRecord);
  await context.evidenceStore.appendEvidenceAuditEvent(session.walletAddress, {
    id: `audit_${randomUUID()}`,
    walletAddress: session.walletAddress,
    type: 'mpp.receipt.created',
    recordType: 'evidence',
    recordId: evidenceRecord.id,
    createdAt: issuedAt,
    metadata: {
      approvalId: approval.id,
      txid: settle.txid,
      receiptId: receipt.receiptId,
      receiptHash: receipt.artifactHash,
      challengeHash: receipt.challengeHash,
      nonce: challenge.nonce,
    },
  });

  await context.workflowStore.saveApproval(session.walletAddress, {
    ...approval,
    metadata: {
      ...(approval.metadata ?? {}),
      mppPaymentReceipt: receipt as unknown as JsonObject,
      mppPaymentReceiptIssuedAt: issuedAt,
      mppEvidenceReceiptId: evidenceRecord.id,
    },
    updatedAt: issuedAt,
  });

  writeJsonNoStore(req, res, 201, {
    receiptId: evidenceRecord.id,
    receiptHash: receipt.artifactHash,
    receipt,
    approvalId: approval.id,
  });
}

async function handleGetConfig(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  const config = await readMppConfig(context);
  writeJsonNoStore(req, res, 200, config);
}

async function readMppConfig(context: DevApiHandlerContext): Promise<MppConfig> {
  const defaults: MppConfig = {
    acceptedRails: ['sol', 'usdc'],
    maxChallengeAmount: '10',
    endpoint: '',
  };
  const store = isMppPreferenceStore(context.workflowStore) ? context.workflowStore : undefined;
  if (!store || !context.walletAddress) return defaults;
  const preference = await store.getPreference(context.walletAddress, MPP_CONFIG_NAMESPACE).catch(() => undefined);
  if (!preference) return defaults;
  return normalizeMppConfig(preference.payload, defaults);
}

function normalizeMppConfig(payload: unknown, defaults: MppConfig): MppConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return defaults;
  const record = payload as Record<string, unknown>;
  const acceptedRails = Array.isArray(record.acceptedRails)
    ? record.acceptedRails.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    : defaults.acceptedRails;
  const maxChallengeAmount = typeof record.maxChallengeAmount === 'string' && record.maxChallengeAmount.trim()
    ? record.maxChallengeAmount.trim()
    : defaults.maxChallengeAmount;
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : defaults.endpoint;
  const allowedMints = Array.isArray(record.allowedMints)
    ? record.allowedMints.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    : undefined;
  return {
    acceptedRails,
    ...(maxChallengeAmount ? { maxChallengeAmount } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(allowedMints && allowedMints.length ? { allowedMints } : {}),
  };
}

function allowedMintsForConfig(config: MppConfig): string[] {
  const mints = new Set<string>(config.allowedMints ?? []);
  for (const rail of config.acceptedRails) {
    const normalized = rail.trim().toLowerCase();
    if (normalized === 'usdc') mints.add(USDC_MINT);
    if (rail.length >= 32 && rail.length <= 64) mints.add(rail);
  }
  return [...mints];
}

function parseSettleBody(body: unknown): { approvalId: string; txid: string; settledAt?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowValidationError('invalid_object', '$ must be a JSON object.', '$');
  }
  const record = body as Record<string, unknown>;
  const approvalId = shortString(record.approvalId, '$.approvalId', 160);
  const txid = shortString(record.txid, '$.txid', 256);
  const settledAtRaw = record.settledAt;
  if (settledAtRaw === undefined || settledAtRaw === null || settledAtRaw === '') {
    return { approvalId, txid };
  }
  if (typeof settledAtRaw !== 'string' || Number.isNaN(Date.parse(settledAtRaw))) {
    throw new WorkflowValidationError('invalid_timestamp', 'settledAt must be an ISO-8601 timestamp.', '$.settledAt');
  }
  return { approvalId, txid, settledAt: settledAtRaw };
}

function shortString(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowValidationError('missing_field', `${path} is required.`, path);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new WorkflowValidationError('field_too_long', `${path} must be at most ${max} characters.`, path);
  }
  return trimmed;
}

async function confirmedFinalizationForTxid(
  context: DevApiHandlerContext,
  session: WorkflowSession,
  approvalId: string,
  txid: string,
): Promise<{ txid?: string; status: string; createdAt?: string; updatedAt?: string; confirmedAt?: string } | undefined> {
  const finalizations = await context.workflowService.listFinalizationsForApproval(session, approvalId);
  return finalizations.find((finalization) => finalization.status === 'confirmed' && finalization.txid === txid);
}

function buildMppEvidenceRecord(input: {
  receipt: MppReceipt;
  approval: ApprovalRequestRecord;
  challenge: MppChallenge;
  issuedAt: string;
}): EvidenceReceiptRecord {
  const { receipt, approval, challenge, issuedAt } = input;
  const merchant = challenge.merchant?.name ?? challenge.merchant?.id ?? receipt.recipient;
  return {
    id: `evidence_mpp_${randomUUID()}`,
    walletAddress: approval.walletAddress,
    ...(approval.cluster ? { cluster: approval.cluster } : {}),
    title: `MPP Payment: ${merchant}`,
    kind: MPP_EVIDENCE_KIND,
    status: 'approved',
    payload: receipt as unknown as JsonObject,
    preSignatureHash: receipt.artifactHash,
    signingMessage: `mpp-payment:${challenge.nonce}@${receipt.txid ?? receipt.credentialHash}`,
    signature: receipt.txid ?? receipt.credentialHash,
    verified: true,
    artifactHash: receipt.artifactHash,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    receiptType: MPP_EVIDENCE_KIND,
    summary: `Paid ${receipt.amount} ${receipt.currency} to ${merchant} via MPP.`,
    metadata: {
      approvalId: approval.id,
      txid: receipt.txid ?? '',
      receiptId: receipt.receiptId,
      receiptHash: receipt.artifactHash,
      challengeHash: receipt.challengeHash,
      nonce: challenge.nonce,
      resourceUrl: challenge.resourceUrl,
    },
  };
}

function extractMppChallengeFromApproval(approval: ApprovalRequestRecord): MppChallenge | null {
  const proposal = approval.metadata?.actionProposal;
  if (!proposal || typeof proposal !== 'object') return null;
  return parseMppChallenge(proposal);
}

function paymentMethodForApproval(challenge: MppChallenge, approval: ApprovalRequestRecord): MppPaymentMethod {
  const expectedKind = approval.kind === 'transfer_sol' ? 'solana-sol' : 'solana-spl';
  const exact = challenge.paymentMethods.find((method) =>
    method.kind === expectedKind &&
    method.recipient === approval.recipient &&
    (!approval.cluster || method.network === approval.cluster),
  );
  if (exact) return exact;
  return selectSupportedPaymentMethod(challenge, {
    ...(approval.cluster ? { expectedCluster: approval.cluster as MppCluster } : {}),
  });
}

function isMppApproval(approval: ApprovalRequestRecord): boolean {
  return approval.metadata?.connectorId === 'mpp' || approval.metadata?.actionSource === MPP_ACTION_SOURCE;
}

function stringFromMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function sessionFromContext(context: DevApiHandlerContext): WorkflowSession {
  if (!context.walletAddress) {
    throw new WorkflowValidationError('unauthorized', 'Wallet session is required.');
  }
  return { walletAddress: context.walletAddress };
}

function isMppPreferenceStore(store: unknown): store is MppPreferenceStore {
  if (!store || typeof store !== 'object') return false;
  return typeof (store as Record<string, unknown>).getPreference === 'function';
}

function normalizeApprovalForResponse(approval: ApprovalRequestRecord): JsonObject {
  return {
    id: approval.id,
    kind: approval.kind,
    status: approval.status,
    summary: approval.summary,
    amount: approval.amount ?? null,
    token: approval.token ?? null,
    recipient: approval.recipient ?? null,
    cluster: approval.cluster ?? null,
    dueAt: approval.dueAt,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    txid: approval.txid ?? null,
    txStatus: approval.txStatus ?? null,
    metadata: (approval.metadata ?? {}) as JsonObject,
    params: approval.params,
  } as JsonObject;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_JSON_BYTES) {
      throw new JsonBodyError(413, 'body_too_large', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new JsonBodyError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
}

function writeMppError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof JsonBodyError) {
    writeJsonNoStore(req, res, err.status, { error: err.code, message: err.message });
    return;
  }
  if (err instanceof WorkflowValidationError) {
    writeJsonNoStore(req, res, 400, { error: err.code, message: err.message, path: err.path });
    return;
  }
  if (err instanceof MppParseError || err instanceof MppVerifyError || err instanceof MppReceiptError) {
    writeJsonNoStore(req, res, 400, { error: `mpp_error:${err.code}`, message: err.message, path: err.path });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected MPP API error.';
  writeJsonNoStore(req, res, 500, { error: 'internal_error', message });
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

const mppHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'HEAD', 'POST'],
  handle: handleMppRequest,
};

registerDevApiHandler(mppHandler);
