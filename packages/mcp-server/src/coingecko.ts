import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export const DEFAULT_COINGECKO_PUBLIC_BASE = 'https://api.coingecko.com/api/v3';
export const DEFAULT_COINGECKO_PRO_BASE = 'https://pro-api.coingecko.com/api/v3';

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
  const response = await requester(url, { method: 'GET', headers });
  const payload = await response.json().catch(() => ({})) as unknown;
  const record = asJsonRecord(payload) ?? {};
  if (!response.ok) {
    throw new ProtocolError(
      'wallet_unreachable',
      `CoinGecko request failed with HTTP ${response.status}: ${JSON.stringify(record)}`,
    );
  }
  return record;
}

export interface CoinGeckoGlobalSnapshot {
  totalMarketCapUsd?: number;
  totalVolume24hUsd?: number;
  marketCapChangePct24hUsd?: number;
  btcDominancePct?: number;
  ethDominancePct?: number;
  updatedAt?: string;
}

export async function requestCoinGeckoGlobal(
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<CoinGeckoGlobalSnapshot> {
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
  return {
    ...(totalMarketCap && typeof totalMarketCap.usd === 'number' ? { totalMarketCapUsd: totalMarketCap.usd as number } : {}),
    ...(totalVolume && typeof totalVolume.usd === 'number' ? { totalVolume24hUsd: totalVolume.usd as number } : {}),
    ...(marketCapChange !== undefined ? { marketCapChangePct24hUsd: marketCapChange } : {}),
    ...(marketCapPct && typeof marketCapPct.btc === 'number' ? { btcDominancePct: marketCapPct.btc as number } : {}),
    ...(marketCapPct && typeof marketCapPct.eth === 'number' ? { ethDominancePct: marketCapPct.eth as number } : {}),
    ...(updatedAtSeconds !== undefined
      ? { updatedAt: new Date(updatedAtSeconds * 1000).toISOString() }
      : {}),
  };
}

function asJsonRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return undefined;
}
