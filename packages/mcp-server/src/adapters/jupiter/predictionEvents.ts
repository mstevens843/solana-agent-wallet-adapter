import type { AgentWalletConfig } from '../../config.js';

import {
  predictionEnvelope,
  predictionRequest,
  type JupiterPredictionEnvelope,
} from './predictionClient.js';
import { normalizeMarket, type NormalizedPredictionMarket } from './predictionMarkets.js';

export type PredictionProvider = 'polymarket' | 'kalshi';
export type PredictionEventCategory =
  | 'all'
  | 'crypto'
  | 'sports'
  | 'politics'
  | 'esports'
  | 'culture'
  | 'economics'
  | 'tech';
export type PredictionEventSortBy = 'volume' | 'beginAt';
export type PredictionEventSortDirection = 'asc' | 'desc';
export type PredictionEventFilter = 'new' | 'live' | 'trending';

export interface GetEventsInput {
  provider?: PredictionProvider;
  includeMarkets?: boolean;
  category?: PredictionEventCategory;
  sortBy?: PredictionEventSortBy;
  sortDirection?: PredictionEventSortDirection;
  filter?: PredictionEventFilter;
  start?: number;
  end?: number;
}

export interface SearchEventsInput {
  query: string;
  provider?: PredictionProvider;
  limit?: number;
}

export interface EventDetailInput {
  eventId: string;
  includeMarkets?: boolean;
}

export interface EventMarketsInput {
  eventId: string;
}

export interface NormalizedPredictionEventSummary {
  id?: string;
  title?: string;
  category?: string;
  provider?: string;
  beginAt?: string;
  endAt?: string;
  closeAt?: string;
  rulesUrl?: string;
  volume?: string;
  marketCount?: number;
  raw: Record<string, unknown>;
}

export interface PredictionEventsResult {
  events: NormalizedPredictionEventSummary[];
  total?: number;
  raw: Record<string, unknown>;
}

export interface PredictionEventDetailResult {
  event: NormalizedPredictionEventSummary;
  markets?: NormalizedPredictionMarket[];
  raw: Record<string, unknown>;
}

export async function getPredictionEvents(
  config: AgentWalletConfig,
  input: GetEventsInput,
): Promise<JupiterPredictionEnvelope<PredictionEventsResult>> {
  const body = await predictionRequest(config, '/events', {
    searchParams: {
      provider: input.provider ?? 'polymarket',
      includeMarkets: input.includeMarkets,
      category: input.category,
      sortBy: input.sortBy,
      sortDirection: input.sortDirection,
      filter: input.filter,
      start: input.start,
      end: input.end,
    },
  });
  return predictionEnvelope(config, normalizeEventsList(body));
}

export async function searchPredictionEvents(
  config: AgentWalletConfig,
  input: SearchEventsInput,
): Promise<JupiterPredictionEnvelope<PredictionEventsResult>> {
  const body = await predictionRequest(config, '/events/search', {
    searchParams: {
      query: input.query,
      provider: input.provider,
      limit: input.limit,
    },
  });
  return predictionEnvelope(config, normalizeEventsList(body));
}

export async function getPredictionEventDetail(
  config: AgentWalletConfig,
  input: EventDetailInput,
): Promise<JupiterPredictionEnvelope<PredictionEventDetailResult>> {
  const includeMarkets = input.includeMarkets ?? true;
  const body = await predictionRequest(config, `/events/${encodeURIComponent(input.eventId)}`, {
    searchParams: { includeMarkets },
  });
  const event = normalizeEventSummary(body.event ?? body);
  const markets = extractEmbeddedMarkets(body);
  return predictionEnvelope(config, {
    event,
    ...(markets !== undefined && { markets }),
    raw: body,
  });
}

export async function getPredictionEventMarkets(
  config: AgentWalletConfig,
  input: EventMarketsInput,
): Promise<JupiterPredictionEnvelope<PredictionEventDetailResult>> {
  const body = await predictionRequest(
    config,
    `/events/${encodeURIComponent(input.eventId)}/markets`,
  );
  const markets = extractEmbeddedMarkets(body) ?? [];
  const eventSource = body.event && typeof body.event === 'object'
    ? body.event as Record<string, unknown>
    : { id: input.eventId };
  return predictionEnvelope(config, {
    event: normalizeEventSummary(eventSource),
    markets,
    raw: body,
  });
}

function normalizeEventsList(body: Record<string, unknown>): PredictionEventsResult {
  const list = extractEventsArray(body);
  const events = list.map(normalizeEventSummary);
  const total = typeof body.total === 'number' ? body.total : undefined;
  return {
    events,
    ...(total !== undefined && { total }),
    raw: body,
  };
}

function extractEventsArray(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: unknown[] = [body.events, body.data, body.items, body.results];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function extractEmbeddedMarkets(
  body: Record<string, unknown>,
): NormalizedPredictionMarket[] | undefined {
  const eventRecord = isRecord(body.event) ? body.event : undefined;
  const candidates: unknown[] = [body.markets, eventRecord?.markets];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord).map((raw) => normalizeMarket(raw));
    }
  }
  return undefined;
}

function normalizeEventSummary(raw: unknown): NormalizedPredictionEventSummary {
  if (!isRecord(raw)) return { raw: {} };
  const id = stringOrUndefined(raw.id ?? raw.eventId ?? raw.event_id ?? raw.marketId ?? raw.market_id);
  const title = stringOrUndefined(raw.title ?? raw.name ?? raw.question);
  const category = stringOrUndefined(raw.category ?? raw.tag);
  const provider = stringOrUndefined(raw.provider ?? raw.source);
  const beginAt = stringOrUndefined(raw.beginAt ?? raw.begin_at ?? raw.startTime ?? raw.startsAt);
  const endAt = stringOrUndefined(raw.endAt ?? raw.end_at ?? raw.endTime ?? raw.endsAt);
  const closeAt = stringOrUndefined(raw.closeAt ?? raw.close_at ?? raw.expirationTime);
  const rulesUrl = stringOrUndefined(raw.rulesUrl ?? raw.rules_url ?? raw.rules);
  const volume = stringOrUndefined(raw.volume ?? raw.volume24h ?? raw.totalVolume);
  const markets = Array.isArray(raw.markets) ? raw.markets : undefined;
  return {
    ...(id !== undefined && { id }),
    ...(title !== undefined && { title }),
    ...(category !== undefined && { category }),
    ...(provider !== undefined && { provider }),
    ...(beginAt !== undefined && { beginAt }),
    ...(endAt !== undefined && { endAt }),
    ...(closeAt !== undefined && { closeAt }),
    ...(rulesUrl !== undefined && { rulesUrl }),
    ...(volume !== undefined && { volume }),
    ...(markets !== undefined && { marketCount: markets.length }),
    raw,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
