import { describe, expect, it } from 'vitest';

import { AcpParseError } from '../errors.js';
import { parseAcpCart } from '../parser.js';
import {
  MERCHANT_RECIPIENT_MAINNET,
  SAMPLE_CART_JSON,
  mainnetUsdcCart,
  rawAliasedMainnetCart,
} from './fixtures.js';

function parseError(action: () => unknown, code: string): AcpParseError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(AcpParseError);
    const parsed = err as AcpParseError;
    expect(parsed.code).toBe(code);
    return parsed;
  }
  throw new Error('Expected AcpParseError.');
}

describe('parseAcpCart', () => {
  it('parses a structurally valid object', () => {
    const cart = parseAcpCart(mainnetUsdcCart());
    expect(cart.id).toBe('cart_mainnet_001');
    expect(cart.cartVersion).toBe('1');
    expect(cart.cluster).toBe('mainnet-beta');
    expect(cart.merchant.recipient).toBe(MERCHANT_RECIPIENT_MAINNET);
    expect(cart.lineItems).toHaveLength(2);
    expect(Object.isFrozen(cart)).toBe(true);
    expect(Object.isFrozen(cart.lineItems)).toBe(true);
  });

  it('parses an equivalent JSON string', () => {
    const cart = parseAcpCart(SAMPLE_CART_JSON);
    expect(cart.totalAmount).toBe('19.99');
  });

  it("normalizes legacy 'mainnet' cluster alias to 'mainnet-beta'", () => {
    const cart = parseAcpCart(rawAliasedMainnetCart());
    expect(cart.cluster).toBe('mainnet-beta');
  });

  it('rejects unknown cluster names', () => {
    parseError(
      () => parseAcpCart({ ...mainnetUsdcCart(), cluster: 'btc' } as unknown),
      'invalid_enum',
    );
  });

  it('rejects malformed JSON strings', () => {
    parseError(() => parseAcpCart('{not json'), 'invalid_json');
  });

  it('rejects JSON strings larger than maxBytes', () => {
    const big = '"' + 'a'.repeat(100) + '"';
    parseError(() => parseAcpCart(big, { maxBytes: 16 }), 'invalid_size');
  });

  it('rejects unsupported cartVersion', () => {
    parseError(() => parseAcpCart({ ...mainnetUsdcCart(), cartVersion: '2' }), 'unsupported_version');
  });

  it('rejects unsupported currency', () => {
    const cart = { ...mainnetUsdcCart(), currency: 'EUR' };
    parseError(() => parseAcpCart(cart), 'invalid_enum');
  });

  it('rejects unsupported paymentToken', () => {
    const cart = { ...mainnetUsdcCart(), paymentToken: 'BTC' };
    parseError(() => parseAcpCart(cart), 'invalid_enum');
  });

  it('rejects non-array lineItems', () => {
    const cart = { ...mainnetUsdcCart(), lineItems: 'oops' } as unknown;
    parseError(() => parseAcpCart(cart), 'invalid_array');
  });

  it('rejects missing required id', () => {
    const cart = { ...mainnetUsdcCart() } as Record<string, unknown>;
    delete cart.id;
    parseError(() => parseAcpCart(cart), 'missing_field');
  });

  it('rejects non-integer line item quantity', () => {
    const cart = mainnetUsdcCart({
      lineItems: [{ id: 'li', name: 'frac', quantity: 1.5, unitAmount: '1.00', currency: 'USD' }],
    });
    parseError(() => parseAcpCart(cart), 'invalid_number');
  });

  it('accepts optional fields when provided', () => {
    const cart = parseAcpCart(mainnetUsdcCart({ memo: 'hello', metadata: { ref: 'abc' } }));
    expect(cart.memo).toBe('hello');
    expect(cart.metadata).toEqual({ ref: 'abc' });
  });
});
