import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  Ap2ParseError,
  Ap2VerifyError,
  buildAp2InboundReceipt,
  mandateToApprovalParams,
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
  type WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';
import { DevLayer1 } from '@solana-agent-wallet-adapter/workflow';

import { registerDevApiHandler, type DevApiHandlerContext } from './devApiRegistry.js';
import type { Clock, WorkflowStore as SessionWorkflowStore } from './store.js';
import type { WorkflowService, WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';

export const AP2_INBOUND_ACTION_SOURCE = 'ap2_inbound';

const PREFIX = '/api/ap2/';
const INBOUND_COLLECTION = '/api/ap2/inbound';
const INBOUND_ITEM_PATTERN = /^\/api\/ap2\/inbound\/([^/]+?)(?:\/receipt)?\/?$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST_RESULTS = 50;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

type Ap2Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type SessionResolver = (
  req: IncomingMessage,
) => Promise<WorkflowSession | null | undefined> | WorkflowSession | null | undefined;

export interface Ap2RouteAdapter {
  validateInboundRequest: (body: unknown) => { mandate: Ap2Mandate; cluster?: Ap2Cluster; receivedAt: string };
  verifyMandate: (
    mandate: Ap2Mandate,
    opts?: { clockNow?: Date; expectedRecipient?: string },
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
  clock: Clock;
  getSession: SessionResolver;
  idFactory?: () => string;
  adapter?: Ap2RouteAdapter;
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
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method_not_allowed' });
          return true;
        }
        await handlePostReceipt(req, res, context, adapter, idFactory, session, inboundId);
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

  let validated: { mandate: Ap2Mandate; cluster?: Ap2Cluster };
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
    const result = adapter.verifyMandate(mandate, { clockNow: context.clock.now() });
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
  const enrichedMetadata: JsonObject = {
    ...approvalParams.metadata,
    ap2VerifiedAgent: {
      agentId: verifiedAgent.agentId,
      agentLabel: verifiedAgent.agentLabel,
      publicKey: verifiedAgent.publicKey,
    },
  };

  const approval = await context.workflowService.createApproval(session, {
    kind: approvalParams.kind,
    summary: approvalParams.summary,
    cluster: approvalParams.cluster,
    amount: approvalParams.amount,
    token: approvalParams.token,
    recipient: approvalParams.recipient,
    dueAt,
    params: approvalParams.params,
    metadata: enrichedMetadata,
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
  const inbound = approvals
    .filter(isAp2InboundApproval)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_LIST_RESULTS)
    .map(normalizeApprovalForResponse);
  writeJson(res, 200, { inbound });
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
  writeJson(res, 200, { inbound: normalizeApprovalForResponse(approval) });
}

async function handlePostReceipt(
  req: IncomingMessage,
  res: ServerResponse,
  context: Ap2RouteContext,
  adapter: Ap2RouteAdapter,
  idFactory: () => string,
  session: WorkflowSession,
  inboundId: string,
): Promise<void> {
  await readJsonBody(req); // accept and discard optional body

  const approval = await context.workflowStore.getApproval(session.walletAddress, inboundId);
  if (!approval || !isAp2InboundApproval(approval)) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  const finalizations = await context.workflowService.listFinalizationsForApproval(session, inboundId);
  const confirmed = finalizations.find((finalization) => finalization.txid && finalization.status === 'confirmed');
  if (!confirmed?.txid) {
    writeJson(res, 409, { error: 'not_finalized', message: 'Approval has not yet been confirmed on-chain.' });
    return;
  }

  const mandate = extractMandateFromApproval(approval);
  if (!mandate) {
    writeJson(res, 409, {
      error: 'missing_mandate',
      message: 'Approval is missing its source AP2 mandate; cannot build receipt.',
    });
    return;
  }
  const verifiedAgent = extractVerifiedAgentFromApproval(approval, mandate);
  const cluster = (approval.cluster as Ap2Cluster | undefined) ?? paymentDetailsFor(mandate).cluster;
  const issuedAt = context.clock.now().toISOString();
  const finalizedAt = confirmed.updatedAt ?? confirmed.createdAt ?? issuedAt;

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

  const updatedApproval: ApprovalRequestRecord = {
    ...approval,
    metadata: {
      ...(approval.metadata ?? {}),
      ap2InboundReceipt: receipt as unknown as JsonObject,
      ap2InboundReceiptIssuedAt: issuedAt,
    },
    updatedAt: issuedAt,
  };
  await context.workflowStore.saveApproval(session.walletAddress, updatedApproval);

  await context.workflowStore.appendAuditEvent(session.walletAddress, {
    id: `audit_${idFactory()}`,
    walletAddress: session.walletAddress,
    type: 'ap2.inbound.receipt.created',
    actor: 'server',
    recordType: 'approval',
    recordId: approval.id,
    createdAt: issuedAt,
    metadata: {
      txid: confirmed.txid,
      artifactHash: receipt.artifactHash,
    },
  });

  writeJson(res, 201, { receipt, approvalId: approval.id });
}

function isAp2InboundApproval(approval: ApprovalRequestRecord): boolean {
  const source = approval.metadata?.actionSource;
  return typeof source === 'string' && source === AP2_INBOUND_ACTION_SOURCE;
}

function extractMandateFromApproval(approval: ApprovalRequestRecord): Ap2Mandate | null {
  const proposal = approval.metadata?.actionProposal;
  if (!proposal || typeof proposal !== 'object') return null;
  const candidate = proposal as Record<string, unknown>;
  if (
    typeof candidate.mandateId !== 'string' ||
    (candidate.mandateType !== 'intent_mandate' && candidate.mandateType !== 'payment_mandate')
  ) {
    return null;
  }
  return proposal as unknown as Ap2Mandate;
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
      clock: context.clock,
      getSession: () => (context.walletAddress ? { walletAddress: context.walletAddress } : null),
    });
    return handler(req, res);
  },
});
