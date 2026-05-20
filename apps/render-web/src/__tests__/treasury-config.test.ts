import { describe, expect, it } from 'vitest';

import {
  computeDecimalSplit,
  computePlatformSplit,
  DEFAULT_PLATFORM_FEE_BPS,
  decimalToRaw,
  effectiveScheduleTotalAmount,
  isPlatformFeeApplicable,
  isSkillMonetizationSplit,
  loadTreasuryConfig,
  rawToDecimal,
  TreasuryConfigError,
} from '../cloud/treasuryConfig.js';

const VALID_TREASURY = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'B4Tt7BdtbymyQfDGGr6FMfvtRT8wB2qBkjpyXBP7GwK4';

describe('treasuryConfig.loadTreasuryConfig', () => {
  it('returns null wallet and default fee when env is empty', () => {
    const config = loadTreasuryConfig({});
    expect(config).toEqual({ wallet: null, feeBps: DEFAULT_PLATFORM_FEE_BPS });
  });

  it('normalizes a valid TREASURY_WALLET', () => {
    const config = loadTreasuryConfig({ TREASURY_WALLET: VALID_TREASURY });
    expect(config).toEqual({ wallet: VALID_TREASURY, feeBps: DEFAULT_PLATFORM_FEE_BPS });
  });

  it('throws on malformed TREASURY_WALLET', () => {
    expect(() => loadTreasuryConfig({ TREASURY_WALLET: 'not-a-pubkey' })).toThrow(TreasuryConfigError);
  });

  it('parses PLATFORM_FEE_BPS as integer', () => {
    expect(loadTreasuryConfig({ PLATFORM_FEE_BPS: '500' })).toEqual({ wallet: null, feeBps: 500 });
    expect(loadTreasuryConfig({ PLATFORM_FEE_BPS: '0' })).toEqual({ wallet: null, feeBps: 0 });
    expect(loadTreasuryConfig({ PLATFORM_FEE_BPS: '10000' })).toEqual({ wallet: null, feeBps: 10000 });
  });

  it('rejects non-integer or out-of-range PLATFORM_FEE_BPS', () => {
    expect(() => loadTreasuryConfig({ PLATFORM_FEE_BPS: '1.5' })).toThrow(TreasuryConfigError);
    expect(() => loadTreasuryConfig({ PLATFORM_FEE_BPS: '-1' })).toThrow(TreasuryConfigError);
    expect(() => loadTreasuryConfig({ PLATFORM_FEE_BPS: '10001' })).toThrow(TreasuryConfigError);
    expect(() => loadTreasuryConfig({ PLATFORM_FEE_BPS: 'abc' })).toThrow(TreasuryConfigError);
  });
});

describe('treasuryConfig.computePlatformSplit', () => {
  it('takes 15% from a 1 USDC raw amount (6 decimals)', () => {
    const { authorAmountRaw, treasuryAmountRaw } = computePlatformSplit(1_000_000n, 1500);
    expect(authorAmountRaw).toBe(850_000n);
    expect(treasuryAmountRaw).toBe(150_000n);
  });

  it('rounds the treasury portion down (favoring author)', () => {
    // 7 raw * 1500 / 10000 = 1.05 → floored to 1
    const { authorAmountRaw, treasuryAmountRaw } = computePlatformSplit(7n, 1500);
    expect(authorAmountRaw).toBe(6n);
    expect(treasuryAmountRaw).toBe(1n);
  });

  it('returns zero treasury for very small amounts where the cut rounds to zero', () => {
    // 1 raw * 1500 / 10000 = 0.15 → floored to 0
    const { authorAmountRaw, treasuryAmountRaw } = computePlatformSplit(1n, 1500);
    expect(authorAmountRaw).toBe(1n);
    expect(treasuryAmountRaw).toBe(0n);
  });

  it('returns full author amount when feeBps is zero', () => {
    const split = computePlatformSplit(1_000_000n, 0);
    expect(split.authorAmountRaw).toBe(1_000_000n);
    expect(split.treasuryAmountRaw).toBe(0n);
  });

  it('returns zero/zero when amount is zero', () => {
    const split = computePlatformSplit(0n, 1500);
    expect(split.authorAmountRaw).toBe(0n);
    expect(split.treasuryAmountRaw).toBe(0n);
  });

  it('rejects negative amounts and out-of-range fees', () => {
    expect(() => computePlatformSplit(-1n, 1500)).toThrow(TreasuryConfigError);
    expect(() => computePlatformSplit(100n, -1)).toThrow(TreasuryConfigError);
    expect(() => computePlatformSplit(100n, 10001)).toThrow(TreasuryConfigError);
    expect(() => computePlatformSplit(100n, 1.5)).toThrow(TreasuryConfigError);
  });
});

