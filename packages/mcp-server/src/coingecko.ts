import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { KvCache } from './adapters/alternative_me/index.js';
import { createFsKvCache } from './adapters/alternative_me/kvCaches.js';

export const DEFAULT_COINGECKO_PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
export const DEFAULT_COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';
export const COINGECKO_RESPONSE_BYTE_LIMIT = 512_000;
export const COINGECKO_ENDPOINT_OVERVIEW_URL = 'https://docs.coingecko.com/reference/endpoint-overview';
/** Hard ceiling on a single CoinGecko REST call so a hung upstream cannot pin a request socket. */
const COINGECKO_REQUEST_TIMEOUT_MS = 15_000;
const COINGECKO_GLOBAL_TTL_MS = 5 * 60 * 1000;
const COINGECKO_GLOBAL_KV_KEY = 'coingecko:global';

export interface CoinGeckoConfig {
  apiKey?: string;
  restBase: string;
  /** Whether the configured key targets the pro endpoint (true) or public (false). */
  pro: boolean;
}

export interface CoinGeckoRequestInit {
  query?: Record<string, string | number | boolean | undefined>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface CoinGeckoEndpointCatalogEntry {
  provider: 'coingecko';
  endpointId: string;
  method: 'GET';
  pathTemplate: string;
  product:
    | 'ping'
    | 'key'
    | 'simple'
    | 'search'
    | 'coins'
    | 'contract'
    | 'asset_platforms'
    | 'categories'
    | 'exchanges'
    | 'derivatives'
    | 'public_treasury'
    | 'nfts'
    | 'exchange_rates'
    | 'trending'
    | 'news'
    | 'global'
    | 'onchain';
  access: 'starter';
  risk: 'review_evidence';
  requiredPathParams?: string[];
  allowedQueryParams?: string[];
  freshnessSeconds?: number;
  sourceUrl: string;
  description: string;
}

export interface CoinGeckoEndpointReadInput {
  endpointId: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface CoinGeckoSolanaTokenEvidenceInput {
  mint?: string;
  mints?: string[];
  network?: string;
  includeOnchain?: boolean;
  maxTokenDetails?: number;
}

export interface CoinGeckoTokenEvidence {
  mint: string;
  priceUsd?: number;
  marketCapUsd?: number;
  volume24hUsd?: number;
  change24hPct?: number;
  lastUpdatedAt?: string;
  onchainPriceUsd?: number;
  name?: string;
  symbol?: string;
  coingeckoId?: string;
  poolCount?: number;
}

export const COINGECKO_ENDPOINT_CATALOG: CoinGeckoEndpointCatalogEntry[] = [
  endpoint('ping', 'ping.status', '/ping', 'Check the API server status.'),
  endpoint('key', 'key.usage', '/key', 'Check account API usage.'),
  endpoint('simple', 'simple.price', '/simple/price', 'Read prices by CoinGecko coin IDs.', [], ['ids', 'vs_currencies', 'include_market_cap', 'include_24hr_vol', 'include_24hr_change', 'include_last_updated_at', 'precision']),
  endpoint('simple', 'simple.token_price', '/simple/token_price/{asset_platform_id}', 'Read token prices by contract address on an asset platform.', ['asset_platform_id'], ['contract_addresses', 'vs_currencies', 'include_market_cap', 'include_24hr_vol', 'include_24hr_change', 'include_last_updated_at', 'precision']),
  endpoint('simple', 'simple.supported_vs_currencies', '/simple/supported_vs_currencies', 'List supported quote currencies.'),
  endpoint('coins', 'coins.list', '/coins/list', 'List supported coins.', [], ['include_platform']),
  endpoint('coins', 'coins.markets', '/coins/markets', 'Read price, market cap, volume, and market data for coins.', [], ['vs_currency', 'ids', 'category', 'order', 'per_page', 'page', 'sparkline', 'price_change_percentage', 'locale', 'precision']),
  endpoint('coins', 'coins.detail', '/coins/{id}', 'Read coin metadata and market detail by CoinGecko ID.', ['id'], ['localization', 'tickers', 'market_data', 'community_data', 'developer_data', 'sparkline']),
  endpoint('coins', 'coins.tickers', '/coins/{id}/tickers', 'Read CEX/DEX tickers for a coin.', ['id'], ['exchange_ids', 'include_exchange_logo', 'page', 'order', 'depth']),
  endpoint('coins', 'coins.history', '/coins/{id}/history', 'Read historical data for a coin at a date.', ['id'], ['date', 'localization']),
  endpoint('coins', 'coins.market_chart', '/coins/{id}/market_chart', 'Read historical market chart for a coin.', ['id'], ['vs_currency', 'days', 'interval', 'precision']),
  endpoint('coins', 'coins.market_chart_range', '/coins/{id}/market_chart/range', 'Read historical market chart over a timestamp range.', ['id'], ['vs_currency', 'from', 'to', 'precision']),
  endpoint('coins', 'coins.ohlc', '/coins/{id}/ohlc', 'Read OHLC data for a coin.', ['id'], ['vs_currency', 'days', 'precision']),
  endpoint('coins', 'coins.categories_list', '/coins/categories/list', 'List CoinGecko coin categories.'),
  endpoint('coins', 'coins.categories', '/coins/categories', 'Read coin categories with market data.', [], ['order']),
  endpoint('contract', 'contract.detail', '/coins/{asset_platform_id}/contract/{contract_address}', 'Read token metadata by asset platform and contract address.', ['asset_platform_id', 'contract_address']),
  endpoint('contract', 'contract.market_chart', '/coins/{asset_platform_id}/contract/{contract_address}/market_chart', 'Read token contract market chart.', ['asset_platform_id', 'contract_address'], ['vs_currency', 'days', 'precision']),
  endpoint('contract', 'contract.market_chart_range', '/coins/{asset_platform_id}/contract/{contract_address}/market_chart/range', 'Read token contract market chart over a timestamp range.', ['asset_platform_id', 'contract_address'], ['vs_currency', 'from', 'to', 'precision']),
  endpoint('asset_platforms', 'asset_platforms.list', '/asset_platforms', 'List supported asset platforms.', [], ['filter']),
  endpoint('asset_platforms', 'token_lists.all', '/token_lists/{asset_platform_id}/all.json', 'Read a supported asset platform token list.', ['asset_platform_id']),
  endpoint('search', 'search.query', '/search', 'Search coins, categories, and markets.', [], ['query']),
  endpoint('trending', 'search.trending', '/search/trending', 'Read trending coins, NFTs, and categories.'),
  endpoint('global', 'global.crypto', '/global', 'Read global crypto market data.'),
  endpoint('global', 'global.defi', '/global/decentralized_finance_defi', 'Read global DeFi market data.'),
  endpoint('global', 'global.market_cap_chart', '/global/market_cap_chart', 'Read global market-cap chart data.', [], ['vs_currency', 'days']),
  endpoint('exchange_rates', 'exchange_rates.btc', '/exchange_rates', 'Read BTC exchange rates.'),
  endpoint('exchanges', 'exchanges.list_detailed', '/exchanges', 'Read active exchanges with volume data.', [], ['per_page', 'page']),
  endpoint('exchanges', 'exchanges.list', '/exchanges/list', 'List supported exchanges.'),
  endpoint('exchanges', 'exchanges.detail', '/exchanges/{id}', 'Read exchange metadata and tickers.', ['id']),
  endpoint('exchanges', 'exchanges.tickers', '/exchanges/{id}/tickers', 'Read exchange tickers.', ['id'], ['coin_ids', 'include_exchange_logo', 'page', 'depth', 'order']),
  endpoint('exchanges', 'exchanges.volume_chart', '/exchanges/{id}/volume_chart', 'Read historical exchange volume chart.', ['id'], ['days']),
  endpoint('derivatives', 'derivatives.tickers', '/derivatives', 'Read derivatives tickers.'),
  endpoint('derivatives', 'derivatives.exchanges', '/derivatives/exchanges', 'Read derivatives exchanges.', [], ['order', 'per_page', 'page']),
  endpoint('derivatives', 'derivatives.exchange_detail', '/derivatives/exchanges/{id}', 'Read derivatives exchange detail.', ['id']),
  endpoint('derivatives', 'derivatives.exchanges_list', '/derivatives/exchanges/list', 'List derivatives exchanges.'),
  endpoint('nfts', 'nfts.list', '/nfts/list', 'List supported NFT collections.', [], ['order', 'per_page', 'page']),
  endpoint('nfts', 'nfts.detail', '/nfts/{id}', 'Read NFT collection market data.', ['id']),
  endpoint('nfts', 'nfts.contract_detail', '/nfts/{asset_platform_id}/contract/{contract_address}', 'Read NFT collection data by contract.', ['asset_platform_id', 'contract_address']),
  endpoint('nfts', 'nfts.markets', '/nfts/markets', 'Read NFT collections with floor, cap, and volume market data.', [], ['asset_platform_id', 'order', 'per_page', 'page']),
  endpoint('public_treasury', 'entities.list', '/entities/list', 'List supported public treasury entities.'),
  endpoint('public_treasury', 'public_treasury.by_coin', '/{entity}/public_treasury/{coin_id}', 'Read public treasury holdings by entity and coin.', ['entity', 'coin_id']),
  endpoint('public_treasury', 'public_treasury.by_entity', '/public_treasury/{entity_id}', 'Read public treasury holdings by entity ID.', ['entity_id']),
  endpoint('news', 'news.latest', '/news', 'Read latest CoinGecko news.', [], ['page']),
  endpoint('onchain', 'onchain.simple_token_price', '/onchain/simple/networks/{network}/token_price/{addresses}', 'Read GeckoTerminal token prices by network and addresses.', ['network', 'addresses'], ['include_market_cap']),
  endpoint('onchain', 'onchain.networks', '/onchain/networks', 'List supported GeckoTerminal networks.'),
  endpoint('onchain', 'onchain.dexes', '/onchain/networks/{network}/dexes', 'List DEXes on a network.', ['network'], ['page']),
  endpoint('onchain', 'onchain.pool', '/onchain/networks/{network}/pools/{pool_address}', 'Read a specific pool by address.', ['network', 'pool_address'], ['include']),
  endpoint('onchain', 'onchain.pools_multi', '/onchain/networks/{network}/pools/multi/{addresses}', 'Read multiple pools by address.', ['network', 'addresses'], ['include']),
  endpoint('onchain', 'onchain.trending_pools_all', '/onchain/networks/trending_pools', 'Read trending pools across networks.', [], ['include', 'page', 'duration']),
  endpoint('onchain', 'onchain.trending_pools', '/onchain/networks/{network}/trending_pools', 'Read trending pools on a network.', ['network'], ['include', 'page', 'duration']),
  endpoint('onchain', 'onchain.top_pools', '/onchain/networks/{network}/pools', 'Read top pools on a network.', ['network'], ['include', 'page', 'sort']),
  endpoint('onchain', 'onchain.dex_pools', '/onchain/networks/{network}/dexes/{dex}/pools', 'Read top pools for a network DEX.', ['network', 'dex'], ['include', 'page', 'sort']),
  endpoint('onchain', 'onchain.new_pools_all', '/onchain/networks/new_pools', 'Read latest pools across networks.', [], ['include', 'page']),
  endpoint('onchain', 'onchain.new_pools', '/onchain/networks/{network}/new_pools', 'Read latest pools on a network.', ['network'], ['include', 'page']),
  endpoint('onchain', 'onchain.search_pools', '/onchain/search/pools', 'Search pools on GeckoTerminal.', [], ['query', 'network', 'include', 'page']),
  endpoint('onchain', 'onchain.token_pools', '/onchain/networks/{network}/tokens/{address}/pools', 'Read top pools for a token.', ['network', 'address'], ['include', 'page', 'sort']),
  endpoint('onchain', 'onchain.token', '/onchain/networks/{network}/tokens/{address}', 'Read token market data on a network.', ['network', 'address'], ['include']),
  endpoint('onchain', 'onchain.tokens_multi', '/onchain/networks/{network}/tokens/multi/{addresses}', 'Read multiple tokens on a network.', ['network', 'addresses'], ['include']),
  endpoint('onchain', 'onchain.token_info', '/onchain/networks/{network}/tokens/{address}/info', 'Read token metadata, socials, and websites.', ['network', 'address']),
  endpoint('onchain', 'onchain.pool_info', '/onchain/networks/{network}/pools/{pool_address}/info', 'Read pool metadata.', ['network', 'pool_address']),
  endpoint('onchain', 'onchain.tokens_info_recently_updated', '/onchain/tokens/info_recently_updated', 'Read recently updated token metadata.', [], ['include', 'page']),
  endpoint('onchain', 'onchain.token_top_holders', '/onchain/networks/{network}/tokens/{address}/top_holders', 'Read top token holders.', ['network', 'address']),
  endpoint('onchain', 'onchain.pool_ohlcv', '/onchain/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}', 'Read pool OHLCV.', ['network', 'pool_address', 'timeframe'], ['aggregate', 'before_timestamp', 'limit', 'currency', 'token']),
  endpoint('onchain', 'onchain.token_ohlcv', '/onchain/networks/{network}/tokens/{address}/ohlcv/{timeframe}', 'Read token OHLCV.', ['network', 'address', 'timeframe'], ['aggregate', 'before_timestamp', 'limit', 'currency']),
  endpoint('onchain', 'onchain.pool_trades', '/onchain/networks/{network}/pools/{pool_address}/trades', 'Read recent pool trades.', ['network', 'pool_address'], ['trade_volume_in_usd_greater_than']),
  endpoint('onchain', 'onchain.token_trades', '/onchain/networks/{network}/tokens/{address}/trades', 'Read recent token trades across pools.', ['network', 'address'], ['trade_volume_in_usd_greater_than']),
  endpoint('onchain', 'onchain.categories', '/onchain/categories', 'List GeckoTerminal categories.'),
  endpoint('onchain', 'onchain.category_pools', '/onchain/categories/{category}/pools', 'Read pools for an onchain category.', ['category'], ['include', 'page']),
];

export function coinGeckoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CoinGeckoConfig {
  const apiKey = env.COINGECKO_API_KEY?.trim() || undefined;
  const explicitBase = env.COINGECKO_REST_BASE?.trim();
  if (explicitBase) {
    return { apiKey, restBase: explicitBase.replace(/\/+$/, ''), pro: apiKey ? true : false };
  }
  if (apiKey) {
    return { apiKey, restBase: DEFAULT_COINGECKO_PRO_BASE, pro: true };
  }
  return { restBase: DEFAULT_COINGECKO_PUBLIC_BASE, pro: false };
}

export async function requestCoinGecko(
  path: string,
  init: CoinGeckoRequestInit = {},
): Promise<Record<string, unknown>> {
  const config = coinGeckoConfigFromEnv(init.env);
  const url = new URL(path.startsWith('/') ? `${config.restBase}${path}` : `${config.restBase}/${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.apiKey) {
    // Pro endpoint authenticates via x-cg-pro-api-key; demo/public accepts x-cg-demo-api-key.
    headers[config.pro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = config.apiKey;
  }
  const requester = init.fetchImpl ?? fetch;
  const response = await requester(url, {
    method: 'GET',
    headers,
    // Bound the public-relay call so a slow/hung upstream cannot pin a server socket.
    signal: AbortSignal.timeout(COINGECKO_REQUEST_TIMEOUT_MS),
  });
  const payload = await readCoinGeckoPayload(response);
  const record = asJsonRecord(payload) ?? { data: payload };
  if (!response.ok) {
    throw new ProtocolError(
      'wallet_unreachable',
      `CoinGecko request failed with HTTP ${response.status}: ${JSON.stringify(record)}`,
    );
  }
  return record;
}

export function listCoinGeckoEndpointCatalog(): Record<string, unknown> {
  return {
    provider: 'coingecko',
    docs: COINGECKO_ENDPOINT_OVERVIEW_URL,
    access: 'starter',
    boundary: 'review_evidence_only',
    endpoints: COINGECKO_ENDPOINT_CATALOG,
  };
}

export async function requestCoinGeckoEndpoint(
  input: CoinGeckoEndpointReadInput,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const entry = coingeckoEndpointById(input.endpointId);
  const query = validatedQuery(entry, input.query ?? {});
  const path = fillPathTemplate(entry, input.pathParams ?? {});
  const data = await requestCoinGecko(path, { env: options.env, fetchImpl: options.fetchImpl, query });
  return {
    provider: 'coingecko',
    endpointId: entry.endpointId,
    product: entry.product,
    checkedAt: new Date().toISOString(),
    source: entry.sourceUrl,
    data,
  };
}

export async function requestCoinGeckoSolanaTokenEvidence(
  input: CoinGeckoSolanaTokenEvidenceInput,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, unknown>> {
  const network = input.network?.trim() || 'solana';
  const mints = normalizeMints(input);
  const checkedAt = new Date().toISOString();
  const warnings: string[] = [];
  const simple = await requestCoinGecko('/simple/token_price/solana', {
    env: options.env,
    fetchImpl: options.fetchImpl,
    query: {
      contract_addresses: mints.join(','),
      vs_currencies: 'usd',
      include_market_cap: true,
      include_24hr_vol: true,
      include_24hr_change: true,
      include_last_updated_at: true,
    },
  }).catch((err) => {
    warnings.push(errorMessage('CoinGecko simple token price unavailable', err));
    return {};
  });
  const onchain = input.includeOnchain === false
    ? {}
    : await requestCoinGecko(`/onchain/simple/networks/${encodeURIComponent(network)}/token_price/${mints.map((mint) => encodeURIComponent(mint)).join(',')}`, {
      env: options.env,
      fetchImpl: options.fetchImpl,
      query: { include_market_cap: true },
    }).catch((err) => {
      warnings.push(errorMessage('CoinGecko onchain token price unavailable', err));
      return {};
    });
  const maxDetails = clampInteger(input.maxTokenDetails, 0, 5, 3);
  const details = new Map<string, Record<string, unknown>>();
  await Promise.all(mints.slice(0, maxDetails).map(async (mint) => {
    const detail = await requestCoinGecko(`/onchain/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(mint)}/info`, {
      env: options.env,
      fetchImpl: options.fetchImpl,
    }).catch(() => undefined);
    if (detail) details.set(mint.toLowerCase(), detail);
  }));
  const tokens = mints.map((mint) => tokenEvidenceForMint(mint, simple, onchain, details.get(mint.toLowerCase())));
  return {
    provider: 'coingecko',
    product: 'solana_token_evidence',
    network,
    checkedAt,
    tokens,
    warnings,
    sources: [
      {
        title: 'CoinGecko Simple Token Price',
        url: 'https://docs.coingecko.com/reference/simple-token-price',
      },
      {
        title: 'CoinGecko Onchain DEX API',
        url: COINGECKO_ENDPOINT_OVERVIEW_URL,
      },
    ],
  };
}

export interface CoinGeckoGlobalSnapshot {
  totalMarketCapUsd?: number;
  totalVolume24hUsd?: number;
  marketCapChangePct24hUsd?: number;
  btcDominancePct?: number;
  ethDominancePct?: number;
  updatedAt?: string;
}

interface CoinGeckoGlobalCacheEntry {
  snapshot: CoinGeckoGlobalSnapshot;
  fetchedAtMs: number;
}

let coinGeckoGlobalCache: CoinGeckoGlobalCacheEntry | undefined;
let coinGeckoGlobalKvPath: string | undefined;
let coinGeckoGlobalKv: KvCache | undefined;

export async function requestCoinGeckoGlobal(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<CoinGeckoGlobalSnapshot> {
  if (!options.fetchImpl) {
    const cached = await readCoinGeckoGlobalCache(options.env);
    if (cached) return cached;
  }
  const payload = await requestCoinGecko('/global', { env: options.env, fetchImpl: options.fetchImpl });
  const data = asJsonRecord(payload.data ?? payload);
  if (!data) return {};
  const totalMarketCap = asJsonRecord(data.total_market_cap);
  const totalVolume = asJsonRecord(data.total_volume);
  const marketCapPct = asJsonRecord(data.market_cap_percentage);
  const marketCapChange = typeof data.market_cap_change_percentage_24h_usd === 'number'
    ? data.market_cap_change_percentage_24h_usd as number
    : undefined;
  const updatedAtSeconds = typeof data.updated_at === 'number' ? data.updated_at as number : undefined;
  const snapshot: CoinGeckoGlobalSnapshot = {
    ...(totalMarketCap && typeof totalMarketCap.usd === 'number' ? { totalMarketCapUsd: totalMarketCap.usd as number } : {}),
    ...(totalVolume && typeof totalVolume.usd === 'number' ? { totalVolume24hUsd: totalVolume.usd as number } : {}),
    ...(marketCapChange !== undefined ? { marketCapChangePct24hUsd: marketCapChange } : {}),
    ...(marketCapPct && typeof marketCapPct.btc === 'number' ? { btcDominancePct: marketCapPct.btc as number } : {}),
    ...(marketCapPct && typeof marketCapPct.eth === 'number' ? { ethDominancePct: marketCapPct.eth as number } : {}),
    ...(updatedAtSeconds !== undefined
      ? { updatedAt: new Date(updatedAtSeconds * 1000).toISOString() }
      : {}),
  };
  if (!options.fetchImpl) {
    await writeCoinGeckoGlobalCache(snapshot, options.env);
  }
  return snapshot;
}

async function readCoinGeckoGlobalCache(env: NodeJS.ProcessEnv = process.env): Promise<CoinGeckoGlobalSnapshot | undefined> {
  const now = Date.now();
  if (coinGeckoGlobalCache && now - coinGeckoGlobalCache.fetchedAtMs < COINGECKO_GLOBAL_TTL_MS) {
    return coinGeckoGlobalCache.snapshot;
  }
  const kv = coinGeckoGlobalKvCacheFromEnv(env);
  if (!kv) return undefined;
  try {
    const stored = await kv.get<CoinGeckoGlobalCacheEntry>(COINGECKO_GLOBAL_KV_KEY);
    if (stored && typeof stored.fetchedAtMs === 'number' && now - stored.fetchedAtMs < COINGECKO_GLOBAL_TTL_MS) {
      coinGeckoGlobalCache = stored;
      return stored.snapshot;
    }
  } catch {
    // KV failure must not block a live CoinGecko fetch.
  }
  return undefined;
}

async function writeCoinGeckoGlobalCache(
  snapshot: CoinGeckoGlobalSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const entry: CoinGeckoGlobalCacheEntry = { snapshot, fetchedAtMs: Date.now() };
  coinGeckoGlobalCache = entry;
  const kv = coinGeckoGlobalKvCacheFromEnv(env);
  if (!kv) return;
  try {
    await kv.set(COINGECKO_GLOBAL_KV_KEY, entry, COINGECKO_GLOBAL_TTL_MS);
  } catch {
    // Best-effort only.
  }
}

function coinGeckoGlobalKvCacheFromEnv(env: NodeJS.ProcessEnv): KvCache | undefined {
  const path = (env.AGENT_WALLET_KV_CACHE_PATH ?? '').trim();
  if (!path) return undefined;
  if (coinGeckoGlobalKv && coinGeckoGlobalKvPath === path) return coinGeckoGlobalKv;
  try {
    coinGeckoGlobalKv = createFsKvCache(path);
    coinGeckoGlobalKvPath = path;
    return coinGeckoGlobalKv;
  } catch {
    coinGeckoGlobalKv = undefined;
    coinGeckoGlobalKvPath = undefined;
    return undefined;
  }
}

function asJsonRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return undefined;
}

async function readCoinGeckoPayload(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > COINGECKO_RESPONSE_BYTE_LIMIT) {
    throw new ProtocolError(
      'wallet_unreachable',
      `CoinGecko response exceeded ${COINGECKO_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`,
    );
  }
  const text = await response.text();
  if (text.length > COINGECKO_RESPONSE_BYTE_LIMIT) {
    throw new ProtocolError(
      'wallet_unreachable',
      `CoinGecko response exceeded ${COINGECKO_RESPONSE_BYTE_LIMIT} bytes; refusing to read further.`,
    );
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'CoinGecko returned non-JSON response.' };
  }
}

function endpoint(
  product: CoinGeckoEndpointCatalogEntry['product'],
  endpointId: string,
  pathTemplate: string,
  description: string,
  requiredPathParams: string[] = [],
  allowedQueryParams: string[] = [],
): CoinGeckoEndpointCatalogEntry {
  return {
    provider: 'coingecko',
    endpointId,
    method: 'GET',
    pathTemplate,
    product,
    access: 'starter',
    risk: 'review_evidence',
    ...(requiredPathParams.length ? { requiredPathParams } : {}),
    ...(allowedQueryParams.length ? { allowedQueryParams } : {}),
    freshnessSeconds: defaultFreshnessSeconds(product),
    sourceUrl: COINGECKO_ENDPOINT_OVERVIEW_URL,
    description,
  };
}

function defaultFreshnessSeconds(product: CoinGeckoEndpointCatalogEntry['product']): number {
  if (product === 'simple' || product === 'onchain') return 60;
  if (product === 'coins' || product === 'global' || product === 'trending') return 300;
  return 900;
}

function coingeckoEndpointById(endpointId: string): CoinGeckoEndpointCatalogEntry {
  const entry = COINGECKO_ENDPOINT_CATALOG.find((candidate) => candidate.endpointId === endpointId);
  if (!entry) {
    throw new ProtocolError('invalid_request', `Unknown CoinGecko endpointId ${endpointId}.`);
  }
  return entry;
}

function fillPathTemplate(entry: CoinGeckoEndpointCatalogEntry, pathParams: Record<string, string | number>): string {
  let path = entry.pathTemplate;
  for (const param of entry.requiredPathParams ?? []) {
    const value = pathParams[param];
    if (value === undefined || String(value).trim() === '') {
      throw new ProtocolError('invalid_request', `CoinGecko endpoint ${entry.endpointId} requires pathParams.${param}.`);
    }
    path = path.replace(`{${param}}`, encodeURIComponent(String(value).trim()));
  }
  const unresolved = path.match(/\{[^}]+\}/);
  if (unresolved) {
    throw new ProtocolError('invalid_request', `CoinGecko endpoint ${entry.endpointId} is missing ${unresolved[0]}.`);
  }
  return path;
}

function validatedQuery(
  entry: CoinGeckoEndpointCatalogEntry,
  query: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean | undefined> {
  const allowed = new Set(entry.allowedQueryParams ?? []);
  if (!allowed.size) {
    const unexpected = Object.keys(query).filter((key) => query[key] !== undefined);
    if (unexpected.length) {
      throw new ProtocolError('invalid_request', `CoinGecko endpoint ${entry.endpointId} does not accept query params: ${unexpected.join(', ')}.`);
    }
    return {};
  }
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) {
      throw new ProtocolError('invalid_request', `CoinGecko endpoint ${entry.endpointId} does not allow query param ${key}.`);
    }
    out[key] = value;
  }
  return out;
}

function normalizeMints(input: CoinGeckoSolanaTokenEvidenceInput): string[] {
  const values = [...(input.mints ?? []), ...(input.mint ? [input.mint] : [])];
  const mints = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!mints.length) {
    throw new ProtocolError('invalid_request', 'At least one Solana token mint is required for CoinGecko token evidence.');
  }
  if (mints.length > 10) {
    throw new ProtocolError('invalid_request', 'CoinGecko token evidence supports at most 10 mints per request.');
  }
  return mints;
}

function tokenEvidenceForMint(
  mint: string,
  simple: Record<string, unknown>,
  onchain: Record<string, unknown>,
  detail: Record<string, unknown> | undefined,
): CoinGeckoTokenEvidence {
  const simpleEntry = findRecordByLowercaseKey(simple, mint);
  const tokenPrices = nestedRecord(onchain, ['data', 'attributes', 'token_prices']);
  const onchainPrice = tokenPrices ? numericField(findRecordByLowercaseKey(tokenPrices, mint) ?? tokenPrices, mint) : undefined;
  const detailData = asJsonRecord(detail?.data ?? detail);
  const attrs = asJsonRecord(detailData?.attributes ?? detailData);
  const evidence: CoinGeckoTokenEvidence = { mint };
  const priceUsd = numericField(simpleEntry, 'usd');
  if (priceUsd !== undefined) evidence.priceUsd = priceUsd;
  const marketCapUsd = numericField(simpleEntry, 'usd_market_cap');
  if (marketCapUsd !== undefined) evidence.marketCapUsd = marketCapUsd;
  const volume24hUsd = numericField(simpleEntry, 'usd_24h_vol');
  if (volume24hUsd !== undefined) evidence.volume24hUsd = volume24hUsd;
  const change24hPct = numericField(simpleEntry, 'usd_24h_change');
  if (change24hPct !== undefined) evidence.change24hPct = change24hPct;
  const lastUpdatedAt = timestampField(simpleEntry, 'last_updated_at');
  if (lastUpdatedAt !== undefined) evidence.lastUpdatedAt = lastUpdatedAt;
  if (onchainPrice !== undefined) evidence.onchainPriceUsd = onchainPrice;
  const name = stringField(attrs, 'name');
  if (name !== undefined) evidence.name = name;
  const symbol = stringField(attrs, 'symbol');
  if (symbol !== undefined) evidence.symbol = symbol;
  const coingeckoId = stringField(attrs, 'coingecko_coin_id') ?? stringField(attrs, 'coingecko_id');
  if (coingeckoId !== undefined) evidence.coingeckoId = coingeckoId;
  const poolCount = numericField(attrs, 'pool_count');
  if (poolCount !== undefined) evidence.poolCount = poolCount;
  return evidence;
}

function findRecordByLowercaseKey(record: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const exact = record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()];
  if (asJsonRecord(exact)) return asJsonRecord(exact);
  const found = Object.entries(record).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
  return found ? asJsonRecord(found[1]) : undefined;
}

function nestedRecord(record: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = record;
  for (const key of path) {
    if (!asJsonRecord(cursor)) return undefined;
    cursor = asJsonRecord(cursor)?.[key];
  }
  return asJsonRecord(cursor);
}

function numericField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function timestampField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = numericField(record, key);
  return value === undefined ? undefined : new Date(value * 1000).toISOString();
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(prefix: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${detail}`;
}
