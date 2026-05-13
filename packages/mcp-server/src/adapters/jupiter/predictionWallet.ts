import type { AgentWalletConfig } from '../../config.js';

import {
  predictionEnvelope,
  predictionRequest,
  type JupiterPredictionEnvelope,
} from './predictionClient.js';

export type PredictionOrderStatus = 'pending' | 'filled' | 'failed' | 'all';

export interface OrdersInput {
  owner: string;
  marketId?: string;
  status?: PredictionOrderStatus;
}

export interface OrderStatusInput {
  owner: string;
  orderId: string;
}

export interface PositionsInput {
  owner: string;
  marketId?: string;
  eventId?: string;
}

export interface HistoryInput {
  owner: string;
  marketId?: string;
  eventId?: string;
  limit?: number;
}

export interface VaultInfoInput {
  owner: string;
}

export interface NormalizedPredictionOrder {
  orderId?: string;
  orderPubkey?: string;
  marketId?: string;
  side?: string;
  price?: string;
  size?: string;
  filled?: string;
  status?: string;
  createdAt?: string;
  raw: Record<string, unknown>;
}

export interface NormalizedPredictionPosition {
  positionPubkey?: string;
  marketId?: string;
  eventId?: string;
  outcome?: string;
  shares?: string;
  averagePrice?: string;
  unrealizedPnl?: string;
  claimable?: boolean;
  settled?: boolean;
  raw: Record<string, unknown>;
}

export interface NormalizedPredictionHistoryEntry {
  txid?: string;
  marketId?: string;
  eventId?: string;
  kind?: string;
  side?: string;
  price?: string;
  size?: string;
  occurredAt?: string;
  raw: Record<string, unknown>;
}

export interface NormalizedPredictionVault {
  owner: string;
  vaultAddress?: string;
  balance?: string;
  currency?: string;
  raw: Record<string, unknown>;
}

export interface PredictionOrdersResult {
  owner: string;
  orders: NormalizedPredictionOrder[];
  raw: Record<string, unknown>;
}

export interface PredictionPositionsResult {
  owner: string;
  positions: NormalizedPredictionPosition[];
  raw: Record<string, unknown>;
}

export interface PredictionHistoryResult {
  owner: string;
  entries: NormalizedPredictionHistoryEntry[];
  raw: Record<string, unknown>;
}

export async function getPredictionOrders(
  config: AgentWalletConfig,
  input: OrdersInput,
): Promise<JupiterPredictionEnvelope<PredictionOrdersResult>> {
  const body = await predictionRequest(config, '/orders', {
    searchParams: {
      owner: input.owner,
      marketId: input.marketId,
      status: input.status,
    },
  });
  const orders = extractArray(body, ['orders', 'data', 'items']).map(normalizeOrder);
  return predictionEnvelope(config, { owner: input.owner, orders, raw: body });
}

export async function getPredictionOrderStatus(
  config: AgentWalletConfig,
  input: OrderStatusInput,
): Promise<JupiterPredictionEnvelope<NormalizedPredictionOrder>> {
  const body = await predictionRequest(
    config,
    `/orders/${encodeURIComponent(input.orderId)}`,
    { searchParams: { owner: input.owner } },
  );
  return predictionEnvelope(config, normalizeOrder(body.order ?? body));
}

export async function getPredictionPositions(
  config: AgentWalletConfig,
  input: PositionsInput,
): Promise<JupiterPredictionEnvelope<PredictionPositionsResult>> {
  const body = await predictionRequest(config, '/positions', {
    searchParams: {
      owner: input.owner,
      marketId: input.marketId,
      eventId: input.eventId,
    },
  });
  const positions = extractArray(body, ['positions', 'data', 'items']).map(normalizePosition);
  return predictionEnvelope(config, { owner: input.owner, positions, raw: body });
}

export async function getPredictionHistory(
  config: AgentWalletConfig,
  input: HistoryInput,
): Promise<JupiterPredictionEnvelope<PredictionHistoryResult>> {
  const body = await predictionRequest(config, '/history', {
    searchParams: {
      owner: input.owner,
      marketId: input.marketId,
      eventId: input.eventId,
      limit: input.limit,
    },
  });
  const entries = extractArray(body, ['history', 'data', 'items', 'entries']).map(normalizeHistory);
  return predictionEnvelope(config, { owner: input.owner, entries, raw: body });
}

export async function getPredictionVaultInfo(
  config: AgentWalletConfig,
  input: VaultInfoInput,
): Promise<JupiterPredictionEnvelope<NormalizedPredictionVault>> {
  const body = await predictionRequest(config, '/vault', {
    searchParams: { owner: input.owner },
  });
  return predictionEnvelope(config, normalizeVault(body, input.owner));
}

