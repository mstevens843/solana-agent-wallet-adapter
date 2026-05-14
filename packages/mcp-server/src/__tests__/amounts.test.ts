import { describe, expect, it } from 'vitest';

import { parseDecimalAmount } from '../amounts.js';

describe('parseDecimalAmount', () => {
  it('accepts leading-dot positive decimals', () => {
    expect(parseDecimalAmount('.01', 9, 'Amount')).toBe(10000000n);
    expect(parseDecimalAmount(' .01 ', 6, 'Amount')).toBe(10000n);
    expect(parseDecimalAmount('.000001', 6, 'Amount')).toBe(1n);
  });

  it('keeps rejecting malformed or non-positive shorthand values', () => {
    expect(() => parseDecimalAmount('.', 9, 'Amount')).toThrow(/positive decimal string/);
    expect(() => parseDecimalAmount('1.', 9, 'Amount')).toThrow(/positive decimal string/);
    expect(() => parseDecimalAmount('-.01', 9, 'Amount')).toThrow(/positive decimal string/);
    expect(() => parseDecimalAmount('.0', 9, 'Amount')).toThrow(/greater than zero/);
  });

  it('rejects leading-dot values with too much precision', () => {
    expect(() => parseDecimalAmount('.0000000001', 9, 'Amount')).toThrow(/too many decimal places/);
  });
});
