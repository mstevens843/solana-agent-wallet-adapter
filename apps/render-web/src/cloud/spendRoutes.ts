import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  envelopeStatus,
  envelopeUpdatedAt,
  type StreamingSessionRecord,
  type SpendEnvelope,
  type SpendEnvelopeStatus,
} from '@solana-agent-wallet-adapter/workflow';

import {
  registerDevApiHandler,
  type DevApiHandler,
  type DevApiHandlerContext,
} from './devApiRegistry.js';
import { recurringStoreAdapterForCloudStore } from './recurringRoutes.js';
import type { RecurringStore } from './recurringService.js';
import { StreamingService, streamingStoreFor, type StoredStreamingSession } from './streamingService.js';
import type { WorkflowStore } from './store.js';

const PREFIX = '/api/spend/';
const ENVELOPES_PATH = '/api/spend/envelopes';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type SpendFilter = 'all' | 'needs_approval' | 'active_schedules' | 'live_streams' | 'settled';
type SpendCounts = Record<SpendFilter, number>;

class SpendQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendQueryError';
  }
}

async function handleSpendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: DevApiHandlerContext,
): Promise<boolean> {
  if (url.pathname !== ENVELOPES_PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJsonNoStore(req, res, 405, { error: 'method_not_allowed' });
    return true;
  }
  if (!ctx.walletAddress) {
    writeJsonNoStore(req, res, 403, {
      error: 'dev_layer1_disabled',
      message: 'This route is only available to allowlisted dev wallets.',
    });
    return true;
  }

  const parsed = parseSpendQuery(url);
  if (parsed instanceof SpendQueryError) {
    writeJsonNoStore(req, res, 400, { error: 'invalid_spend_query', message: parsed.message });
    return true;
  }

  try {
    const { filter, limit, cursor } = parsed;
    const envelopes = await listSpendEnvelopes(ctx);
    const counts = countEnvelopes(envelopes);
    const filtered = envelopes
      .filter((envelope) => matchesFilter(envelope, filter))
      .sort((left, right) => envelopeUpdatedAt(right).localeCompare(envelopeUpdatedAt(left)));
    const page = filtered.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < filtered.length ? String(cursor + limit) : undefined;
    writeJsonNoStore(req, res, 200, {
      envelopes: page,
      items: page,
      filter,
      counts,
      pagination: {
        limit,
        total: filtered.length,
        ...(nextCursor ? { nextCursor } : {}),
      },
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected spend envelope error.';
    writeJsonNoStore(req, res, 500, { error: 'spend_envelopes_unavailable', message });
  }
  return true;
}

async function listSpendEnvelopes(ctx: DevApiHandlerContext): Promise<SpendEnvelope[]> {
  const walletAddress = ctx.walletAddress;
  if (!walletAddress) return [];

  const approvals = await ctx.workflowStore.listApprovals(walletAddress);
  const recurringStore = recurringStoreFor(ctx.workflowStore);
  const schedules = await recurringStore.listSchedules(walletAddress);
  const streamingService = new StreamingService(streamingStoreFor(ctx.workflowStore), {
    clock: ctx.clock,
  });
  const sessions = await streamingService.listSessions({ walletAddress, status: 'all' });

  return [
    ...approvals.map((action): SpendEnvelope => ({ kind: 'one-time', action })),
    ...schedules.map((schedule): SpendEnvelope => ({ kind: 'recurring', schedule })),
    ...sessions.map((session): SpendEnvelope => ({
      kind: 'streaming',
      session: toSpendStreamingSession(session),
    })),
  ];
}

function toSpendStreamingSession(session: StoredStreamingSession): StreamingSessionRecord {
  return {
    id: session.sessionId,
    walletAddress: session.walletAddress,
    cluster: session.cluster,
    tokenMint: session.tokenMint,
    delegatePubkey: session.delegatePubkey,
    ephemeralSignerPubkey: session.ephemeralSignerPubkey,
    capAmount: session.capAmount,
    spentAmount: session.spentAmount,
    expiresAt: session.expiresAt,
    status: session.status,
    ...(session.recipientAllowlist ? { recipientAllowlist: session.recipientAllowlist } : {}),
    ...(session.approveTxid ? { approveTxid: session.approveTxid } : {}),
    ...(session.revokeTxid ? { revokeTxid: session.revokeTxid } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.metadata ? { metadata: session.metadata as StreamingSessionRecord['metadata'] } : {}),
  };
}

function recurringStoreFor(store: WorkflowStore): RecurringStore {
  if (typeof (store as Partial<RecurringStore>).listSchedules === 'function') {
    return store as WorkflowStore & RecurringStore;
  }
  return recurringStoreAdapterForCloudStore(store);
}

function matchesFilter(envelope: SpendEnvelope, filter: SpendFilter): boolean {
  if (filter === 'all') return true;
  const status = envelopeStatus(envelope);
  switch (filter) {
    case 'needs_approval':
      return status === 'needs_approval';
    case 'active_schedules':
      return envelope.kind === 'recurring' && status === 'active';
    case 'live_streams':
      return envelope.kind === 'streaming' && (status === 'active' || status === 'needs_approval');
    case 'settled':
      return isTerminalEnvelopeStatus(status);
  }
}

function isTerminalEnvelopeStatus(status: SpendEnvelopeStatus): boolean {
  return status === 'settled' || status === 'expired' || status === 'cancelled' || status === 'failed';
}

function countEnvelopes(envelopes: SpendEnvelope[]): SpendCounts {
  return {
    all: envelopes.length,
    needs_approval: envelopes.filter((envelope) => matchesFilter(envelope, 'needs_approval')).length,
    active_schedules: envelopes.filter((envelope) => matchesFilter(envelope, 'active_schedules')).length,
    live_streams: envelopes.filter((envelope) => matchesFilter(envelope, 'live_streams')).length,
    settled: envelopes.filter((envelope) => matchesFilter(envelope, 'settled')).length,
  };
}

function parseSpendQuery(url: URL): { filter: SpendFilter; limit: number; cursor: number } | SpendQueryError {
  try {
    return {
      filter: parseFilter(url.searchParams.get('filter')),
      limit: parseLimit(url.searchParams.get('limit')),
      cursor: parseCursor(url.searchParams.get('cursor')),
    };
  } catch (err) {
    return new SpendQueryError(err instanceof Error ? err.message : 'Invalid spend query.');
  }
}

function parseFilter(raw: string | null): SpendFilter {
  if (!raw || raw === 'all') return 'all';
  if (
    raw === 'needs_approval' ||
    raw === 'active_schedules' ||
    raw === 'live_streams' ||
    raw === 'settled'
  ) {
    return raw;
  }
  throw new SpendQueryError('filter must be all, needs_approval, active_schedules, live_streams, or settled.');
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new SpendQueryError('limit must be a positive integer.');
  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(raw: string | null): number {
  if (!raw) return 0;
  const cursor = Number(raw);
  if (!Number.isInteger(cursor) || cursor < 0) throw new SpendQueryError('cursor must be a non-negative integer.');
  return cursor;
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

const spendHandler: DevApiHandler = {
  prefix: PREFIX,
  methods: ['GET', 'HEAD'],
  handle: handleSpendRequest,
};

registerDevApiHandler(spendHandler);
