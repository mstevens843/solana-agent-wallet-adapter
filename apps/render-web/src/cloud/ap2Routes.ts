import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Ap2ParseError,
  Ap2VerifyError,
  buildAp2InboundReceipt,
  mandateToApprovalParams,
  parseAp2Mandate,
  paymentDetailsFor,
  verifyAp2Mandate,
  type Ap2Cluster,
  type Ap2InboundApprovalParams,
  type Ap2InboundReceipt,
  type Ap2Mandate,
  type Ap2VerifiedAgent,
} from '@solana-agent-wallet-adapter/ap2-adapter';
import {
  WorkflowValidationError,
  type ApprovalRequestRecord,
  type JsonObject,
  type WorkflowCluster,
  type WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';

import { registerDevApiHandler, type DevApiHandlerContext } from './devApiRegistry.js';
import {
  type EvidenceAuditEvent,
  type EvidenceReceiptRecord,
  type EvidenceStore,
} from './evidenceService.js';
import type { Clock, WorkflowStore as SessionWorkflowStore } from './store.js';
import type { WorkflowService, WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';

export const AP2_INBOUND_ACTION_SOURCE = 'ap2_inbound';
export const AP2_EVIDENCE_KIND = 'ap2_inbound';

const PREFIX = '/api/ap2/';
const INBOUND_COLLECTION = '/api/ap2/inbound';
const INBOUND_ITEM_PATTERN = /^\/api\/ap2\/inbound\/([^/]+?)(?:\/receipt)?\/?$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 50;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const AP2_CLUSTERS: readonly Ap2Cluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];
const AP2_APPROVAL_KINDS = new Set(['transfer_sol', 'transfer_spl']);

type Ap2Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type SessionResolver = (
  req: IncomingMessage,
) => Promise<WorkflowSession | null | undefined> | WorkflowSession | null | undefined;

export interface Ap2RouteAdapter {
  validateInboundRequest: (body: unknown) => { mandate: Ap2Mandate; cluster?: Ap2Cluster; receivedAt: string };
  verifyMandate: (
    mandate: Ap2Mandate,
    opts: { clockNow: Date; expectedRecipient: string; expectedCluster?: Ap2Cluster },
  ) => { verified: true; agent: Ap2VerifiedAgent };
  mandateToApprovalParams: (
    mandate: Ap2Mandate,
    agent: Ap2VerifiedAgent,
    walletAddress: string,
  ) => Ap2InboundApprovalParams;
  buildAp2InboundReceipt: (input: {
    mandate: Ap2Mandate;
    agent: Ap2VerifiedAgent;
    approval: { id: string; kind: 'transfer_sol' | 'transfer_spl' };
    txid: string;
    walletAddress: string;
    cluster: Ap2Cluster;
    finalizedAt?: string;
    issuedAt?: string;
  }) => Ap2InboundReceipt;
}

export interface Ap2RouteContext {
  workflowService: WorkflowService;
  workflowStore: SessionWorkflowStore & OneTimeWorkflowStore;
  evidenceStore: EvidenceStore;
  clock: Clock;
  getSession: SessionResolver;
  idFactory?: () => string;
  evidenceIdFactory?: () => string;
  adapter?: Ap2RouteAdapter;
}

export interface InboundMandate {
  inboundId: string;
  approvalId: string;
  mandateSource: { agentId: string; agentLabel: string };
  amount: number | string;
  tokenMint: string;
  memo?: string;
  createdAt: string;
  approvalStatus: string;
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

const defaultAdapter: Ap2RouteAdapter = {
  validateInboundRequest(body) {
    return DevLayer1.ap2.validateCreateAp2InboundRequest(body);
  },
  verifyMandate(mandate, opts) {
    return verifyAp2Mandate(mandate, opts);
  },
  mandateToApprovalParams,
  buildAp2InboundReceipt,
};

export function createAp2ApiHandler(context: Ap2RouteContext): Ap2Handler {
  const adapter = context.adapter ?? defaultAdapter;
  const idFactory = context.idFactory ?? (() => randomUUID());
  const evidenceIdFactory = context.evidenceIdFactory ?? (() => randomUUID());

  return async function ap2RouteDispatch(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith(PREFIX)) return false;
    if (!url.pathname.startsWith(INBOUND_COLLECTION)) {
      writeJson(res, 404, { error: 'not_found' });
      return true;
    }

    const session = await context.getSession(req);
    if (!session?.walletAddress) {
      writeJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      if (url.pathname === INBOUND_COLLECTION || url.pathname === `${INBOUND_COLLECTION}/`) {
        if (req.method === 'POST') {
          await handlePostInbound(req, res, context, adapter, idFactory, session);
          return true;
        }
        if (req.method === 'GET') {
          await handleGetInboundList(res, context, session);
          return true;
        }
        writeJson(res, 405, { error: 'method_not_allowed' });
        return true;
      }

      const match = INBOUND_ITEM_PATTERN.exec(url.pathname);
      if (!match) {
        writeJson(res, 404, { error: 'not_found' });
        return true;
      }
      const inboundId = decodeURIComponent(match[1] as string);
      const isReceiptPath = /\/receipt\/?$/.test(url.pathname);

      if (isReceiptPath) {
        if (req.method === 'POST') {
          await handlePostReceipt(
            req,
            res,
            context,
            adapter,
            idFactory,
            evidenceIdFactory,
            session,
            inboundId,
          );
          return true;
        }
        if (req.method === 'GET') {
          await handleGetReceipt(res, context, session, inboundId);
          return true;
        }
        writeJson(res, 405, { error: 'method_not_allowed' });
        return true;
      }

      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'method_not_allowed' });
        return true;
      }
      await handleGetInbound(res, context, session, inboundId);
      return true;
    } catch (err) {
      if (err instanceof JsonBodyError) {
        writeJson(res, err.status, { error: err.code, message: err.message });
        return true;
      }
      const message = err instanceof Error ? err.message : 'Unexpected server error.';
      writeJson(res, 500, { error: 'internal_error', message });
      return true;
    }
  };
}

