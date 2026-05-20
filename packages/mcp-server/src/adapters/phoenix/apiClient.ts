import {
  extractRows,
  isRecord,
  normalizeBaseUrl,
  optionalNumber,
  optionalString,
  parseJson,
  responseErrorDetail,
} from '../_shared/jsonHelpers.js';
import { AdapterError } from '../types.js';
import {
  PHOENIX_ACCESS_CODE_ENV,
  PHOENIX_ADAPTER_ID,
  PHOENIX_API_BASE_URL_ENV,
  PHOENIX_DEFAULT_API_BASE_URL,
} from './constants.js';
import type {
  PhoenixClient,
  PhoenixFundingHistoryEntry,
  PhoenixMarketSnapshot,
  PhoenixOpenOrder,
  PhoenixTraderStateSnapshot,
} from './client.js';

const PHOENIX_ROW_KEYS = [
  'markets',
  'positions',
  'orders',
  'triggers',
  'rows',
  'results',
  'data',
] as const;

type PhoenixFetch = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

export interface PhoenixApiClientOptions {
  /** Phoenix invite/activation code. Required unless inherited from `PHOENIX_ACCESS_CODE` env. */
  accessCode?: string;
  baseUrl?: string;
  fetchImpl?: PhoenixFetch;
}

export function buildPhoenixApiClient(options: PhoenixApiClientOptions = {}): PhoenixClient {
  return new PhoenixApiClient(options);
}

class PhoenixApiClient implements PhoenixClient {
  private readonly accessCode: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: PhoenixFetch;
  /** Local cache so repeat reads in the same process don't re-call `/v1/invite/activate`. */
  private activatedAt: string | undefined;

