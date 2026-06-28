import { describe, expect, it } from 'vitest';

import { resolveChatFactChain } from '../chatFacts.js';

describe('resolveChatFactChain', () => {
  it('falls through on not-found style errors', async () => {
    const calls: string[] = [];
    const result = await resolveChatFactChain([
      {
        provider: 'birdeye',
        endpoint: 'token_holders',
        run: async () => {
          calls.push('birdeye');
          throw new Error('BirdEye request failed with HTTP 404: {"error":"not_found"}');
        },
      },
      {
        provider: 'coingecko',
        endpoint: 'onchain.token_top_holders',
        run: async () => {
          calls.push('coingecko');
          return { count: 1, source: 'coingecko' };
        },
      },
    ], { retryDelayMs: 0 });

    expect(calls).toEqual(['birdeye', 'coingecko']);
    expect(result.exhausted).toBe(false);
    expect(result.data.source).toBe('coingecko');
    expect(result.attempts.map((a) => a.status)).toEqual(['missing', 'ok']);
  });

  it('retries 429 once then tries the next provider', async () => {
    const calls: string[] = [];
    const result = await resolveChatFactChain([
      {
        provider: 'jupiter',
        endpoint: 'price',
        run: async () => {
          calls.push('jupiter');
          throw new Error('HTTP 429: too many requests');
        },
      },
      {
        provider: 'birdeye',
        endpoint: 'price',
        run: async () => {
          calls.push('birdeye');
          return { usdPrice: 123, source: 'birdeye' };
        },
      },
    ], { retryDelayMs: 0 });

    expect(calls).toEqual(['jupiter', 'jupiter', 'birdeye']);
    expect(result.exhausted).toBe(false);
    expect(result.data.source).toBe('birdeye');
    expect(result.attempts.map((a) => a.status)).toEqual(['error', 'error', 'ok']);
  });

  it('marks exhausted chains as web-search recommended when requested', async () => {
    const result = await resolveChatFactChain([
      {
        provider: 'jupiter',
        run: async () => ({ unavailable: true, reason: 'not_found' }),
      },
    ], { retryDelayMs: 0, webSearchOnExhausted: true });

    expect(result.exhausted).toBe(true);
    expect(result.data).toMatchObject({ unavailable: true, exhausted: true, webSearchRecommended: true });
  });
});