async function handlePostInbound(
  req: IncomingMessage,
  res: ServerResponse,
  context: Ap2RouteContext,
  adapter: Ap2RouteAdapter,
  idFactory: () => string,
  session: WorkflowSession,
): Promise<void> {
  const raw = await readJsonBody(req);

  let validated: { mandate: Ap2Mandate; cluster?: Ap2Cluster; receivedAt: string };
  try {
    validated = adapter.validateInboundRequest(raw);
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      writeJson(res, 400, { error: err.code, message: err.message, path: err.path });
      return;
    }
    if (err instanceof Ap2ParseError) {
      writeJson(res, 400, { error: `invalid_mandate:${err.code}`, message: err.message, path: err.path });
      return;
    }
    const message = err instanceof Error ? err.message : 'Invalid AP2 inbound request.';
    writeJson(res, 400, { error: 'invalid_mandate_schema', message });
    return;
  }

  const mandate = validated.mandate;
  let verifiedAgent: Ap2VerifiedAgent;
  try {
    const result = adapter.verifyMandate(mandate, {
      clockNow: context.clock.now(),
      expectedRecipient: session.walletAddress,
      ...(validated.cluster ? { expectedCluster: validated.cluster } : {}),
    });
    verifiedAgent = result.agent;
  } catch (err) {
    if (err instanceof Ap2VerifyError) {
      writeJson(res, 400, { error: `invalid_mandate_signature:${err.code}`, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'AP2 mandate signature could not be verified.';
    writeJson(res, 400, { error: 'invalid_mandate_signature', message });
    return;
  }

  const approvalParams = adapter.mandateToApprovalParams(mandate, verifiedAgent, session.walletAddress);
  const now = context.clock.now();
  const dueAt = new Date(now.getTime() + APPROVAL_TTL_MS).toISOString();
  // Workflow guardrails require `recipient`/`token`/`amount` keys on `params`
  // for transfer_sol and transfer_spl kinds. The AP2 mapper emits these on top-level
  // fields plus the protocol-shaped params (toAddress/tokenSymbol). Mirror the
  // guardrail-expected keys into params without dropping the AP2 keys.
  const guardrailFriendlyParams: JsonObject = {
    ...approvalParams.params,
    recipient: approvalParams.recipient,
    token: approvalParams.token,
    amount: approvalParams.amount,
  };
  // Pass the mapper's metadata through unmodified; the UI badge contract reads
  // `ap2VerifiedAgent: { ..., verified: true }` from the approval metadata.
  const cluster: Ap2Cluster = validated.cluster ?? approvalParams.cluster;

  const approval = await context.workflowService.createApproval(session, {
    kind: approvalParams.kind,
    summary: approvalParams.summary,
    cluster: cluster as WorkflowCluster,
    amount: approvalParams.amount,
    token: approvalParams.token,
    recipient: approvalParams.recipient,
    dueAt,
    params: guardrailFriendlyParams,
    metadata: approvalParams.metadata,
  });

  await context.workflowStore.appendAuditEvent(session.walletAddress, {
    id: `audit_${idFactory()}`,
    walletAddress: session.walletAddress,
    type: 'ap2.inbound.created',
    actor: 'server',
    recordType: 'approval',
    recordId: approval.id,
    createdAt: now.toISOString(),
    metadata: {
      sourceAgentId: verifiedAgent.agentId,
      sourceAgentLabel: verifiedAgent.agentLabel,
      mandateId: mandate.mandateId,
      mandateType: mandate.mandateType,
      receivedAt: validated.receivedAt,
      cluster,
    },
  });

  writeJson(res, 201, {
    inboundId: approval.id,
    approvalId: approval.id,
    agent: verifiedAgent,
    approval: normalizeApprovalForResponse(approval),
  });
}

async function handleGetInboundList(
  res: ServerResponse,
  context: Ap2RouteContext,
  session: WorkflowSession,
): Promise<void> {
  const approvals = await context.workflowStore.listApprovals(session.walletAddress);
  const items = approvals
    .filter(isAp2InboundApproval)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_LIST_RESULTS)
    .map(mapApprovalToInboundMandate);
  writeJson(res, 200, { items });
}

async function handleGetInbound(
  res: ServerResponse,
  context: Ap2RouteContext,
  session: WorkflowSession,
  inboundId: string,
): Promise<void> {
  const approval = await context.workflowStore.getApproval(session.walletAddress, inboundId);
  if (!approval || !isAp2InboundApproval(approval)) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }
  writeJson(res, 200, {
    item: mapApprovalToInboundMandate(approval),
    approval: normalizeApprovalForResponse(approval),
  });
}

