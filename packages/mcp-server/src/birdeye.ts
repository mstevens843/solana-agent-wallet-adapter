import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export const DEFAULT_BIRDEYE_REST_BASE = 'https://public-api.birdeye.so';

export interface BirdeyeConfig {
  apiKey?: string;
  restBase: string;
  wsUrl?: string;
  wsEnabled: boolean;
  chain: string;
}

export interface BirdeyeRequestInit {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function birdeyeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BirdeyeConfig {
  const apiKey = env.BIRDEYE_API_KEY?.trim() || undefined;
  const chain = (env.BIRDEYE_CHAIN?.trim() || 'solana').toLowerCase();
  const explicitWsUrl = env.BIRDEYE_WS_URL?.trim() || undefined;
  const wsEnabledByEnv = ['1', 'true', 'yes'].includes((env.BIRDEYE_WS_ENABLED ?? '').toLowerCase());
  const wsUrl = explicitWsUrl ?? (apiKey && wsEnabledByEnv
    ? `wss://public-api.birdeye.so/socket/${chain}?x-api-key=${encodeURIComponent(apiKey)}`
    : undefined);
  return {
    apiKey,
    restBase: (env.BIRDEYE_REST_BASE?.trim() || DEFAULT_BIRDEYE_REST_BASE).replace(/\/+$/, ''),
    ...(wsUrl ? { wsUrl } : {}),
    wsEnabled: Boolean(wsUrl),
    chain,
  };
}

export async function requestBirdeye(
  path: string,
  init: BirdeyeRequestInit = {},
): Promise<Record<string, unknown>> {
  const config = birdeyeConfigFromEnv(init.env);
  if (!config.apiKey) {
    throw new ProtocolError('unauthorized', 'Missing BirdEye API key. Set BIRDEYE_API_KEY.');
  }
  const url = new URL(path.startsWith('/') ? `${config.restBase}${path}` : `${config.restBase}/${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-chain': config.chain,
    'X-API-KEY': config.apiKey,
  };
  if (init.body) {
    headers['content-type'] = 'application/json';
  }
  const requester = init.fetchImpl ?? fetch;
  const response = await requester(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload = await response.json().catch(() => ({})) as unknown;
  const record = asJsonRecord(payload);
  if (!response.ok) {
    throw new ProtocolError('wallet_unreachable', `BirdEye request failed with HTTP ${response.status}: ${JSON.stringify(record)}`);
  }
  return record;
}

export async function requestBirdeyePriceMulti(
  addresses: string[],
  options: { includeLiquidity?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const list = normalizeAddressList(addresses, 100);
  if (!list.length) {
    throw new ProtocolError('invalid_request', 'BirdEye price request requires at least one token address.');
  }
  return requestBirdeye('/defi/multi_price', {
    method: 'POST',
    query: {
      include_liquidity: options.includeLiquidity ?? true,
    },
    body: {
      list_address: list.join(','),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyePrice(
  address: string,
  options: { includeLiquidity?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const mint = requireTrimmed(address, 'address');
  return requestBirdeye('/defi/price', {
    query: {
      address: mint,
      include_liquidity: options.includeLiquidity ?? true,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyePriceVolumeSingle(
  address: string,
  options: {
    type?: BirdeyePriceVolumeType;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/price_volume/single', {
    query: {
      address: requireTrimmed(address, 'address'),
      type: options.type ?? '24h',
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyePriceVolumeMulti(
  addresses: string[],
  options: {
    type?: BirdeyePriceVolumeType;
    uiAmountMode?: 'raw' | 'scaled' | 'both';
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  const list = normalizeAddressList(addresses, 50);
  if (!list.length) {
    throw new ProtocolError('invalid_request', 'BirdEye price-volume request requires at least one token address.');
  }
  return requestBirdeye('/defi/price_volume/multi', {
    method: 'POST',
    query: {
      ui_amount_mode: options.uiAmountMode ?? 'raw',
    },
    body: {
      list_address: list.join(','),
      type: options.type ?? '24h',
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeHistoryPrice(
  address: string,
  options: {
    addressType?: 'token' | 'pair';
    type?: BirdeyeHistoryPriceType;
    timeFrom?: number;
    timeTo?: number;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/history_price', {
    query: {
      address: requireTrimmed(address, 'address'),
      address_type: options.addressType ?? 'token',
      type: options.type ?? '15m',
      time_from: options.timeFrom,
      time_to: options.timeTo,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeOhlcv(
  address: string,
  options: {
    type?: BirdeyeOhlcvType;
    timeFrom?: number;
    timeTo?: number;
    currency?: 'usd' | 'native';
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  return requestBirdeye('/defi/v3/ohlcv', {
    query: {
      address: requireTrimmed(address, 'address'),
      type: options.type ?? '15m',
      time_from: options.timeFrom ?? now - 60 * 60,
      time_to: options.timeTo ?? now,
      currency: options.currency ?? 'usd',
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeSearch(
  keyword: string,
  options: { limit?: number; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const query = keyword.trim();
  if (!query) {
    throw new ProtocolError('invalid_request', 'BirdEye search keyword is required.');
  }
  return requestBirdeye('/defi/v3/search', {
    method: 'GET',
    query: {
      chain: 'solana',
      keyword: query,
      target: 'token',
      search_mode: 'fuzzy',
      search_by: 'combination',
      sort_by: 'volume_24h_usd',
      sort_type: 'desc',
      limit: Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 20),
      offset: 0,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenMetadata(
  addresses: string[],
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const list = normalizeAddressList(addresses, 50);
  if (!list.length) {
    throw new ProtocolError('invalid_request', 'BirdEye token metadata request requires at least one token address.');
  }
  return requestBirdeye('/defi/v3/token/meta-data/multiple', {
    method: 'GET',
    query: {
      list_address: list.join(','),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenMetadataSingle(
  address: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/v3/token/meta-data/single', {
    query: {
      address: requireTrimmed(address, 'address'),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenSecurity(
  address: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new ProtocolError('invalid_request', 'BirdEye token security request requires a token mint address.');
  }
  return requestBirdeye('/defi/token_security', {
    method: 'GET',
    query: {
      address: trimmed,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenCreationInfo(
  address: string,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/token_creation_info', {
    query: {
      address: requireTrimmed(address, 'address'),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenHolders(
  address: string,
  options: {
    limit?: number;
    offset?: number;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/v3/token/holder', {
    query: {
      address: requireTrimmed(address, 'address'),
      limit: boundedInteger(options.limit, 100, 1, 1000),
      offset: Math.max(0, Math.trunc(options.offset ?? 0)),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeExitLiquidityMulti(
  addresses: string[],
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const list = normalizeAddressList(addresses, 50);
  if (!list.length) {
    throw new ProtocolError('invalid_request', 'BirdEye exit-liquidity request requires at least one token address.');
  }
  return requestBirdeye('/defi/v3/token/exit-liquidity/multiple', {
    query: {
      addresses: list.join(','),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTrendingTokens(
  options: {
    limit?: number;
    offset?: number;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/token_trending', {
    query: {
      sort_by: 'rank',
      sort_type: 'asc',
      limit: boundedInteger(options.limit, 20, 1, 20),
      offset: Math.max(0, Math.trunc(options.offset ?? 0)),
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeNewListings(
  options: {
    limit?: number;
    timeTo?: number;
    includeMeme?: boolean;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/v2/tokens/new_listing', {
    query: {
      limit: boundedInteger(options.limit, 20, 1, 100),
      meme_platform_enabled: options.includeMeme ?? true,
      time_to: options.timeTo,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeTokenListV3(
  options: {
    sortBy?: BirdeyeTokenListSortBy;
    sortType?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
    minLiquidity?: number;
    minVolume24hUsd?: number;
    includeMeme?: boolean;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/defi/v3/token/list', {
    query: {
      sort_by: options.sortBy ?? 'v24hUSD',
      sort_type: options.sortType ?? 'desc',
      limit: boundedInteger(options.limit, 50, 1, 100),
      offset: Math.max(0, Math.trunc(options.offset ?? 0)),
      min_liquidity: options.minLiquidity,
      min_volume_24h_usd: options.minVolume24hUsd,
      meme_platform_enabled: options.includeMeme,
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export async function requestBirdeyeWalletTokenList(
  wallet: string,
  options: {
    uiAmountMode?: 'raw' | 'scaled' | 'both';
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Record<string, unknown>> {
  return requestBirdeye('/v1/wallet/token_list', {
    query: {
      wallet: requireTrimmed(wallet, 'wallet'),
      ui_amount_mode: options.uiAmountMode ?? 'scaled',
    },
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
}

export type BirdeyePriceVolumeType = '1h' | '2h' | '4h' | '8h' | '24h';
export type BirdeyeHistoryPriceType = '1m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '8H' | '12H' | '1D';
export type BirdeyeOhlcvType = '1m' | '3m' | '5m' | '15m' | '30m' | '1H' | '2H' | '4H' | '6H' | '8H' | '12H' | '1D' | '1W';
export type BirdeyeTokenListSortBy =
  | 'liquidity'
  | 'market_cap'
  | 'fdv'
  | 'v24hUSD'
  | 'v24hChangePercent'
  | 'price'
  | 'priceChange24h'
  | 'trade24h'
  | 'uniqueWallet24h'
  | 'last_trade_unix_time'
  | 'recent_listing_time';

function normalizeAddressList(addresses: string[], limit: number): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const address of addresses) {
    const trimmed = address.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    list.push(trimmed);
    if (list.length >= limit) break;
  }
  return list;
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProtocolError('invalid_request', `BirdEye ${field} is required.`);
  }
  return trimmed;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined) return fallback;
  return Math.min(Math.max(value, min), max);
}

function asJsonRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}
