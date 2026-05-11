import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export const DEFAULT_BIRDEYE_REST_BASE = 'https://public-api.birdeye.so';

export interface BirdeyeConfig {
  apiKey?: string;
  restBase: string;
}

export interface BirdeyeRequestInit {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function birdeyeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BirdeyeConfig {
  return {
    apiKey: env.BIRDEYE_API_KEY?.trim() || undefined,
    restBase: (env.BIRDEYE_REST_BASE?.trim() || DEFAULT_BIRDEYE_REST_BASE).replace(/\/+$/, ''),
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
    'x-chain': 'solana',
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

function asJsonRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}