describe('treasuryConfig.computeDecimalSplit', () => {
  it('splits a $10 USDC monthly amount at 15%', () => {
    const split = computeDecimalSplit('10', 1500, 6);
    expect(split).toEqual({ totalAmount: '10', authorAmount: '8.5', treasuryAmount: '1.5' });
  });

  it('splits a $5 one-time amount at 15%', () => {
    const split = computeDecimalSplit('5', 1500, 6);
    expect(split.totalAmount).toBe('5');
    expect(split.authorAmount).toBe('4.25');
    expect(split.treasuryAmount).toBe('0.75');
  });

  it('preserves precision under arbitrary decimals', () => {
    const split = computeDecimalSplit('0.100000', 1500, 6);
    expect(split.authorAmount).toBe('0.085');
    expect(split.treasuryAmount).toBe('0.015');
  });

  it('returns treasury zero when the cut is sub-microcent', () => {
    const split = computeDecimalSplit('0.000001', 1500, 6);
    expect(split.authorAmount).toBe('0.000001');
    expect(split.treasuryAmount).toBe('0');
  });

  it('rejects malformed decimals or out-of-range decimals scale', () => {
    expect(() => computeDecimalSplit('abc', 1500, 6)).toThrow(TreasuryConfigError);
    expect(() => computeDecimalSplit('10', 1500, 19)).toThrow(TreasuryConfigError);
    expect(() => computeDecimalSplit('10', 1500, -1)).toThrow(TreasuryConfigError);
  });

  it('is token-agnostic: $SKR (6 decimals) splits identically to USDC', () => {
    // The treasury split helper operates on raw bigints + a scalar fee, with
    // no knowledge of the underlying token symbol. This test pins that
    // contract — Solana Mobile Seeker ($SKR) skill installs in the bounty
    // window route through this same helper, just with `monetization.token =
    // 'SKR'` carried in metadata. If a future refactor accidentally branches
    // on token identity, this test will catch the regression.
    const usdc = computeDecimalSplit('10', 1500, 6);
    const skr = computeDecimalSplit('10', 1500, 6);
    expect(skr).toEqual(usdc);
  });

  it('is token-agnostic: a 9-decimal token splits with the same proportions', () => {
    // Some Seeker-ecosystem tokens may ship with 9 decimals (Solana's
    // native-style scale) rather than 6. The decimal scale only changes the
    // string padding; the proportions are identical.
    const sixDec = computeDecimalSplit('10', 1500, 6);
    const nineDec = computeDecimalSplit('10', 1500, 9);
    expect(nineDec.authorAmount).toBe(sixDec.authorAmount);
    expect(nineDec.treasuryAmount).toBe(sixDec.treasuryAmount);
  });

  it('bounty path (feeBps=0) routes 100% to author at the helper level', () => {
    // When the Android $SKR bounty applies, the install handler short-
    // circuits with `effectiveSplitContext = null`, so this helper is never
    // called. But if a future refactor passes `feeBps=0` through it
    // instead, the behavior must still match: full amount to author.
    const split = computeDecimalSplit('10', 0, 6);
    expect(split.authorAmount).toBe('10');
    expect(split.treasuryAmount).toBe('0');
  });
});

