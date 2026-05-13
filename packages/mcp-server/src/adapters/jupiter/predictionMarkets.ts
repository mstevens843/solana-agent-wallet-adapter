import type { AgentWalletConfig } from '../../config.js';

import {
  predictionEnvelope,
  predictionRequest,
  type JupiterPredictionEnvelope,
} from './predictionClient.js';

export type PredictionMarketStatus = 'open' | 'closed' | 'resolved' | 'paused' | 'unknown';

export interface MarketDetailInput {
  marketId: string;
}

export interface OrderbookInput {
  marketId: string;
}

export interface NormalizedPredictionMarket {
  id?: string;
  question?: string;
  eventId?: string;
  provider?: string;
  status: PredictionMarketStatus;
  rawStatus?: string;
  result?: string;
  rulesUrl?: string;
  closeAt?: string;
  resolveAt?: string;
  yesPrice?: string;
  noPrice?: string;
  volume?: string;
  raw: Record<string, unknown>;
}

export interface NormalizedOrderbookLevel {
  price: string;
  size: string;
}

export interface NormalizedOrderbook {
  marketId: string;
  status: PredictionMarketStatus;
  yes: { bids: NormalizedOrderbookLevel[]; asks: NormalizedOrderbookLevel[]; bestBid?: string; bestAsk?: string };
  no: { bids: NormalizedOrderbookLevel[]; asks: NormalizedOrderbookLevel[]; bestBid?: string; bestAsk?: string };
  raw: Record<string, unknown>;
}

export async function getPredictionMarketDetail(
  config: AgentWalletConfig,
  input: MarketDetailInput,
): Promise<JupiterPredictionEnvelope<NormalizedPredictionMarket>> {
  const body = await predictionRequest(
    config,
    `/markets/${encodeURIComponent(input.marketId)}`,
  );
  const market = normalizeMarket(body.market ?? body, input.marketId);
  return predictionEnvelope(config, market, warningsForStatus(market.status));
}

export async function getPredictionOrderbook(
  config: AgentWalletConfig,
  input: OrderbookInput,
): Promise<JupiterPredictionEnvelope<NormalizedOrderbook>> {
  const body = await predictionRequest(
    config,
    `/markets/${encodeURIComponent(input.marketId)}/orderbook`,
  );
  const status = normalizeStatus(body.status ?? (body.market as Record<string, unknown> | undefined)?.status);
  const orderbook: NormalizedOrderbook = {
    marketId: input.marketId,
    status,
    yes: normalizeBook(extractBook(body, 'yes')),
    no: normalizeBook(extractBook(body, 'no')),
    raw: body,
  };
  const warnings = [
    ...warningsForStatus(status),
    'Orderbook prices update quickly; refresh before relying on them for any action.',
  ];
  return predictionEnvelope(config, orderbook, warnings);
}

export function normalizeMarket(
  raw: unknown,
  fallbackId?: string,
): NormalizedPredictionMarket {
  if (!isRecord(raw)) {
    return {
      ...(fallbackId !== undefined && { id: fallbackId }),
      status: 'unknown',
      raw: {},
    };
  }
  const id = stringOrUndefined(raw.id ?? raw.marketId ?? raw.market_id) ?? fallbackId;
  const question = stringOrUndefined(raw.question ?? raw.title ?? raw.name);
  const eventId = stringOrUndefined(raw.eventId ?? raw.event_id);
  const provider = stringOrUndefined(raw.provider ?? raw.source);
  const rawStatus = stringOrUndefined(raw.status ?? raw.state);
  const status = normalizeStatus(rawStatus);
  const result = stringOrUndefined(raw.result ?? raw.outcome ?? raw.resolution);
  const rulesUrl = stringOrUndefined(raw.rulesUrl ?? raw.rules_url ?? raw.rules);
  const closeAt = stringOrUndefined(raw.closeAt ?? raw.close_at ?? raw.expirationTime);
  const resolveAt = stringOrUndefined(raw.resolveAt ?? raw.resolve_at ?? raw.resolvedAt);
  const yesPrice = stringOrUndefined(extractPrice(raw, 'yes'));
  const noPrice = stringOrUndefined(extractPrice(raw, 'no'));
  const volume = stringOrUndefined(raw.volume ?? raw.volume24h ?? raw.totalVolume);
  return {
    ...(id !== undefined && { id }),
    ...(question !== undefined && { question }),
    ...(eventId !== undefined && { eventId }),
    ...(provider !== undefined && { provider }),
    status,
    ...(rawStatus !== undefined && { rawStatus }),
    ...(result !== undefined && { result }),
    ...(rulesUrl !== undefined && { rulesUrl }),
    ...(closeAt !== undefined && { closeAt }),
    ...(resolveAt !== undefined && { resolveAt }),
    ...(yesPrice !== undefined && { yesPrice }),
    ...(noPrice !== undefined && { noPrice }),
    ...(volume !== undefined && { volume }),
    raw,
  };
}

function normalizeStatus(raw: unknown): PredictionMarketStatus {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.toLowerCase();
  if (['open', 'live', 'active', 'trading'].includes(value)) return 'open';
  if (['closed', 'expired'].includes(value)) return 'closed';
  if (['resolved', 'settled'].includes(value)) return 'resolved';
  if (['paused', 'halted', 'suspended'].includes(value)) return 'paused';
  return 'unknown';
}

function warningsForStatus(status: PredictionMarketStatus): string[] {
  switch (status) {
    case 'open':
      return [];
    case 'closed':
      return ['Market is closed; no further orders can fill.'];
    case 'resolved':
      return ['Market is resolved; trading has ended and a final outcome is recorded.'];
    case 'paused':
      return ['Market is paused; trading is temporarily suspended.'];
    default:
      return ['Market status is unknown; treat prices as potentially stale.'];
  }
}

function extractBook(body: Record<string, unknown>, side: 'yes' | 'no'): Record<string, unknown> | undefined {
  const direct = body[side];
  if (isRecord(direct)) return direct;
  if (isRecord(body.orderbook)) {
    const candidate = (body.orderbook as Record<string, unknown>)[side];
    if (isRecord(candidate)) return candidate;
  }
  return undefined;
}

function normalizeBook(
  side: Record<string, unknown> | undefined,
): NormalizedOrderbook['yes'] {
  const bids = Array.isArray(side?.bids) ? side?.bids.map(normalizeLevel).filter(nonNull) : [];
  const asks = Array.isArray(side?.asks) ? side?.asks.map(normalizeLevel).filter(nonNull) : [];
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  return {
    bids,
    asks,
    ...(bestBid !== undefined && { bestBid }),
    ...(bestAsk !== undefined && { bestAsk }),
  };
}

function normalizeLevel(value: unknown): NormalizedOrderbookLevel | null {
  if (Array.isArray(value) && value.length >= 2) {
    return { price: String(value[0]), size: String(value[1]) };
  }
  if (isRecord(value)) {
    const price = stringOrUndefined(value.price);
    const size = stringOrUndefined(value.size ?? value.quantity);
    if (price && size) return { price, size };
  }
  return null;
}

function extractPrice(raw: Record<string, unknown>, side: 'yes' | 'no'): unknown {
  const direct = raw[`${side}Price`] ?? raw[`${side}_price`];
  if (direct !== undefined) return direct;
  const nested = raw[side];
  if (isRecord(nested)) return nested.price ?? nested.lastPrice;
  const prices = raw.prices;
  if (isRecord(prices)) return prices[side];
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}
