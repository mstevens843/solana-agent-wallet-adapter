import { describe, expect, it } from 'vitest';

import { USDC_MINT_DEVNET, USDC_MINT_MAINNET, defaultUsdcMint, isUsdcMint } from '../usdc.js';

describe('usdc', () => {
  it('defaultUsdcMint returns mainnet by default', () => {
    expect(defaultUsdcMint()).toBe(USDC_MINT_MAINNET);
    expect(defaultUsdcMint('mainnet-beta')).toBe(USDC_MINT_MAINNET);
  });

  it('defaultUsdcMint returns devnet when asked', () => {
    expect(defaultUsdcMint('devnet')).toBe(USDC_MINT_DEVNET);
  });

  it('isUsdcMint recognizes both clusters', () => {
    expect(isUsdcMint(USDC_MINT_MAINNET)).toBe(true);
    expect(isUsdcMint(USDC_MINT_DEVNET)).toBe(true);
  });

  it('isUsdcMint rejects unrelated mints', () => {
    expect(isUsdcMint('So11111111111111111111111111111111111111112')).toBe(false);
    expect(isUsdcMint('')).toBe(false);
    expect(isUsdcMint('not-a-mint')).toBe(false);
  });
});
