import { describe, expect, it } from 'vitest';

import {
  STABLECOIN_USD_MAP,
  augmentValueWithUsd,
  formatTokenWithUsd,
  formatUsd,
  isStablecoinMint,
  stablecoinSnapshot,
  tokenAmountToUsd,
} from '../priceUsd.js';

describe('isStablecoinMint', () => {
  it('matches the four supported stablecoins', () => {
    for (const mint of Object.keys(STABLECOIN_USD_MAP)) {
      expect(isStablecoinMint(mint)).toBe(true);
    }
  });

  it('rejects unknown mints and SOL placeholder', () => {
    expect(isStablecoinMint('SOL')).toBe(false);
    expect(isStablecoinMint('Unknown1111111111111111111111111111111111')).toBe(false);
    expect(isStablecoinMint('')).toBe(false);
  });
});

describe('stablecoinSnapshot', () => {
  it('returns a $1.00 snapshot for USDC', () => {
    const snap = stablecoinSnapshot('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2026-05-15T00:00:00.000Z');
    expect(snap).toEqual({
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      usdPerToken: 1,
      source: 'stablecoin',
      checkedAt: '2026-05-15T00:00:00.000Z',
    });
  });

  it('returns undefined for non-stablecoin mints', () => {
    expect(stablecoinSnapshot('Unknown1111111111111111111111111111111111')).toBeUndefined();
  });
});

describe('tokenAmountToUsd', () => {
  it('converts a raw amount + decimals to USD', () => {
    expect(tokenAmountToUsd('1500000000', 9, 100)).toBeCloseTo(150);
    expect(tokenAmountToUsd('100000000', 6, 1)).toBeCloseTo(100);
    expect(tokenAmountToUsd(1_000_000_000, 9, 50)).toBeCloseTo(50);
    expect(tokenAmountToUsd(BigInt(2_000_000_000), 9, 75)).toBeCloseTo(150);
  });

  it('returns undefined when price or decimals are bad', () => {
    expect(tokenAmountToUsd('1', 6, undefined)).toBeUndefined();
    expect(tokenAmountToUsd('1', 6, Number.NaN)).toBeUndefined();
    expect(tokenAmountToUsd('1', -1, 100)).toBeUndefined();
    expect(tokenAmountToUsd('not-a-number', 6, 1)).toBeUndefined();
  });
});

describe('formatTokenWithUsd', () => {
  it('formats with USD when price is provided', () => {
    expect(formatTokenWithUsd('1500000000', 9, 'SOL', 142.5)).toBe('1.5 SOL ($213.75)');
  });

  it('omits USD when price is undefined', () => {
    expect(formatTokenWithUsd('1500000000', 9, 'SOL', undefined)).toBe('1.5 SOL');
  });

  it('handles stablecoin via $1.00 price', () => {
    expect(formatTokenWithUsd('100000000', 6, 'USDC', 1)).toBe('100 USDC ($100.00)');
  });

  it('formats large numbers with thousands separators', () => {
    expect(formatTokenWithUsd('1000000000000000', 9, 'SOL', 100)).toBe('1,000,000 SOL ($100,000,000.00)');
  });

  it('formats sub-cent values as <$0.01', () => {
    expect(formatTokenWithUsd('1', 9, 'SOL', 100)).toContain('<$0.01');
  });
});

describe('formatUsd', () => {
  it('handles zero and small values', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.001)).toBe('<$0.01');
    expect(formatUsd(-0.001)).toBe('-<$0.01');
  });

  it('formats normal values with two decimals', () => {
    expect(formatUsd(1)).toBe('$1.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('handles invalid input gracefully', () => {
    expect(formatUsd(Number.NaN)).toBe('$?');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('$?');
  });
});

describe('augmentValueWithUsd', () => {
  it('appends USD suffix when present', () => {
    expect(augmentValueWithUsd('1 SOL', 142.5)).toBe('1 SOL ($142.50)');
  });

  it('returns the input unchanged when USD is missing or non-finite', () => {
    expect(augmentValueWithUsd('1 SOL', undefined)).toBe('1 SOL');
    expect(augmentValueWithUsd('1 SOL', Number.NaN)).toBe('1 SOL');
  });
});
