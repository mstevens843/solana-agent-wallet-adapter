import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, normalizeConfig } from '../config.js';

const ENV_KEYS = [
  'SOLANA_RPC_URL',
  'HELIUS_RPC_URL',
  'JUPITER_API_KEY',
  'JUP_API_KEY',
  'JUPITER_SWAP_BASE_URL',
  'JUPITER_TOKENS_BASE_URL',
  'JUPITER_PRICE_BASE_URL',
  'JUP_ULTRA_BASE',
  'JUPITER_BASE_URL',
  'SKR_TOKEN_MINT',
  'SKR_TOKEN_DECIMALS',
  'SKR_TOKEN_MAX_TRANSFER',
] as const;

const previousEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  previousEnv.clear();
});

describe('config env aliases', () => {
  it('defaults to devnet with mainnet and arbitrary mainnet signing disabled', () => {
    expect(DEFAULT_CONFIG.cluster).toBe('devnet');
    expect(DEFAULT_CONFIG.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(DEFAULT_CONFIG.mainnet.enabled).toBe(false);
    expect(DEFAULT_CONFIG.mainnet.allowArbitraryTransactions).toBe(false);
  });

  it('uses local setup env aliases for RPC and Jupiter', () => {
    setEnv('SOLANA_RPC_URL', 'https://solana.example');
    setEnv('HELIUS_RPC_URL', 'https://helius.example');
    setEnv('JUP_API_KEY', 'jup-short-key');
    setEnv('JUP_ULTRA_BASE', 'https://api.jup.ag/ultra/v1');

    const config = normalizeConfig({});

    expect(config.rpcUrl).toBe('https://solana.example');
    expect(config.jupiter.apiKeyEnv).toBe('JUP_API_KEY');
    expect(config.jupiter.baseUrl).toBe('https://api.jup.ag/ultra/v1');
    expect(config.jupiter.swapBaseUrl).toBe('https://api.jup.ag/ultra/v1');
  });

  it('defaults Jupiter execution to Swap API v2', () => {
    const config = normalizeConfig({});

    expect(config.jupiter.baseUrl).toBe('https://api.jup.ag/swap/v2');
    expect(config.jupiter.swapBaseUrl).toBe('https://api.jup.ag/swap/v2');
    expect(config.jupiter.apiKeyEnv).toBe('JUPITER_API_KEY');
  });

  it('prefers the Swap API v2 base URL env over legacy aliases', () => {
    setEnv('JUPITER_SWAP_BASE_URL', 'https://swap.example/v2/');
    setEnv('JUP_ULTRA_BASE', 'https://legacy.example/ultra/v1');

    const config = normalizeConfig({});

    expect(config.jupiter.baseUrl).toBe('https://swap.example/v2');
    expect(config.jupiter.swapBaseUrl).toBe('https://swap.example/v2');
  });

  it('keeps JUPITER_BASE_URL as the lowest-priority legacy swap override', () => {
    setEnv('JUPITER_BASE_URL', 'https://legacy-base.example/swap/v2/');

    const config = normalizeConfig({});

    expect(config.jupiter.baseUrl).toBe('https://legacy-base.example/swap/v2');
    expect(config.jupiter.swapBaseUrl).toBe('https://legacy-base.example/swap/v2');
  });

  it('configures Jupiter Token and Price API defaults and env overrides', () => {
    setEnv('JUPITER_TOKENS_BASE_URL', 'https://tokens.example/v2/');
    setEnv('JUPITER_PRICE_BASE_URL', 'https://price.example/v3/');

    const config = normalizeConfig({
      connectors: {
        jupiter: {
          tokenPrice: {
            maxBatchPriceIds: 25,
            maxSearchMintIds: 40,
          },
        },
      },
    });

    expect(config.jupiter.tokensBaseUrl).toBe('https://tokens.example/v2');
    expect(config.jupiter.priceBaseUrl).toBe('https://price.example/v3');
    expect(config.connectors?.jupiter?.tokenPrice).toMatchObject({
      enabled: true,
      maxBatchPriceIds: 25,
      maxSearchMintIds: 40,
    });
  });
});

function setEnv(key: typeof ENV_KEYS[number], value: string): void {
  process.env[key] = value;
}

// ─── $SKR (Solana Mobile Seeker) registry — env-gated, validated at module load ─
//
// `SKR_MINT` and the conditional `DEFAULT_TOKEN_REGISTRY` SKR entry are
// computed once when `config.ts` is first imported (top-of-file `process.env`
// reads). To exercise multiple env permutations in the same test file we
// `vi.resetModules()` between cases and re-import the module under each env
// shape. That sidesteps stale module-scope state without forking the test
// runner.
describe('SKR_MINT registry (env-gated)', () => {
  // Real Solana base58 pubkey (USDC mainnet mint). Stand-in for any real
  // $SKR mint — we're validating base58 round-trip, not token identity.
  const VALID_BASE58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  async function reloadConfig(): Promise<typeof import('../config.js')> {
    vi.resetModules();
    return await import('../config.js');
  }

  it('omits SKR from DEFAULT_TOKEN_REGISTRY when SKR_TOKEN_MINT is unset', async () => {
    delete process.env.SKR_TOKEN_MINT;
    const config = await reloadConfig();
    expect(config.SKR_MINT).toBe('');
    expect(config.DEFAULT_TOKEN_REGISTRY.some((t) => t.symbol === 'SKR')).toBe(false);
  });

  it('includes SKR when SKR_TOKEN_MINT is a valid base58 pubkey', async () => {
    process.env.SKR_TOKEN_MINT = VALID_BASE58;
    const config = await reloadConfig();
    expect(config.SKR_MINT).toBe(VALID_BASE58);
    const skrEntry = config.DEFAULT_TOKEN_REGISTRY.find((t) => t.symbol === 'SKR');
    expect(skrEntry).toBeDefined();
    expect(skrEntry?.mint).toBe(VALID_BASE58);
    // Defaults: 6 decimals (matching USDC scale) and a conservative max
    // transfer cap until operator overrides via SKR_TOKEN_DECIMALS /
    // SKR_TOKEN_MAX_TRANSFER.
    expect(skrEntry?.decimals).toBe(6);
    expect(skrEntry?.maxTransfer).toBe('1000');
  });

  it('honors SKR_TOKEN_DECIMALS and SKR_TOKEN_MAX_TRANSFER overrides', async () => {
    process.env.SKR_TOKEN_MINT = VALID_BASE58;
    process.env.SKR_TOKEN_DECIMALS = '9';
    process.env.SKR_TOKEN_MAX_TRANSFER = '500';
    const config = await reloadConfig();
    const skrEntry = config.DEFAULT_TOKEN_REGISTRY.find((t) => t.symbol === 'SKR');
    expect(skrEntry?.decimals).toBe(9);
    expect(skrEntry?.maxTransfer).toBe('500');
  });

  it('falls back to defaults for malformed SKR_TOKEN_DECIMALS', async () => {
    process.env.SKR_TOKEN_MINT = VALID_BASE58;
    process.env.SKR_TOKEN_DECIMALS = 'abc';
    process.env.SKR_TOKEN_MAX_TRANSFER = 'not-a-number';
    const config = await reloadConfig();
    const skrEntry = config.DEFAULT_TOKEN_REGISTRY.find((t) => t.symbol === 'SKR');
    expect(skrEntry?.decimals).toBe(6);
    expect(skrEntry?.maxTransfer).toBe('1000');
  });

  it('omits SKR with a warning when SKR_TOKEN_MINT is not valid base58', async () => {
    process.env.SKR_TOKEN_MINT = 'definitely-not-base58!!!';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const config = await reloadConfig();
      expect(config.SKR_MINT).toBe('');
      expect(config.DEFAULT_TOKEN_REGISTRY.some((t) => t.symbol === 'SKR')).toBe(false);
      // Operators should see exactly one warn so the misconfiguration is
      // diagnosable from logs — the silent path (return empty without
      // logging) would mask the typo.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('SKR_TOKEN_MINT');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not affect the rest of DEFAULT_TOKEN_REGISTRY when SKR is enabled', async () => {
    delete process.env.SKR_TOKEN_MINT;
    const baseline = await reloadConfig();
    const baselineSymbols = baseline.DEFAULT_TOKEN_REGISTRY.map((t) => t.symbol);

    process.env.SKR_TOKEN_MINT = VALID_BASE58;
    const enabled = await reloadConfig();
    const enabledSymbols = enabled.DEFAULT_TOKEN_REGISTRY.map((t) => t.symbol);

    // The SKR-enabled registry is exactly the baseline + 'SKR'; no other
    // entries are reordered or dropped (which would break callers iterating
    // by index, though there shouldn't be any).
    expect(enabledSymbols).toEqual([...baselineSymbols, 'SKR']);
  });
});