  constructor(options: PhoenixApiClientOptions) {
    const accessCode = options.accessCode?.trim() || process.env[PHOENIX_ACCESS_CODE_ENV]?.trim() || '';
    if (!accessCode) {
      throw new AdapterError(
        PHOENIX_ADAPTER_ID,
        'missing_access_code',
        `Phoenix API client requires an access code via Preferences or ${PHOENIX_ACCESS_CODE_ENV}.`,
      );
    }
    const defaultFetch = (globalThis as { fetch?: PhoenixFetch }).fetch;
    const fetchImpl = options.fetchImpl ?? defaultFetch;
    if (!fetchImpl) {
      throw new AdapterError(
        PHOENIX_ADAPTER_ID,
        'fetch_unavailable',
        'Phoenix API client requires global fetch or an injected fetch implementation.',
      );
    }
    this.accessCode = accessCode;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl?.trim() ||
      process.env[PHOENIX_API_BASE_URL_ENV]?.trim() ||
      PHOENIX_DEFAULT_API_BASE_URL,
    );
    this.fetchImpl = fetchImpl;
  }

  async activate(input: { accessCode: string; authority: string }): Promise<{ activatedAt: string }> {
    if (this.activatedAt) return { activatedAt: this.activatedAt };
    const body = JSON.stringify({ accessCode: input.accessCode, authority: input.authority });
    const json = await this.postJson('/v1/invite/activate', body);
    const activatedAt = extractActivatedAt(json) ?? new Date().toISOString();
    this.activatedAt = activatedAt;
    return { activatedAt };
  }

  async activateIfNeeded(authority: string): Promise<void> {
    if (this.activatedAt) return;
    await this.activate({ accessCode: this.accessCode, authority });
  }

  async fetchMarketSnapshot(input: { symbol: string }): Promise<PhoenixMarketSnapshot> {
    const json = await this.getJson('/v1/markets', { symbol: input.symbol });
    const row = firstRecord(json, input.symbol);
    return normalizeMarketSnapshot(row, input.symbol);
  }

  async fetchMarketCatalog(): Promise<PhoenixMarketSnapshot[]> {
    const json = await this.getJson('/v1/markets', {});
    const rows = extractRows(json, PHOENIX_ROW_KEYS);
    if (rows.length === 0) return [];
    return rows.map((row) => normalizeMarketSnapshot(row, optionalString(row, 'symbol') ?? ''));
  }

  async fetchTraderState(input: { authority: string; traderPdaIndex?: number }): Promise<PhoenixTraderStateSnapshot> {
    const json = await this.getJson('/v1/traders/state', {
      authority: input.authority,
      traderPdaIndex: String(input.traderPdaIndex ?? 0),
    });
    if (!isRecord(json)) {
      return {
        authority: input.authority,
        traderPdaIndex: input.traderPdaIndex ?? 0,
        positions: [],
        openOrders: [],
        triggers: [],
        asOf: new Date().toISOString(),
        warnings: ['Phoenix /v1/traders/state response was not a record; returning empty state.'],
      };
    }
    return {
      authority: input.authority,
      traderPdaIndex: input.traderPdaIndex ?? 0,
      ...(optionalString(json, 'freeCollateralUsd') !== undefined && {
        freeCollateralUsd: optionalString(json, 'freeCollateralUsd'),
      }),
      ...(optionalString(json, 'totalCollateralUsd') !== undefined && {
        totalCollateralUsd: optionalString(json, 'totalCollateralUsd'),
      }),
      positions: extractRows(json.positions ?? [], PHOENIX_ROW_KEYS).map((row) => ({
        symbol: optionalString(row, 'symbol') ?? '',
        side: optionalString(row, 'side') === 'short' ? 'short' : 'long',
        baseSize: optionalString(row, 'baseSize') ?? '0',
        ...(optionalString(row, 'entryPriceUsd') !== undefined && { entryPriceUsd: optionalString(row, 'entryPriceUsd') }),
        ...(optionalString(row, 'markPriceUsd') !== undefined && { markPriceUsd: optionalString(row, 'markPriceUsd') }),
        ...(optionalString(row, 'leverage') !== undefined && { leverage: optionalString(row, 'leverage') }),
        ...(optionalString(row, 'liquidationPriceUsd') !== undefined && {
          liquidationPriceUsd: optionalString(row, 'liquidationPriceUsd'),
        }),
        ...(optionalString(row, 'fundingPaidUsd') !== undefined && { fundingPaidUsd: optionalString(row, 'fundingPaidUsd') }),
        ...(optionalString(row, 'unrealizedPnlUsd') !== undefined && {
          unrealizedPnlUsd: optionalString(row, 'unrealizedPnlUsd'),
        }),
        ...(optionalNumber(row, 'marginRatio') !== undefined && { marginRatio: optionalNumber(row, 'marginRatio') }),
        ...(optionalNumber(row, 'healthPercent') !== undefined && { healthPercent: optionalNumber(row, 'healthPercent') }),
      })),
      openOrders: extractRows(json.openOrders ?? [], PHOENIX_ROW_KEYS).map(normalizeOrderRow),
      triggers: extractRows(json.triggers ?? [], PHOENIX_ROW_KEYS).map(normalizeOrderRow),
      asOf: optionalString(json, 'asOf') ?? new Date().toISOString(),
    };
  }

  async fetchFundingHistory(input: { symbol: string; limit?: number }): Promise<PhoenixFundingHistoryEntry[]> {
    const json = await this.getJson('/v1/markets/funding', {
      symbol: input.symbol,
      ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
    });
    const rows = extractRows(json, PHOENIX_ROW_KEYS);
    return rows
      .map((row) => {
        const symbol = optionalString(row, 'symbol') ?? input.symbol;
        const rateHourly = optionalString(row, 'rateHourly') ?? optionalString(row, 'rate') ?? '0';
        const observedAt = optionalString(row, 'observedAt') ?? optionalString(row, 'ts') ?? new Date().toISOString();
        const paidUsd = optionalString(row, 'paidUsd');
        return {
          symbol,
          rateHourly,
          observedAt,
          ...(paidUsd !== undefined && { paidUsd }),
        } satisfies PhoenixFundingHistoryEntry;
      });
  }

  private buildHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.accessCode}`,
      'x-phoenix-access-code': this.accessCode,
    };
  }

  private async getJson(path: string, params: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, { headers: this.buildHeaders() });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      const detail = responseErrorDetail(json) ?? (text.slice(0, 240) || response.statusText || 'request failed');
      throw new AdapterError(
        PHOENIX_ADAPTER_ID,
        'api_error',
        `Phoenix API ${path} failed (${response.status}): ${detail}`,
      );
    }
    return json;
  }

  private async postJson(path: string, body: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { ...this.buildHeaders(), 'content-type': 'application/json' },
      body,
    });
    const text = await response.text();
    const json = parseJson(text);
    if (!response.ok) {
      const detail = responseErrorDetail(json) ?? (text.slice(0, 240) || response.statusText || 'request failed');
      throw new AdapterError(
        PHOENIX_ADAPTER_ID,
        'api_error',
        `Phoenix API ${path} failed (${response.status}): ${detail}`,
      );
    }
    return json;
  }
}

function normalizeMarketSnapshot(row: unknown, fallbackSymbol: string): PhoenixMarketSnapshot {
  if (!isRecord(row)) {
    return { symbol: fallbackSymbol, asOf: new Date().toISOString(), warnings: ['Phoenix market row was not a record.'] };
  }
  return {
    symbol: optionalString(row, 'symbol') ?? fallbackSymbol,
    ...(optionalNumber(row, 'marketIndex') !== undefined && { marketIndex: optionalNumber(row, 'marketIndex') }),
    ...(optionalString(row, 'oracleSource') !== undefined && { oracleSource: optionalString(row, 'oracleSource') }),
    ...(optionalString(row, 'markPriceUsd') !== undefined && { markPriceUsd: optionalString(row, 'markPriceUsd') }),
    ...(optionalString(row, 'indexPriceUsd') !== undefined && { indexPriceUsd: optionalString(row, 'indexPriceUsd') }),
    ...(optionalString(row, 'fundingRateHourly') !== undefined && {
      fundingRateHourly: optionalString(row, 'fundingRateHourly'),
    }),
    ...(optionalString(row, 'openInterestUsd') !== undefined && {
      openInterestUsd: optionalString(row, 'openInterestUsd'),
    }),
    ...(optionalNumber(row, 'maxLeverage') !== undefined && { maxLeverage: optionalNumber(row, 'maxLeverage') }),
    ...(optionalNumber(row, 'takerFeeBps') !== undefined && { takerFeeBps: optionalNumber(row, 'takerFeeBps') }),
    ...(optionalNumber(row, 'makerFeeBps') !== undefined && { makerFeeBps: optionalNumber(row, 'makerFeeBps') }),
    asOf: optionalString(row, 'asOf') ?? new Date().toISOString(),
  };
}

function normalizeOrderRow(row: Record<string, unknown>): PhoenixOpenOrder {
  const sideRaw = optionalString(row, 'side');
  const typeRaw = optionalString(row, 'type');
  const triggerDirRaw = optionalString(row, 'triggerDirection');
  const side: PhoenixOpenOrder['side'] = sideRaw === 'short' ? 'short' : 'long';
  const type: PhoenixOpenOrder['type'] =
    typeRaw === 'limit' || typeRaw === 'stop_loss' ? typeRaw : 'market';
  const triggerDirection: PhoenixOpenOrder['triggerDirection'] | undefined =
    triggerDirRaw === 'less_than' || triggerDirRaw === 'greater_than' ? triggerDirRaw : undefined;
  const triggerTickPrice = optionalString(row, 'triggerTickPrice');
  const placedAt = optionalString(row, 'placedAt');
  return {
    orderId: optionalString(row, 'orderId') ?? '',
    symbol: optionalString(row, 'symbol') ?? '',
    side,
    type,
    baseSize: optionalString(row, 'baseSize') ?? '0',
    ...(triggerTickPrice !== undefined && { triggerTickPrice }),
    ...(triggerDirection !== undefined && { triggerDirection }),
    ...(placedAt !== undefined && { placedAt }),
  };
}

function firstRecord(value: unknown, symbol: string): unknown {
  if (!isRecord(value)) return value;
  const rows = extractRows(value, PHOENIX_ROW_KEYS);
  const match = rows.find((row) => optionalString(row, 'symbol') === symbol);
  return match ?? rows[0] ?? value;
}

function extractActivatedAt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['activatedAt', 'activated_at']) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return undefined;
}