function normalizeOrder(raw: unknown): NormalizedPredictionOrder {
  if (!isRecord(raw)) return { raw: {} };
  return {
    ...(stringValue(raw.orderId ?? raw.id) !== undefined && { orderId: stringValue(raw.orderId ?? raw.id) }),
    ...(stringValue(raw.orderPubkey ?? raw.order_pubkey) !== undefined && {
      orderPubkey: stringValue(raw.orderPubkey ?? raw.order_pubkey),
    }),
    ...(stringValue(raw.marketId ?? raw.market_id) !== undefined && {
      marketId: stringValue(raw.marketId ?? raw.market_id),
    }),
    ...(stringValue(raw.side ?? raw.outcome) !== undefined && {
      side: stringValue(raw.side ?? raw.outcome),
    }),
    ...(stringValue(raw.price ?? raw.limitPrice) !== undefined && {
      price: stringValue(raw.price ?? raw.limitPrice),
    }),
    ...(stringValue(raw.size ?? raw.quantity) !== undefined && {
      size: stringValue(raw.size ?? raw.quantity),
    }),
    ...(stringValue(raw.filled ?? raw.filledSize) !== undefined && {
      filled: stringValue(raw.filled ?? raw.filledSize),
    }),
    ...(stringValue(raw.status ?? raw.state) !== undefined && {
      status: stringValue(raw.status ?? raw.state),
    }),
    ...(stringValue(raw.createdAt ?? raw.created_at) !== undefined && {
      createdAt: stringValue(raw.createdAt ?? raw.created_at),
    }),
    raw,
  };
}

function normalizePosition(raw: unknown): NormalizedPredictionPosition {
  if (!isRecord(raw)) return { raw: {} };
  const claimable = typeof raw.claimable === 'boolean' ? raw.claimable : undefined;
  const settled = typeof raw.settled === 'boolean' ? raw.settled : undefined;
  return {
    ...(stringValue(raw.positionPubkey ?? raw.position_pubkey ?? raw.id) !== undefined && {
      positionPubkey: stringValue(raw.positionPubkey ?? raw.position_pubkey ?? raw.id),
    }),
    ...(stringValue(raw.marketId ?? raw.market_id) !== undefined && {
      marketId: stringValue(raw.marketId ?? raw.market_id),
    }),
    ...(stringValue(raw.eventId ?? raw.event_id) !== undefined && {
      eventId: stringValue(raw.eventId ?? raw.event_id),
    }),
    ...(stringValue(raw.outcome ?? raw.side) !== undefined && {
      outcome: stringValue(raw.outcome ?? raw.side),
    }),
    ...(stringValue(raw.shares ?? raw.size) !== undefined && {
      shares: stringValue(raw.shares ?? raw.size),
    }),
    ...(stringValue(raw.averagePrice ?? raw.average_price ?? raw.avgPrice) !== undefined && {
      averagePrice: stringValue(raw.averagePrice ?? raw.average_price ?? raw.avgPrice),
    }),
    ...(stringValue(raw.unrealizedPnl ?? raw.unrealized_pnl ?? raw.pnl) !== undefined && {
      unrealizedPnl: stringValue(raw.unrealizedPnl ?? raw.unrealized_pnl ?? raw.pnl),
    }),
    ...(claimable !== undefined && { claimable }),
    ...(settled !== undefined && { settled }),
    raw,
  };
}

function normalizeHistory(raw: unknown): NormalizedPredictionHistoryEntry {
  if (!isRecord(raw)) return { raw: {} };
  return {
    ...(stringValue(raw.txid ?? raw.signature ?? raw.txId) !== undefined && {
      txid: stringValue(raw.txid ?? raw.signature ?? raw.txId),
    }),
    ...(stringValue(raw.marketId ?? raw.market_id) !== undefined && {
      marketId: stringValue(raw.marketId ?? raw.market_id),
    }),
    ...(stringValue(raw.eventId ?? raw.event_id) !== undefined && {
      eventId: stringValue(raw.eventId ?? raw.event_id),
    }),
    ...(stringValue(raw.kind ?? raw.type ?? raw.action) !== undefined && {
      kind: stringValue(raw.kind ?? raw.type ?? raw.action),
    }),
    ...(stringValue(raw.side ?? raw.outcome) !== undefined && {
      side: stringValue(raw.side ?? raw.outcome),
    }),
    ...(stringValue(raw.price) !== undefined && { price: stringValue(raw.price) }),
    ...(stringValue(raw.size ?? raw.quantity) !== undefined && {
      size: stringValue(raw.size ?? raw.quantity),
    }),
    ...(stringValue(raw.occurredAt ?? raw.occurred_at ?? raw.timestamp) !== undefined && {
      occurredAt: stringValue(raw.occurredAt ?? raw.occurred_at ?? raw.timestamp),
    }),
    raw,
  };
}

function normalizeVault(raw: Record<string, unknown>, owner: string): NormalizedPredictionVault {
  const source = isRecord(raw.vault) ? raw.vault : raw;
  return {
    owner,
    ...(stringValue(source.address ?? source.vaultAddress ?? source.vault) !== undefined && {
      vaultAddress: stringValue(source.address ?? source.vaultAddress ?? source.vault),
    }),
    ...(stringValue(source.balance ?? source.amount) !== undefined && {
      balance: stringValue(source.balance ?? source.amount),
    }),
    ...(stringValue(source.currency ?? source.token ?? source.mint) !== undefined && {
      currency: stringValue(source.currency ?? source.token ?? source.mint),
    }),
    raw,
  };
}

function extractArray(body: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  for (const key of keys) {
    const candidate = body[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
