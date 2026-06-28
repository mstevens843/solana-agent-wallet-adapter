import { describe, expect, it } from 'vitest';

import { createClientChatToolExecutor, type ClientChatToolDeps } from '../chatAgent/clientTools.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3fR7P3XLT5DzNzjgN8VGNTW1Etx';

function baseDeps(overrides: Partial<ClientChatToolDeps> = {}): ClientChatToolDeps {
  return {
    searchTokens: async () => [],
    priceForMints: async (mints) => mints.map((mint) => ({ mint, usdPrice: null })),
    tokenSafety: async (mint) => ({ mint, found: true }),
    marketRegime: async () => ({ source: 'test' }),
    ...overrides,
  };
}

describe('client chat tool provider fallback', () => {
  it('falls through from Jupiter search to BirdEye search on 404', async () => {
    const calls: string[] = [];
    const execute = createClientChatToolExecutor(baseDeps({
      searchTokensJupiter: async () => {
        calls.push('jupiter');
        throw new Error('Jupiter token search HTTP 404');
      },
      searchTokensBirdeye: async () => {
        calls.push('birdeye');
        return [{ mint: SOL_MINT, symbol: 'SOL', name: 'Solana' }];
      },
    }));

    const result = await execute('search_tokens', { query: 'SOL' }, '');
    const data = result.data as Record<string, unknown>;

    expect(calls).toEqual(['jupiter', 'birdeye']);
    expect(data.source).toBe('birdeye');
    expect(Array.isArray(data.tokens)).toBe(true);
    expect((data.providerAttempts as Array<Record<string, unknown>>).map((attempt) => attempt.status)).toEqual(['missing', 'ok']);
  });

  it('retries 429 price reads once, then uses CoinGecko before BirdEye', async () => {
    const calls: string[] = [];
    const execute = createClientChatToolExecutor(baseDeps({
      canonicalToken: (value) => value.toUpperCase() === 'BONK' ? { mint: BONK_MINT, symbol: 'BONK' } : null,
      priceForMintsJupiter: async () => {
        calls.push('jupiter');
        throw new Error('HTTP 429 rate limited');
      },
      priceForMintsCoinGecko: async (mints) => {
        calls.push('coingecko');
        return mints.map((mint) => ({ mint, usdPrice: 0.000021, priceChange24h: 3.5 }));
      },
      priceForMintsBirdeye: async () => {
        calls.push('birdeye');
        return [];
      },
    }));

    const result = await execute('get_token_price', { query: 'bonk' }, '');
    const data = result.data as Record<string, unknown>;

    expect(calls).toEqual(['jupiter', 'jupiter', 'coingecko']);
    expect(data.source).toBe('coingecko');
    expect(data.resolvedMint).toBe(BONK_MINT);
    expect((data.providerAttempts as Array<Record<string, unknown>>).map((attempt) => attempt.provider)).toEqual(['jupiter', 'jupiter', 'coingecko']);
  });

  it('falls back from BirdEye holders to CoinGecko holders', async () => {
    const calls: string[] = [];
    const execute = createClientChatToolExecutor(baseDeps({
      canonicalToken: (value) => value.toUpperCase() === 'BONK' ? { mint: BONK_MINT, symbol: 'BONK' } : null,
      tokenHoldersBirdeye: async () => {
        calls.push('birdeye');
        return { mint: BONK_MINT, count: 0, holders: [], source: 'birdeye' };
      },
      tokenHoldersCoinGecko: async (mint) => {
        calls.push('coingecko');
        return { mint, count: 1, holders: [{ owner: 'abc', pct: 10 }], source: 'coingecko' };
      },
    }));

    const result = await execute('get_token_holders', { query: 'BONK' }, '');
    const data = result.data as Record<string, unknown>;

    expect(calls).toEqual(['birdeye', 'coingecko']);
    expect(data.source).toBe('coingecko');
    expect(data.count).toBe(1);
  });
});