async function handlePostReceipt(
  req: IncomingMessage,
  res: ServerResponse,
  context: Ap2RouteContext,
  adapter: Ap2RouteAdapter,
  idFactory: () => string,
  evidenceIdFactory: () => string,
  session: WorkflowSession,
  inboundId: string,
): Promise<void> {
  await readJsonBody(req); // accept and discard optional body

  const approval = await context.workflowStore.getApproval(session.walletAddress, inboundId);
  if (!approval || !isAp2InboundApproval(approval)) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  // Idempotency: if a receipt already exists, return it without rebuilding.
  const existingId = stringFromMetadata(approval.metadata, 'ap2InboundReceiptId');
  if (existingId) {
    const existing = await context.evidenceStore.getEvidence(session.walletAddress, existingId);
    if (existing && isAp2InboundReceiptPayload(existing.payload)) {
      writeJson(res, 200, {
        receipt: existing.payload,
        evidenceId: existing.id,
        approvalId: approval.id,
        idempotent: true,
      });
      return;
    }
  }

  if (!AP2_APPROVAL_KINDS.has(approval.kind)) {
    writeJson(res, 409, {
      error: 'invalid_approval_kind',
      message: `AP2 inbound approvals must be transfer_sol or transfer_spl; got ${approval.kind}.`,
    });
    return;
  }

  const finalizations = await context.workflowService.listFinalizationsForApproval(session, inboundId);
  const confirmed = finalizations.find((finalization) => finalization.txid && finalization.status === 'confirmed');
  if (!confirmed?.txid) {
    writeJson(res, 409, { error: 'not_finalized', message: 'Approval has not yet been confirmed on-chain.' });
    return;
  }

  let mandate: Ap2Mandate;
  try {
    const extracted = extractMandateFromApproval(approval);
    if (!extracted) {
      writeJson(res, 409, {
        error: 'missing_mandate',
        message: 'Approval is missing its source AP2 mandate; cannot build receipt.',
      });
      return;
    }
    mandate = extracted;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stored AP2 mandate is malformed.';
    writeJson(res, 500, { error: 'corrupt_mandate', message });
    return;
  }

  const verifiedAgent = extractVerifiedAgentFromApproval(approval, mandate);
  const cluster: Ap2Cluster = resolveApprovalCluster(approval, mandate);
  const issuedAt = context.clock.now().toISOString();
  const finalizedAt = confirmed.confirmedAt ?? confirmed.updatedAt ?? confirmed.createdAt ?? issuedAt;

  const receipt = adapter.buildAp2InboundReceipt({
    mandate,
    agent: verifiedAgent,
    approval: { id: approval.id, kind: approval.kind as 'transfer_sol' | 'transfer_spl' },
    txid: confirmed.txid,
    walletAddress: session.walletAddress,
    cluster,
    finalizedAt,
    issuedAt,
  });

  const evidenceRecord = buildAp2EvidenceRecord({
    receipt,
    mandate,
    agent: verifiedAgent,
    approval,
    issuedAt,
    evidenceIdFactory,
  });
  await context.evidenceStore.saveEvidence(session.walletAddress, evidenceRecord);

  const evidenceAudit: EvidenceAuditEvent = {
    id: `audit_${idFactory()}`,
    walletAddress: session.walletAddress,
    type: 'ap2.inbound.receipt.created',
    recordType: 'evidence',
    recordId: evidenceRecord.id,
    createdAt: issuedAt,
    metadata: {
      approvalId: approval.id,
      mandateId: mandate.mandateId,
      mandateType: mandate.mandateType,
      txid: confirmed.txid,
      artifactHash: receipt.artifactHash,
      agentId: verifiedAgent.agentId,
      agentLabel: verifiedAgent.agentLabel,
    },
  };
  await context.evidenceStore.appendEvidenceAuditEvent(session.walletAddress, evidenceAudit);

  const updatedApproval: ApprovalRequestRecord = {
    ...approval,
    metadata: {
      ...(approval.metadata ?? {}),
      ap2InboundReceiptId: evidenceRecord.id,
      ap2InboundReceiptIssuedAt: issuedAt,
    },
    updatedAt: issuedAt,
  };
  await context.workflowStore.saveApproval(session.walletAddress, updatedApproval);

  writeJson(res, 201, {
    receipt,
    evidenceId: evidenceRecord.id,
    approvalId: approval.id,
  });
}

