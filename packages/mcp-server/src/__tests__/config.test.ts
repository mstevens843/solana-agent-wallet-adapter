import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeConfig } from '../config.js';

const ENV_KEYS = [
  'SOLANA_RPC_URL',
  'HELIUS_RPC_URL',
  'JUPITER_API_KEY',
  'JUP_API_KEY',
  'JUPITER_SWAP_BASE_URL',
  'JUP_ULTRA_BASE',
  'JUPITER_BASE_URL',
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
});

function setEnv(key: typeof ENV_KEYS[number], value: string): void {
  process.env[key] = value;
}
