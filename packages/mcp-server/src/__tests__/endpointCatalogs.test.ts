import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COINGECKO_ENDPOINT_CATALOG,
  requestCoinGeckoEndpoint,
  requestCoinGeckoSolanaTokenEvidence,
} from '../coingecko.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import {
  JUPITER_ENDPOINT_CATALOG,
  requestJupiterReviewEndpoint,
} from '../adapters/jupiter/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('review endpoint catalogs', () => {
  it('keeps CoinGecko catalog entries unique and read-only', () => {
    const ids = COINGECKO_ENDPOINT_CATALOG.map((entry) => entry.endpointId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(COINGECKO_ENDPOINT_CATALOG.length).toBeGreaterThan(30);
    expect(COINGECKO_ENDPOINT_CATALOG.every((entry) => entry.method === 'GET')).toBe(true);
    expect(COINGECKO_ENDPOINT_CATALOG.every((entry) => entry.risk === 'review_evidence')).toBe(true);
  });

  it('keeps Jupiter transaction endpoints out of generic review reads', () => {
    const ids = JUPITER_ENDPOINT_CATALOG.map((entry) => entry.endpointId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(JUPITER_ENDPOINT_CATALOG.find((entry) => entry.endpointId === 'tokens.search')).toMatchObject({
      risk: 'review_evidence',
      method: 'GET',
    });
    for (const endpointId of [
      'swap.build',
      'swap.execute',
      'transaction.submit',
      'trigger.create_order',
      'recurring.create_order',
      'send.craft_send',
      'studio.dbc_pool_create_tx',
    ]) {
      expect(JUPITER_ENDPOINT_CATALOG.find((entry) => entry.endpointId === endpointId)).toEqual(
        expect.objectContaining({ risk: expect.not.stringMatching(/^review_evidence$/) }),
      );
    }
  });

  it('blocks approval-only Jupiter endpoints from review reads', async () => {
    await expect(requestJupiterReviewEndpoint(jupiterConfig(), { endpointId: 'swap.execute' })).rejects.toMatchObject({
      code: 'unsupported_method',
      message: expect.stringContaining('approval_only'),
    });
  });

  it('calls cataloged Jupiter review endpoints with the configured API key', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://tokens.example/v2/search');
      expect(requestUrl.searchParams.get('query')).toBe('JUP');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-jupiter');
      return jsonResponse([{ id: JUP_MINT, symbol: 'JUP' }]);
    }));

    const result = await requestJupiterReviewEndpoint(jupiterConfig(), {
      endpointId: 'tokens.search',
      query: { query: 'JUP' },
    });

    expect(result).toMatchObject({
      provider: 'jupiter',
      endpointId: 'tokens.search',
      product: 'tokens',
      data: { data: [expect.objectContaining({ symbol: 'JUP' })] },
    });
  });

  it('validates CoinGecko endpoint query parameters', async () => {
    await expect(requestCoinGeckoEndpoint({
      endpointId: 'global.crypto',
      query: { ids: 'solana' },
    })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('does not accept query params'),
    });
  });

  it('normalizes CoinGecko Solana token evidence', async () => {
    const seen = new Set<string>();
    const result = await requestCoinGeckoSolanaTokenEvidence({
      mints: [SOL_MINT],
      includeOnchain: true,
      maxTokenDetails: 1,
    }, {
      fetchImpl: async (url: string | URL | Request) => {
        const requestUrl = new URL(String(url));
        seen.add(requestUrl.pathname);
        if (requestUrl.pathname.endsWith('/simple/token_price/solana')) {
          expect(requestUrl.searchParams.get('contract_addresses')).toBe(SOL_MINT);
          return jsonResponse({
            [SOL_MINT]: {
              usd: 150,
              usd_market_cap: 75000000000,
              usd_24h_vol: 2500000000,
              usd_24h_change: 1.5,
              last_updated_at: 1778760000,
            },
          });
        }
        if (requestUrl.pathname.includes('/onchain/simple/networks/solana/token_price/')) {
          return jsonResponse({
            data: {
              attributes: {
                token_prices: {
                  [SOL_MINT]: '150.25',
                },
              },
            },
          });
        }
        if (requestUrl.pathname.endsWith(`/onchain/networks/solana/tokens/${SOL_MINT}/info`)) {
          return jsonResponse({
            data: {
              attributes: {
                name: 'Wrapped SOL',
                symbol: 'SOL',
                coingecko_coin_id: 'solana',
                pool_count: 123,
              },
            },
          });
        }
        return jsonResponse({});
      },
    });

    expect(seen.size).toBe(3);
    expect(result).toMatchObject({
      provider: 'coingecko',
      product: 'solana_token_evidence',
      tokens: [expect.objectContaining({
        mint: SOL_MINT,
        priceUsd: 150,
        marketCapUsd: 75000000000,
        volume24hUsd: 2500000000,
        change24hPct: 1.5,
        onchainPriceUsd: 150.25,
        name: 'Wrapped SOL',
        symbol: 'SOL',
        coingeckoId: 'solana',
        poolCount: 123,
      })],
    });
  });
});

function jupiterConfig(): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    jupiter: {
      ...DEFAULT_CONFIG.jupiter,
      tokensBaseUrl: 'https://tokens.example/v2',
      priceBaseUrl: 'https://price.example/v3',
      apiKeyEnv: 'JUPITER_API_KEY',
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
