import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseTokenAmountToBaseUnits } from '@solana-agent-wallet-adapter/streaming-sessions';
import {
  MppParseError,
  MppReceiptError,
  MPP_PAYMENT_RECEIPT_SCHEMA,
  MppVerifyError,
  buildMppPaymentReceipt,
  canonicalChallengeHash,
  challengeToApprovalParams,
  parseMppPaymentReceipt,
  parseMppChallenge,
  selectSupportedPaymentMethod,
  toJsonObject,
  verifyMppChallenge,
  verifyMppPaymentReceiptHash,
  type JsonObject,
  type MppChallenge,
  type MppCluster,
  type MppPaymentMethod,
  type MppPaymentRail,
  type MppReceipt,
} from '@solana-agent-wallet-adapter/mpp-adapter';
import {
  WorkflowValidationError,
  type ApprovalRequestRecord,
  type EvidenceReceiptRecord,
  type MppSessionPaymentFinality,
  type MppSessionPaymentLink,
  type WorkflowCluster,
  type WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';
import { redactSecrets } from './redaction.js';
import {
  EvidenceService,
  EvidenceServiceError,
} from './evidenceService.js';
import {
  StreamingService,
  StreamingServiceError,
  remainingFor,
  streamingStoreFor,
  type StoredStreamingSession,
} from './streamingService.js';

const PREFIX = '/api/mpp/';
const CHALLENGE_PATH = '/api/mpp/challenge';
const SETTLE_PATH = '/api/mpp/settle';
const CONFIG_PATH = '/api/mpp/config';
const INBOUND_PATH = '/api/mpp/inbound';
const SESSION_PAY_PATH = '/api/mpp/session-pay';
const MAX_JSON_BYTES = 64 * 1024;
const MPP_CONFIG_NAMESPACE = 'mpp-config';
const MPP_ACTION_SOURCE = 'mpp_challenge';
const MPP_EVIDENCE_KIND = 'mpp_session';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_TOKEN_DECIMALS = 6;
const MPP_SESSION_PAYMENT_METADATA_KEY = 'mppSessionPayment';

interface MppConfig {
  acceptedRails: string[];
  maxChallengeAmount?: string;
  endpoint?: string;
  allowedMints?: string[];
}

interface MppSignedEvidenceInput {
  signingMessage: string;
  signature: string;
  signatureEncoding?: 'base58';
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

interface MppSessionEligibility {
  eligible: boolean;
  finality: MppSessionPaymentFinality;
  reason?: string;
  reasonCode?: string;
  session?: JsonObject;
  paymentMethod?: JsonObject;
}

interface ParsedSessionPayBody {
  approvalId: string;
  sessionId?: string;
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
    url.pathname !== CONFIG_PATH &&
    url.pathname !== INBOUND_PATH &&
    url.pathname !== SESSION_PAY_PATH
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

    if (url.pathname === INBOUND_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJsonNoStore(req, res, 405, { error: 'method_not_allowed' });
        return true;
      }
      await handleGetInbound(req, res, ctx);
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
    if (url.pathname === SESSION_PAY_PATH) {
      await handlePostSessionPay(req, res, ctx);
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
  const paymentPolicy = paymentPolicyForConfig(config);
  const verified = verifyMppChallenge(requested.challenge, {
    clockNow: context.clock.now(),
    ...(expectedCluster ? { expectedCluster } : {}),
    ...(config.maxChallengeAmount ? { maxAmount: config.maxChallengeAmount } : {}),
    allowedRails: paymentPolicy.allowedRails,
    ...(paymentPolicy.allowedMints.length ? { allowedMints: paymentPolicy.allowedMints } : {}),
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

async function handleGetInbound(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  const session = sessionFromContext(context);
  const approvals = (await context.workflowStore.listApprovals(session.walletAddress))
    .filter(isMppApproval)
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''));
  const inbound = await Promise.all(approvals.map(async (approval) => {
    const normalized = normalizeApprovalForResponse(approval);
    const metadata = normalized.metadata && typeof normalized.metadata === 'object' && !Array.isArray(normalized.metadata)
      ? normalized.metadata as JsonObject
      : {};
    return {
      ...normalized,
      metadata: {
        ...metadata,
        mppSessionEligibility: await safeSessionEligibility(context, session.walletAddress, approval),
      },
    };
  }));
  writeJsonNoStore(req, res, 200, { inbound, items: inbound });
}

async function handlePostSessionPay(
  req: IncomingMessage,
  res: ServerResponse,
  context: DevApiHandlerContext,
): Promise<void> {
  const workflowSession = sessionFromContext(context);
  const body = await readJsonBody(req);
  const pay = parseSessionPayBody(body);
  const approval = await context.workflowStore.getApproval(workflowSession.walletAddress, pay.approvalId);
  if (!approval || !isMppApproval(approval)) {
    writeJsonNoStore(req, res, 404, { error: 'approval_not_found' });
    return;
  }

  const existing = sessionPaymentLinkFromMetadata(approval.metadata);
  if (existing) {
    writeJsonNoStore(req, res, 200, {
      approvalId: approval.id,
      sessionPayment: existing,
      approval: normalizeApprovalForResponse(approval),
      idempotent: true,
    });
    return;
  }

  const challenge = extractMppChallengeFromApproval(approval);
  if (!challenge) {
    writeJsonNoStore(req, res, 409, {
      error: 'missing_challenge',
      message: 'Approval is missing its source MPP challenge; cannot pay with a session.',
    });
    return;
  }
  const paymentMethod = paymentMethodForApproval(challenge, approval);
  const finality = sessionFinalityForChallenge(challenge);
  const challengeHash = stringFromMetadata(approval.metadata, 'mppChallengeHash') ?? canonicalChallengeHash(challenge);

  const streaming = new StreamingService(streamingStoreFor(context.workflowStore), { clock: context.clock });
  const match = await findSessionPaymentMatch({
    streaming,
    walletAddress: workflowSession.walletAddress,
    approval,
    challenge,
    paymentMethod,
    ...(pay.sessionId ? { sessionId: pay.sessionId } : {}),
  });
  if (!match.eligible || !match.selectedSession) {
    writeJsonNoStore(req, res, 409, {
      error: match.reasonCode ?? 'session_not_eligible',
      message: match.reason ?? 'No active streaming session can satisfy this MPP challenge.',
      eligibility: match,
    });
    return;
  }

  const nowIso = context.clock.now().toISOString();
  const voucherMetadata = {
    connectorId: 'mpp',
    source: 'mpp_session_payment',
    mppChallenge: toJsonObject(challenge),
    mppPaymentMethod: toJsonObject(paymentMethod),
    [MPP_SESSION_PAYMENT_METADATA_KEY]: {
      approvalId: approval.id,
      challengeHash,
      finality,
      status: finality === 'voucher_accepted' ? 'voucher_accepted' : 'settlement_pending',
      resourceUrl: challenge.resourceUrl,
      nonce: challenge.nonce,
    },
  };
  const result = await streaming.signAndAcceptVoucher({
    walletAddress: workflowSession.walletAddress,
    sessionId: match.selectedSession.sessionId,
    amount: challenge.amount,
    recipient: paymentMethod.recipient,
    nonce: `mpp_${challengeHash.slice(0, 24)}`,
    issuedAt: nowIso,
    metadata: voucherMetadata,
  });
  const link: MppSessionPaymentLink = {
    approvalId: approval.id,
    challengeHash,
    sessionId: match.selectedSession.sessionId,
    voucherId: result.voucher.id,
    voucherHash: result.voucherHash,
    amount: challenge.amount,
    recipient: paymentMethod.recipient,
    tokenMint: paymentMethod.mint ?? '',
    cluster: (approval.cluster ?? paymentMethod.network) as WorkflowCluster,
    finality,
    status: finality === 'voucher_accepted' ? 'voucher_accepted' : 'settlement_pending',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  let receipt: MppReceipt | undefined;
  let evidenceRecord: EvidenceReceiptRecord | undefined;
  if (finality === 'voucher_accepted') {
    receipt = buildMppPaymentReceipt({
      challenge,
      credential: {
        kind: paymentMethod.kind,
        signature: result.voucherHash,
        payerWallet: workflowSession.walletAddress,
        settledAt: nowIso,
      },
      walletAddress: workflowSession.walletAddress,
      cluster: link.cluster as MppCluster,
      settledAt: nowIso,
      issuedAt: nowIso,
      paymentMethod,
    });
    evidenceRecord = buildMppEvidenceRecord({ receipt, approval, challenge, issuedAt: nowIso });
    await context.evidenceStore.saveEvidence(workflowSession.walletAddress, evidenceRecord);
    await context.evidenceStore.appendEvidenceAuditEvent(workflowSession.walletAddress, {
      id: `audit_${randomUUID()}`,
      walletAddress: workflowSession.walletAddress,
      type: 'mpp.session_payment.receipt.created',
      recordType: 'evidence',
      recordId: evidenceRecord.id,
      createdAt: nowIso,
      metadata: {
        approvalId: approval.id,
        sessionId: link.sessionId,
        voucherId: link.voucherId,
        voucherHash: link.voucherHash,
        receiptId: receipt.receiptId,
        receiptHash: receipt.artifactHash,
        challengeHash,
      },
    });
    link.receiptId = evidenceRecord.id;
    link.receiptHash = receipt.artifactHash;
  }

  const updated: ApprovalRequestRecord = {
    ...approval,
    status: finality === 'voucher_accepted' ? 'approved' : 'approval_pending',
    updatedAt: nowIso,
    ...(finality === 'voucher_accepted' ? { decidedAt: nowIso } : {}),
    metadata: {
      ...(approval.metadata ?? {}),
      [MPP_SESSION_PAYMENT_METADATA_KEY]: toJsonObject(link),
      ...(receipt ? {
        mppPaymentReceipt: toJsonObject(receipt),
        mppPaymentReceiptIssuedAt: nowIso,
        mppEvidenceReceiptId: evidenceRecord?.id ?? '',
      } : {}),
    },
  };
  await context.workflowStore.saveApproval(workflowSession.walletAddress, updated);
  await context.workflowStore.appendAuditEvent(workflowSession.walletAddress, {
    id: `audit_${randomUUID()}`,
    walletAddress: workflowSession.walletAddress,
    type: 'mpp.session_payment.voucher_accepted',
    actor: 'server',
    recordType: 'approval',
    recordId: approval.id,
    createdAt: nowIso,
    metadata: {
      approvalId: approval.id,
      sessionId: link.sessionId,
      voucherId: link.voucherId,
      voucherHash: link.voucherHash,
      challengeHash,
      finality,
      status: link.status,
    },
  });

  writeJsonNoStore(req, res, 200, {
    approvalId: approval.id,
    accepted: true,
    finality,
    status: link.status,
    remaining: result.remaining,
    spentAmount: result.spentAmount,
    sessionPayment: link,
    voucher: result.voucher,
    signedVoucher: result.voucher.voucher,
    ...(receipt ? { receipt, receiptId: evidenceRecord?.id, receiptHash: receipt.artifactHash } : {}),
    approval: normalizeApprovalForResponse(updated),
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
      const receipt = parseStoredMppReceipt(existing.payload);
      const signedEvidence = await maybeCreateOrLoadSignedMppEvidence({
        context,
        session,
        approval,
        receipt,
        signedEvidence: settle.signedEvidence,
      });
      writeJsonNoStore(req, res, 200, {
        receiptId: existing.id,
        receiptHash: existing.artifactHash,
        receipt: existing.payload,
        approvalId: approval.id,
        idempotent: true,
        signedEvidence,
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

  const signedEvidence = await maybeCreateOrLoadSignedMppEvidence({
    context,
    session,
    approval: {
      ...approval,
      metadata: {
        ...(approval.metadata ?? {}),
        mppEvidenceReceiptId: evidenceRecord.id,
      },
    },
    receipt,
    signedEvidence: settle.signedEvidence,
  });

  await context.workflowStore.saveApproval(session.walletAddress, {
    ...approval,
    metadata: {
      ...(approval.metadata ?? {}),
      mppPaymentReceipt: toJsonObject(receipt),
      mppPaymentReceiptIssuedAt: issuedAt,
      mppEvidenceReceiptId: evidenceRecord.id,
      ...(signedEvidence.status === 'created' || signedEvidence.status === 'exists'
        ? { mppSignedEvidenceReceiptId: signedEvidence.receiptId }
        : {}),
    },
    updatedAt: issuedAt,
  });

  writeJsonNoStore(req, res, 201, {
    receiptId: evidenceRecord.id,
    receiptHash: receipt.artifactHash,
    receipt,
    approvalId: approval.id,
    signedEvidence,
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

function paymentPolicyForConfig(config: MppConfig): { allowedRails: MppPaymentRail[]; allowedMints: string[] } {
  const rails = new Set<MppPaymentRail>();
  const mints = new Set<string>(config.allowedMints ?? []);
  for (const rail of config.acceptedRails) {
    const normalized = rail.trim().toLowerCase();
    if (normalized === 'sol' || normalized === 'solana-sol') {
      rails.add('solana-sol');
      continue;
    }
    if (normalized === 'usdc') {
      rails.add('solana-spl');
      mints.add(USDC_MINT);
      continue;
    }
    if (normalized === 'spl' || normalized === 'solana-spl') {
      rails.add('solana-spl');
      continue;
    }
    const trimmed = rail.trim();
    if (trimmed.length >= 32 && trimmed.length <= 64) {
      rails.add('solana-spl');
      mints.add(trimmed);
    }
  }
  if (mints.size > 0) {
    rails.add('solana-spl');
  }
  return { allowedRails: [...rails], allowedMints: [...mints] };
}

function parseSettleBody(body: unknown): { approvalId: string; txid: string; settledAt?: string; signedEvidence?: MppSignedEvidenceInput } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowValidationError('invalid_object', '$ must be a JSON object.', '$');
  }
  const record = body as Record<string, unknown>;
  const approvalId = shortString(record.approvalId, '$.approvalId', 160);
  const txid = shortString(record.txid, '$.txid', 256);
  const signedEvidence = parseSignedEvidence(record.signedEvidence);
  const settledAtRaw = record.settledAt;
  if (settledAtRaw === undefined || settledAtRaw === null || settledAtRaw === '') {
    return {
      approvalId,
      txid,
      ...(signedEvidence ? { signedEvidence } : {}),
    };
  }
  if (typeof settledAtRaw !== 'string' || Number.isNaN(Date.parse(settledAtRaw))) {
    throw new WorkflowValidationError('invalid_timestamp', 'settledAt must be an ISO-8601 timestamp.', '$.settledAt');
  }
  return {
    approvalId,
    txid,
    settledAt: settledAtRaw,
    ...(signedEvidence ? { signedEvidence } : {}),
  };
}

function parseSessionPayBody(body: unknown): ParsedSessionPayBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowValidationError('invalid_object', '$ must be a JSON object.', '$');
  }
  const record = body as Record<string, unknown>;
  const approvalId = shortString(record.approvalId, '$.approvalId', 160);
  const rawSessionId = record.sessionId;
  return {
    approvalId,
    ...(rawSessionId === undefined || rawSessionId === null || rawSessionId === ''
      ? {}
      : { sessionId: shortString(rawSessionId, '$.sessionId', 160) }),
  };
}

function parseSignedEvidence(value: unknown): MppSignedEvidenceInput | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_signed_evidence', 'signedEvidence must be a JSON object.', '$.signedEvidence');
  }
  const record = value as Record<string, unknown>;
  const signingMessage = shortString(record.signingMessage, '$.signedEvidence.signingMessage', 2_048);
  const signature = shortString(record.signature, '$.signedEvidence.signature', 1_024);
  const encodingRaw = record.signatureEncoding;
  if (encodingRaw !== undefined && encodingRaw !== null && encodingRaw !== '' && encodingRaw !== 'base58') {
    throw new WorkflowValidationError('invalid_signature_encoding', 'signedEvidence.signatureEncoding must be "base58".', '$.signedEvidence.signatureEncoding');
  }
  return {
    signingMessage,
    signature,
    ...(encodingRaw === 'base58' ? { signatureEncoding: 'base58' } : {}),
  };
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
    payload: toJsonObject(receipt),
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

async function maybeCreateOrLoadSignedMppEvidence(input: {
  context: DevApiHandlerContext;
  session: WorkflowSession;
  approval: ApprovalRequestRecord;
  receipt: MppReceipt;
  signedEvidence?: MppSignedEvidenceInput;
}): Promise<JsonObject> {
  const { context, session, approval, receipt, signedEvidence } = input;
  const existingSignedId = stringFromMetadata(approval.metadata, 'mppSignedEvidenceReceiptId');
  if (existingSignedId) {
    const existing = await context.evidenceStore.getEvidence(session.walletAddress, existingSignedId);
    if (existing) {
      return {
        status: 'exists',
        receiptId: existing.id,
        receiptHash: existing.artifactHash,
        signingMessage: existing.signingMessage,
        preSignatureHash: existing.preSignatureHash,
      };
    }
  }

  const signingMessage = signedMppEvidenceMessage(approval.id, receipt);
  const available = {
    status: 'available',
    signingMessage,
    preSignatureHash: receipt.artifactHash,
  };
  if (!signedEvidence) return available;
  if (signedEvidence.signingMessage !== signingMessage) {
    throw new WorkflowValidationError(
      'invalid_signed_evidence_message',
      'signedEvidence.signingMessage does not match the MPP receipt.',
      '$.signedEvidence.signingMessage',
    );
  }

  const merchant = receipt.merchant?.name ?? receipt.merchant?.id ?? receipt.recipient;
  const service = new EvidenceService(context.evidenceStore, { clock: () => context.clock.now() });
  const record = await service.createReceipt(session, {
    title: `Signed MPP Payment: ${merchant}`,
    kind: MPP_EVIDENCE_KIND,
    status: 'approved',
    payload: toJsonObject(receipt),
    preSignatureHash: receipt.artifactHash,
    artifactHash: receipt.artifactHash,
    signingMessage,
    signature: signedEvidence.signature,
    cluster: (approval.cluster ?? receipt.cluster) as WorkflowCluster,
    receiptType: MPP_PAYMENT_RECEIPT_SCHEMA,
    summary: `Wallet-signed receipt for ${receipt.amount} ${receipt.currency} paid to ${merchant} via MPP.`,
    metadata: {
      approvalId: approval.id,
      txid: receipt.txid ?? '',
      receiptId: receipt.receiptId,
      receiptHash: receipt.artifactHash,
      challengeHash: receipt.challengeHash,
      nonce: receipt.nonce,
      resourceUrl: receipt.resourceUrl,
      signatureEncoding: signedEvidence.signatureEncoding ?? 'base58',
      evidenceMode: 'wallet_signed',
    },
  });

  await context.workflowStore.saveApproval(session.walletAddress, {
    ...approval,
    metadata: {
      ...(approval.metadata ?? {}),
      mppSignedEvidenceReceiptId: record.id,
    },
    updatedAt: context.clock.now().toISOString(),
  });

  return {
    status: 'created',
    receiptId: record.id,
    receiptHash: record.artifactHash,
    signingMessage: record.signingMessage,
    preSignatureHash: record.preSignatureHash,
  };
}

function signedMppEvidenceMessage(approvalId: string, receipt: MppReceipt): string {
  return `mpp-payment-receipt:${approvalId}:${receipt.artifactHash}`;
}

function parseStoredMppReceipt(payload: unknown): MppReceipt {
  const receipt = parseMppPaymentReceipt(payload);
  if (!verifyMppPaymentReceiptHash(receipt)) {
    throw new MppReceiptError('receipt_hash_mismatch', 'Stored MPP receipt hash does not verify.', '$.artifactHash');
  }
  return receipt;
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

async function safeSessionEligibility(
  context: DevApiHandlerContext,
  walletAddress: string,
  approval: ApprovalRequestRecord,
): Promise<MppSessionEligibility> {
  try {
    const challenge = extractMppChallengeFromApproval(approval);
    if (!challenge) {
      return ineligible('missing_challenge', 'Approval is missing its source MPP challenge.', 'voucher_accepted');
    }
    const paymentMethod = paymentMethodForApproval(challenge, approval);
    const streaming = new StreamingService(streamingStoreFor(context.workflowStore), { clock: context.clock });
    return findSessionPaymentMatch({
      streaming,
      walletAddress,
      approval,
      challenge,
      paymentMethod,
    });
  } catch (err) {
    return ineligible(
      'eligibility_error',
      err instanceof Error ? redactSecrets(err.message) : 'Could not evaluate session eligibility.',
      'voucher_accepted',
    );
  }
}

async function findSessionPaymentMatch(input: {
  streaming: StreamingService;
  walletAddress: string;
  approval: ApprovalRequestRecord;
  challenge: MppChallenge;
  paymentMethod: MppPaymentMethod;
  sessionId?: string;
}): Promise<MppSessionEligibility & { selectedSession?: StoredStreamingSession }> {
  const finality = sessionFinalityForChallenge(input.challenge);
  const method = input.paymentMethod;
  if (method.kind !== 'solana-spl' || !method.mint) {
    return ineligible(
      'unsupported_rail',
      'Streaming sessions can only satisfy SPL-token MPP challenges; native SOL must use the one-time approval path.',
      finality,
      method,
    );
  }
  const sessions = await input.streaming.listSessions({
    walletAddress: input.walletAddress,
    status: 'active',
  });
  if (input.sessionId && !sessions.some((session) => session.sessionId === input.sessionId)) {
    return ineligible('session_not_found', 'The selected streaming session is not active for this wallet.', finality, method);
  }
  const candidates = input.sessionId
    ? sessions.filter((session) => session.sessionId === input.sessionId)
    : sessions;
  if (candidates.length === 0) {
    return ineligible('no_active_session', 'Create and sign an active streaming session before paying this MPP challenge with a session.', finality, method);
  }
  const reasons: MppSessionEligibility[] = [];
  for (const session of candidates) {
    const evaluated = evaluateSessionForPayment(session, input.challenge, method, finality);
    if (evaluated.eligible) return { ...evaluated, selectedSession: session };
    reasons.push(evaluated);
  }
  return reasons[0] ?? ineligible('no_matching_session', 'No active streaming session matches this MPP challenge.', finality, method);
}

function evaluateSessionForPayment(
  session: StoredStreamingSession,
  challenge: MppChallenge,
  paymentMethod: MppPaymentMethod,
  finality: MppSessionPaymentFinality,
): MppSessionEligibility {
  if (session.cluster !== paymentMethod.network) {
    return sessionIneligible(session, finality, paymentMethod, 'cluster_mismatch', 'Session cluster does not match the MPP challenge network.');
  }
  if (session.tokenMint !== paymentMethod.mint) {
    return sessionIneligible(session, finality, paymentMethod, 'mint_mismatch', 'Session token mint does not match the MPP challenge mint.');
  }
  const allowlist = session.recipientAllowlist ?? [];
  if (allowlist.length > 0 && !allowlist.includes(paymentMethod.recipient)) {
    return sessionIneligible(session, finality, paymentMethod, 'recipient_not_allowed', 'The MPP recipient is outside the session recipient allowlist.');
  }
  const decimals = session.tokenDecimals ?? DEFAULT_TOKEN_DECIMALS;
  const remaining = remainingFor(session);
  const requested = parseTokenAmountToBaseUnits(challenge.amount, decimals, { field: 'amount' });
  const available = parseTokenAmountToBaseUnits(remaining, decimals, { allowZero: true, field: 'remaining' });
  if (requested > available) {
    return sessionIneligible(session, finality, paymentMethod, 'cap_exceeded', 'MPP amount exceeds the remaining session cap.');
  }
  return {
    eligible: true,
    finality,
    session: sessionEligibilitySnapshot(session, remaining),
    paymentMethod: toJsonObject(paymentMethod),
  };
}

function sessionIneligible(
  session: StoredStreamingSession,
  finality: MppSessionPaymentFinality,
  paymentMethod: MppPaymentMethod,
  reasonCode: string,
  reason: string,
): MppSessionEligibility {
  return {
    eligible: false,
    finality,
    reasonCode,
    reason,
    session: sessionEligibilitySnapshot(session, remainingFor(session)),
    paymentMethod: toJsonObject(paymentMethod),
  };
}

function ineligible(
  reasonCode: string,
  reason: string,
  finality: MppSessionPaymentFinality,
  paymentMethod?: MppPaymentMethod,
): MppSessionEligibility {
  return {
    eligible: false,
    finality,
    reasonCode,
    reason,
    ...(paymentMethod ? { paymentMethod: toJsonObject(paymentMethod) } : {}),
  };
}

function sessionEligibilitySnapshot(session: StoredStreamingSession, remaining: string): JsonObject {
  return {
    sessionId: session.sessionId,
    status: session.status,
    cluster: session.cluster,
    tokenMint: session.tokenMint,
    capAmount: session.capAmount,
    spentAmount: session.spentAmount,
    remaining,
    expiresAt: session.expiresAt,
    ...(session.recipientAllowlist?.length ? { recipientAllowlist: [...session.recipientAllowlist] } : {}),
  };
}

function sessionFinalityForChallenge(challenge: MppChallenge): MppSessionPaymentFinality {
  return challenge.metadata?.requiredFinality === 'settlement_confirmed'
    ? 'settlement_confirmed'
    : 'voucher_accepted';
}

function sessionPaymentLinkFromMetadata(metadata: JsonObject | undefined): JsonObject | undefined {
  const value = metadata?.[MPP_SESSION_PAYMENT_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
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
  // Phase 5.7 — every error message reaching the wire goes through
  // redactSecrets() so a stray RPC error or a wrapped EvidenceService error
  // can't leak fragments of API keys, JWTs, or other tokens that may have
  // been logged earlier in the chain.
  if (err instanceof JsonBodyError) {
    writeJsonNoStore(req, res, err.status, { error: err.code, message: redactSecrets(err.message) });
    return;
  }
  if (err instanceof WorkflowValidationError) {
    writeJsonNoStore(req, res, 400, { error: err.code, message: redactSecrets(err.message), path: err.path });
    return;
  }
  if (err instanceof StreamingServiceError) {
    writeJsonNoStore(req, res, err.status, { error: err.code, message: redactSecrets(err.message) });
    return;
  }
  if (err instanceof MppParseError || err instanceof MppVerifyError || err instanceof MppReceiptError) {
    writeJsonNoStore(req, res, 400, { error: `mpp_error:${err.code}`, message: redactSecrets(err.message), path: err.path });
    return;
  }
  if (err instanceof EvidenceServiceError) {
    writeJsonNoStore(req, res, err.status, { error: err.code, message: redactSecrets(err.message) });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected MPP API error.';
  writeJsonNoStore(req, res, 500, { error: 'internal_error', message: redactSecrets(message) });
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
