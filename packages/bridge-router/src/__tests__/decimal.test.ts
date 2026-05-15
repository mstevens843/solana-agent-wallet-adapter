import { describe, expect, it } from 'vitest';

import {
  addDecimalStrings,
  applySlippageBps,
  compareUnsignedBigStrings,
  decimalStringIsPositive,
  decimalUsdToRaw,
  rawToDecimal,
} from '../decimal.js';

describe('decimalStringIsPositive', () => {
  it('accepts strings strictly greater than zero', () => {
    expect(decimalStringIsPositive('1')).toBe(true);
    expect(decimalStringIsPositive('0.01')).toBe(true);
    expect(decimalStringIsPositive('100.5')).toBe(true);
  });

  it('rejects zero, negatives, and garbage', () => {
    expect(decimalStringIsPositive('0')).toBe(false);
    expect(decimalStringIsPositive('0.0')).toBe(false);
    expect(decimalStringIsPositive('0.00')).toBe(false);
    expect(decimalStringIsPositive('-1')).toBe(false);
    expect(decimalStringIsPositive('abc')).toBe(false);
    expect(decimalStringIsPositive('')).toBe(false);
  });
});

describe('decimalUsdToRaw', () => {
  it('converts whole dollar amounts at 6 decimals', () => {
    expect(decimalUsdToRaw('50', 6)).toBe('50000000');
    expect(decimalUsdToRaw('1', 6)).toBe('1000000');
  });

  it('handles fractional amounts and pads correctly', () => {
    expect(decimalUsdToRaw('50.5', 6)).toBe('50500000');
    expect(decimalUsdToRaw('0.01', 6)).toBe('10000');
    expect(decimalUsdToRaw('0.000001', 6)).toBe('1');
  });

  it('truncates excessive fractional digits without using floats', () => {
    expect(decimalUsdToRaw('1.123456789', 6)).toBe('1123456');
  });

  it('handles very large values without precision loss', () => {
    expect(decimalUsdToRaw('999999999999.123456', 6)).toBe('999999999999123456');
  });

  it('throws for malformed input', () => {
    expect(() => decimalUsdToRaw('abc', 6)).toThrow();
    expect(() => decimalUsdToRaw('1', -1)).toThrow();
    expect(() => decimalUsdToRaw('1', 19)).toThrow();
  });

  it('decimalUsdToRaw of 0 returns "0"', () => {
    expect(decimalUsdToRaw('0', 6)).toBe('0');
    expect(decimalUsdToRaw('0.0', 6)).toBe('0');
  });
});

describe('rawToDecimal', () => {
  it('round-trips with decimalUsdToRaw at 6 decimals', () => {
    for (const usd of ['50', '50.5', '0.01', '1.234567']) {
      const trimmed = usd.replace(/\.?0+$/, '').replace(/^$/, '0');
      const round = rawToDecimal(decimalUsdToRaw(trimmed, 6), 6);
      expect(round).toBe(trimmed === '' ? '0' : trimmed);
    }
  });

  it('handles zero and small values', () => {
    expect(rawToDecimal('0', 6)).toBe('0');
    expect(rawToDecimal('1', 6)).toBe('0.000001');
    expect(rawToDecimal('1000000', 6)).toBe('1');
  });

  it('rejects malformed input', () => {
    expect(() => rawToDecimal('abc', 6)).toThrow();
    expect(() => rawToDecimal('-1', 6)).toThrow();
  });
});

describe('compareUnsignedBigStrings', () => {
  it('compares by magnitude across digit widths', () => {
    expect(compareUnsignedBigStrings('5', '12')).toBeLessThan(0);
    expect(compareUnsignedBigStrings('12', '5')).toBeGreaterThan(0);
    expect(compareUnsignedBigStrings('100', '100')).toBe(0);
  });

  it('compares lexicographically when widths match', () => {
    expect(compareUnsignedBigStrings('123', '124')).toBeLessThan(0);
    expect(compareUnsignedBigStrings('999', '100')).toBeGreaterThan(0);
  });

  it('handles very large numbers beyond JS Number precision', () => {
    const a = '99999999999999999999999999999999';
    const b = '99999999999999999999999999999998';
    expect(compareUnsignedBigStrings(a, b)).toBeGreaterThan(0);
  });

  it('rejects non-integer input', () => {
    expect(() => compareUnsignedBigStrings('1.5', '2')).toThrow();
    expect(() => compareUnsignedBigStrings('-1', '2')).toThrow();
  });
});

describe('addDecimalStrings', () => {
  it('adds integer pairs', () => {
    expect(addDecimalStrings('100', '50')).toBe('150');
    expect(addDecimalStrings('0', '0')).toBe('0');
  });

  it('adds fractional pairs without float drift', () => {
    expect(addDecimalStrings('0.1', '0.2')).toBe('0.3');
    expect(addDecimalStrings('50.5', '0.5')).toBe('51');
  });

  it('handles mismatched fractional widths', () => {
    expect(addDecimalStrings('50.5', '0.05')).toBe('50.55');
    expect(addDecimalStrings('1.999', '0.001')).toBe('2');
  });
});

describe('applySlippageBps', () => {
  it('inflates by bps', () => {
    expect(applySlippageBps('10000', 100, 'inflate')).toBe('10100');
    expect(applySlippageBps('1000000', 50, 'inflate')).toBe('1005000');
  });

  it('reduces by bps', () => {
    expect(applySlippageBps('10000', 100, 'reduce')).toBe('9900');
    expect(applySlippageBps('1000000', 50, 'reduce')).toBe('995000');
  });

  it('passes through unchanged at zero slippage', () => {
    expect(applySlippageBps('12345', 0, 'inflate')).toBe('12345');
    expect(applySlippageBps('12345', 0, 'reduce')).toBe('12345');
  });

  it('rejects invalid slippage', () => {
    expect(() => applySlippageBps('100', -1, 'inflate')).toThrow();
    expect(() => applySlippageBps('100', 10_001, 'inflate')).toThrow();
    expect(() => applySlippageBps('-1', 50, 'inflate')).toThrow();
  });
});
