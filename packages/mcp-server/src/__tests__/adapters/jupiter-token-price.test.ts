import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentWalletActionService } from '../../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../../config.js';
import { createMockBackend } from '../../mockBackend.js';
import { redactJupiterSecrets } from '../../adapters/jupiter/index.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Jupiter token and price reads', () => {
  it('searches tokens with the Jupiter API key and normalizes token facts', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-secret-jupiter');
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://tokens.example/v2/search');
      expect(requestUrl.searchParams.get('query')).toBe('JUP');
      return jsonResponse([jupToken()]);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const result = await service().jupiterTokenSearch({ query: 'JUP' });

    expect(result.search).toMatchObject({
      source: 'search',
      query: 'JUP',
      tokens: [expect.objectContaining({
        id: JUP_MINT,
        symbol: 'JUP',
        isVerified: true,
        organicScoreLabel: 'high',
      })],
    });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectorId: 'jupiter', label: 'Jupiter Token API V2', tone: 'good' }),
      expect.objectContaining({ label: 'JUP', value: expect.stringContaining('verified') }),
    ]));
  });

  it('supports tag, category, and recent token reads', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      seen.push(`${requestUrl.pathname}${requestUrl.search}`);
      return jsonResponse([jupToken({ symbol: 'SOL', id: SOL_MINT })]);
    }));
    const svc = service();

    await svc.jupiterTokensByTag({ tag: 'verified', limit: 1 });
    await svc.jupiterTokenCategory({ category: 'toptrending', interval: '1h', limit: 10 });
    await svc.jupiterRecentTokens({ limit: 1 });

    expect(seen).toEqual([
      '/v2/tag?query=verified',
      '/v2/toptrending/1h?limit=10',
      '/v2/recent',
    ]);
  });

  it('enforces token-search and price batch caps', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    const svc = service();
    const tooManyMints = Array.from({ length: 101 }, (_, index) => `MintAddress${index.toString().padStart(3, '0')}111111111111111111`);
    await expect(svc.jupiterTokenSearch({ query: tooManyMints.join(',') })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('at most 100'),
    });

    const tooManyPriceIds = Array.from({ length: 51 }, (_, index) => `PriceMint${index.toString().padStart(3, '0')}1111111111111111111111`);
    await expect(svc.jupiterPriceBatch({ mints: tooManyPriceIds })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('at most 50'),
    });
  });

  it('returns partial missing price evidence instead of dropping missing mints', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://price.example/v3');
      expect(requestUrl.searchParams.get('ids')).toBe(`${SOL_MINT},${USDC_MINT}`);
      return jsonResponse({
        [SOL_MINT]: {
          usdPrice: 150,
          blockId: 348004023,
          decimals: 9,
          priceChange24h: 1.25,
        },
      });
    }));

    const result = await service().jupiterPriceBatch({ mints: [SOL_MINT, USDC_MINT] });

    expect(result.batch).toMatchObject({
      totals: { requested: 2, found: 1, missing: 1 },
      prices: [
        expect.objectContaining({ mint: SOL_MINT, status: 'found', usdPrice: 150 }),
        expect.objectContaining({ mint: USDC_MINT, status: 'missing' }),
      ],
    });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Jupiter Price API V3 batch', tone: 'warn' }),
      expect.objectContaining({ label: 'Price evidence', value: expect.stringContaining('not an oracle guarantee') }),
    ]));
  });

  it('builds token risk evidence for suspicious low-liquidity tokens and missing prices', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/search')) {
        return jsonResponse([jupToken({
          id: JUP_MINT,
          isVerified: false,
          liquidity: 500,
          organicScore: 12,
          organicScoreLabel: 'low',
          audit: {
            isSus: true,
            mintAuthorityDisabled: false,
            freezeAuthorityDisabled: false,
            topHoldersPercentage: 75,
          },
        })]);
      }
      return jsonResponse({});
    }));

    const result = await service().jupiterTokenRiskEvidence({ mint: JUP_MINT });

    expect(result.evidence).toMatchObject({
      connectorId: 'jupiter',
      product: 'tokens_price',
      mint: JUP_MINT,
      tokenFound: true,
      riskLabels: expect.arrayContaining([
        'unverified',
        'suspicious_audit',
        'mint_authority_present',
        'freeze_authority_present',
        'holder_concentration_high',
        'very_low_liquidity',
        'organic_score_low',
        'price_missing',
        'price_evidence_not_oracle',
      ]),
    });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.stringContaining('Jupiter token evidence'), tone: 'fail' }),
      expect.objectContaining({ label: 'Token warnings', value: expect.stringContaining('not an oracle guarantee') }),
    ]));
  });

  it('redacts Jupiter secrets from API error bodies', async () => {
    expect(redactJupiterSecrets({ apiKey: 'sk-test-secret-jupiter' })).toEqual({ apiKey: '[redacted]' });
  });
});

function service(config: AgentWalletConfig = testConfig()): AgentWalletActionService {
  return new AgentWalletActionService({
    backend: createMockBackend(),
    config,
  });
}

function testConfig(): AgentWalletConfig {
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

function jupToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JUP_MINT,
    name: 'Jupiter',
    symbol: 'JUP',
    decimals: 6,
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    holderCount: 100000,
    liquidity: 5000000,
    organicScore: 98,
    organicScoreLabel: 'high',
    isVerified: true,
    tags: ['verified'],
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 3,
    },
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