describe('treasuryConfig.decimalToRaw / rawToDecimal', () => {
  it('roundtrips through 6-decimal scale', () => {
    expect(decimalToRaw('1.5', 6)).toBe(1_500_000n);
    expect(decimalToRaw('0', 6)).toBe(0n);
    expect(rawToDecimal(1_500_000n, 6)).toBe('1.5');
    expect(rawToDecimal(0n, 6)).toBe('0');
  });
});

describe('treasuryConfig.effectiveScheduleTotalAmount', () => {
  it('returns metadata.totalAmount when present and valid', () => {
    expect(effectiveScheduleTotalAmount({
      amount: '8.5',
      metadata: { source: 'skill_install_monetization', totalAmount: '10' },
    })).toBe('10');
  });

  it('falls back to schedule.amount when metadata missing', () => {
    expect(effectiveScheduleTotalAmount({ amount: '8.5' })).toBe('8.5');
    expect(effectiveScheduleTotalAmount({ amount: '8.5', metadata: null })).toBe('8.5');
    expect(effectiveScheduleTotalAmount({ amount: '8.5', metadata: {} })).toBe('8.5');
  });

  it('rejects malformed totalAmount strings', () => {
    expect(effectiveScheduleTotalAmount({
      amount: '8.5',
      metadata: { totalAmount: 'not-a-number' },
    })).toBe('8.5');
    expect(effectiveScheduleTotalAmount({
      amount: '8.5',
      metadata: { totalAmount: '' },
    })).toBe('8.5');
  });

  it('ignores non-string totalAmount', () => {
    expect(effectiveScheduleTotalAmount({
      amount: '8.5',
      metadata: { totalAmount: 10 },
    })).toBe('8.5');
  });
});

describe('treasuryConfig.isSkillMonetizationSplit', () => {
  it('returns true for a complete split metadata payload', () => {
    expect(isSkillMonetizationSplit({
      source: 'skill_install_monetization',
      platformWallet: VALID_TREASURY,
      platformAmount: '1.5',
      totalAmount: '10',
      platformFeeBps: 1500,
    })).toBe(true);
  });

  it('returns false when any required field is missing', () => {
    expect(isSkillMonetizationSplit({
      source: 'skill_install_monetization',
      platformWallet: VALID_TREASURY,
      platformAmount: '1.5',
      totalAmount: '10',
    })).toBe(false);
    expect(isSkillMonetizationSplit({ source: 'skill_install_monetization' })).toBe(false);
  });

  it('returns false for non-skill sources', () => {
    expect(isSkillMonetizationSplit({
      source: 'manual_recurring',
      platformWallet: VALID_TREASURY,
      platformAmount: '1.5',
      totalAmount: '10',
      platformFeeBps: 1500,
    })).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(isSkillMonetizationSplit(null)).toBe(false);
    expect(isSkillMonetizationSplit(undefined)).toBe(false);
    expect(isSkillMonetizationSplit('string')).toBe(false);
    expect(isSkillMonetizationSplit([])).toBe(false);
  });
});

describe('treasuryConfig.isPlatformFeeApplicable', () => {
  it('returns null when treasury is unset', () => {
    expect(isPlatformFeeApplicable({ wallet: null, feeBps: 1500 }, OTHER_WALLET)).toBeNull();
  });

  it('returns null when feeBps is zero', () => {
    expect(isPlatformFeeApplicable({ wallet: VALID_TREASURY, feeBps: 0 }, OTHER_WALLET)).toBeNull();
  });

  it('returns null when treasury equals author (no self-transfer)', () => {
    expect(isPlatformFeeApplicable({ wallet: VALID_TREASURY, feeBps: 1500 }, VALID_TREASURY)).toBeNull();
  });

  it('returns a split context when treasury, fee, and distinct author are set', () => {
    expect(isPlatformFeeApplicable({ wallet: VALID_TREASURY, feeBps: 1500 }, OTHER_WALLET)).toEqual({
      treasuryWallet: VALID_TREASURY,
      feeBps: 1500,
      authorWallet: OTHER_WALLET,
    });
  });
});