async function handleGetReceipt(
  res: ServerResponse,
  context: Ap2RouteContext,
  session: WorkflowSession,
  inboundId: string,
): Promise<void> {
  const approval = await context.workflowStore.getApproval(session.walletAddress, inboundId);
  if (!approval || !isAp2InboundApproval(approval)) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }
  const receiptId = stringFromMetadata(approval.metadata, 'ap2InboundReceiptId');
  if (!receiptId) {
    writeJson(res, 404, {
      error: 'receipt_not_built',
      message: 'AP2 inbound receipt has not yet been issued for this approval.',
    });
    return;
  }
  const record = await context.evidenceStore.getEvidence(session.walletAddress, receiptId);
  if (!record || !isAp2InboundReceiptPayload(record.payload)) {
    writeJson(res, 404, { error: 'receipt_not_built' });
    return;
  }
  writeJson(res, 200, {
    receipt: record.payload,
    evidenceId: record.id,
    approvalId: approval.id,
  });
}

function buildAp2EvidenceRecord(input: {
  receipt: Ap2InboundReceipt;
  mandate: Ap2Mandate;
  agent: Ap2VerifiedAgent;
  approval: ApprovalRequestRecord;
  issuedAt: string;
  evidenceIdFactory: () => string;
}): EvidenceReceiptRecord {
  const { receipt, mandate, agent, approval, issuedAt, evidenceIdFactory } = input;
  const txid = receipt.execution.txid;
  const payment = receipt.payment;
  return {
    id: `evidence_ap2_${evidenceIdFactory()}`,
    walletAddress: approval.walletAddress,
    ...(approval.cluster ? { cluster: approval.cluster } : {}),
    title: `AP2 Inbound: ${agent.agentLabel}`,
    kind: AP2_EVIDENCE_KIND,
    status: 'approved',
    payload: receipt as unknown as JsonObject,
    preSignatureHash: receipt.artifactHash,
    signingMessage: `ap2-inbound:${mandate.mandateId}@${txid}`,
    signature: txid,
    verified: true,
    artifactHash: receipt.artifactHash,
    createdAt: issuedAt,
    updatedAt: issuedAt,
    receiptType: AP2_EVIDENCE_KIND,
    summary: `${payment.amount} ${payment.tokenSymbol} from ${agent.agentLabel} settled in ${txid.slice(0, 8)}…`,
    metadata: {
      approvalId: approval.id,
      mandateId: mandate.mandateId,
      mandateType: mandate.mandateType,
      txid,
      agentId: agent.agentId,
      agentLabel: agent.agentLabel,
    },
  };
}

function mapApprovalToInboundMandate(approval: ApprovalRequestRecord): InboundMandate {
  const agentMeta = approval.metadata?.ap2VerifiedAgent;
  const agentSource =
    agentMeta && typeof agentMeta === 'object' && !Array.isArray(agentMeta)
      ? (agentMeta as Record<string, unknown>)
      : {};
  const proposal = approval.metadata?.actionProposal;
  const proposalObj =
    proposal && typeof proposal === 'object' && !Array.isArray(proposal)
      ? (proposal as Record<string, unknown>)
      : {};
  const intentObj =
    proposalObj.intent && typeof proposalObj.intent === 'object'
      ? (proposalObj.intent as { cap?: { tokenMint?: unknown } })
      : undefined;
  const paymentObj =
    proposalObj.payment && typeof proposalObj.payment === 'object'
      ? (proposalObj.payment as { tokenMint?: unknown })
      : undefined;
  const tokenMintFromProposal =
    typeof intentObj?.cap?.tokenMint === 'string'
      ? intentObj.cap.tokenMint
      : typeof paymentObj?.tokenMint === 'string'
        ? paymentObj.tokenMint
        : undefined;
  const tokenMintFromParams =
    approval.params && typeof approval.params === 'object'
      ? (approval.params as Record<string, unknown>).tokenMint
      : undefined;
  const memo =
    approval.params && typeof approval.params === 'object'
      ? (approval.params as Record<string, unknown>).memo
      : undefined;
  const item: InboundMandate = {
    inboundId: approval.id,
    approvalId: approval.id,
    mandateSource: {
      agentId: typeof agentSource.agentId === 'string' ? agentSource.agentId : '',
      agentLabel: typeof agentSource.agentLabel === 'string' ? agentSource.agentLabel : '',
    },
    amount: approval.amount ?? '',
    tokenMint:
      typeof tokenMintFromProposal === 'string'
        ? tokenMintFromProposal
        : typeof tokenMintFromParams === 'string'
          ? tokenMintFromParams
          : '',
    createdAt: approval.createdAt,
    approvalStatus: approval.status,
  };
  if (typeof memo === 'string') {
    item.memo = memo;
  }
  return item;
}

function isAp2InboundApproval(approval: ApprovalRequestRecord): boolean {
  const source = approval.metadata?.actionSource;
  return typeof source === 'string' && source === AP2_INBOUND_ACTION_SOURCE;
}

function extractMandateFromApproval(approval: ApprovalRequestRecord): Ap2Mandate | null {
  const proposal = approval.metadata?.actionProposal;
  if (!proposal || typeof proposal !== 'object') return null;
  // Re-parse through the canonical validator so we get the full shape guarantee.
  // Throws Ap2ParseError on malformed data; caller handles.
  return parseAp2Mandate(proposal);
}

function extractVerifiedAgentFromApproval(approval: ApprovalRequestRecord, mandate: Ap2Mandate): Ap2VerifiedAgent {
  const meta = approval.metadata?.ap2VerifiedAgent;
  if (meta && typeof meta === 'object') {
    const obj = meta as Record<string, unknown>;
    if (typeof obj.agentId === 'string' && typeof obj.agentLabel === 'string' && typeof obj.publicKey === 'string') {
      return { agentId: obj.agentId, agentLabel: obj.agentLabel, publicKey: obj.publicKey };
    }
  }
  return {
    agentId: mandate.agent.agentId,
    agentLabel: mandate.agent.agentLabel,
    publicKey: mandate.agent.publicKey,
  };
}

function resolveApprovalCluster(approval: ApprovalRequestRecord, mandate: Ap2Mandate): Ap2Cluster {
  const stored = approval.cluster;
  if (typeof stored === 'string' && (AP2_CLUSTERS as readonly string[]).includes(stored)) {
    return stored as Ap2Cluster;
  }
  return paymentDetailsFor(mandate).cluster;
}

function isAp2InboundReceiptPayload(payload: unknown): payload is Ap2InboundReceipt {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.schema === 'string' &&
    candidate.schema === 'ap2/inbound/0.1' &&
    typeof candidate.mandateId === 'string' &&
    typeof candidate.artifactHash === 'string'
  );
}

function stringFromMetadata(metadata: JsonObject | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
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

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

registerDevApiHandler({
  prefix: PREFIX,
  methods: ['GET', 'POST'],
  async handle(req, res, _url, context: DevApiHandlerContext) {
    const handler = createAp2ApiHandler({
      workflowService: context.workflowService,
      workflowStore: context.workflowStore,
      evidenceStore: context.evidenceStore,
      clock: context.clock,
      getSession: () => (context.walletAddress ? { walletAddress: context.walletAddress } : null),
    });
    return handler(req, res);
  },
});
