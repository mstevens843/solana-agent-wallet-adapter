import { describe, expect, it } from 'vitest';

import { validateAcpCart } from '../cartValidator.js';
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  USDT_MINT_MAINNET,
} from '../constants.js';
import { AcpValidationError } from '../errors.js';
import {
  MERCHANT_RECIPIENT_MAINNET,
  devnetUsdcCart,
  expiredCart,
  mainnetUsdcCart,
  mainnetUsdtCart,
} from './fixtures.js';

function validationError(action: () => unknown, code: string): AcpValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(AcpValidationError);
    const validation = err as AcpValidationError;
    expect(validation.code).toBe(code);
    return validation;
  }
  throw new Error('Expected AcpValidationError.');
}

describe('validateAcpCart', () => {
  it('accepts a valid mainnet USDC cart', () => {
    const result = validateAcpCart(mainnetUsdcCart());
    expect(result.ok).toBe(true);
    expect(result.resolvedTokenMint).toBe(USDC_MINT_MAINNET);
    expect(result.totalFiat).toBe(19.99);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('accepts a valid devnet USDC cart', () => {
    const result = validateAcpCart(devnetUsdcCart());
    expect(result.resolvedTokenMint).toBe(USDC_MINT_DEVNET);
  });

  it('accepts a mainnet USDT cart', () => {
    const result = validateAcpCart(mainnetUsdtCart({ totalAmount: '10.00', lineItems: [{ id: 'li', name: 'thing', quantity: 1, unitAmount: '10.00', currency: 'USD' }] }));
    expect(result.resolvedTokenMint).toBe(USDT_MINT_MAINNET);
  });

  it('rejects USDT on devnet', () => {
    const cart = devnetUsdcCart({ paymentToken: 'USDT' });
    validationError(() => validateAcpCart(cart), 'unsupported_token_for_cluster');
  });

  it('rejects non-base58 recipient', () => {
    const cart = mainnetUsdcCart({
      merchant: { id: 'm', name: 'n', recipient: '!!!not_base58!!!' },
    });
    validationError(() => validateAcpCart(cart), 'invalid_recipient');
  });

  it('rejects an empty cart', () => {
    const cart = mainnetUsdcCart({ lineItems: [], totalAmount: '0.00' });
    validationError(() => validateAcpCart(cart), 'empty_cart');
  });

  it('rejects too many line items', () => {
    const lineItems = Array.from({ length: 60 }, (_, i) => ({
      id: `li_${i}`,
      name: 'item',
      quantity: 1,
      unitAmount: '1.00',
      currency: 'USD' as const,
    }));
    const cart = mainnetUsdcCart({ lineItems, totalAmount: '60.00' });
    validationError(() => validateAcpCart(cart), 'too_many_line_items');
  });

  it('rejects a total that does not match line items', () => {
    const cart = mainnetUsdcCart({ totalAmount: '99.99' });
    validationError(() => validateAcpCart(cart), 'total_mismatch');
  });

  it('rejects totals over the cap', () => {
    const cart = mainnetUsdcCart({
      lineItems: [{ id: 'li', name: 'x', quantity: 1, unitAmount: '20000', currency: 'USD' }],
      totalAmount: '20000',
    });
    validationError(() => validateAcpCart(cart), 'total_exceeds_cap');
  });

  it('respects a caller-provided lower cap', () => {
    const cart = mainnetUsdcCart();
    validationError(() => validateAcpCart(cart, { maxTotalAmount: 5 }), 'total_exceeds_cap');
  });

  it('rejects expired carts', () => {
    validationError(() => validateAcpCart(expiredCart()), 'cart_expired');
  });

  it('rejects mismatched mint vs symbol', () => {
    const cart = mainnetUsdcCart({ paymentTokenMint: USDT_MINT_MAINNET });
    validationError(() => validateAcpCart(cart), 'token_mint_cluster_mismatch');
  });

  it('rejects mint outside cluster allowlist', () => {
    const cart = devnetUsdcCart({ paymentTokenMint: USDC_MINT_MAINNET });
    validationError(() => validateAcpCart(cart), 'invalid_token_mint');
  });

  it('honors an open allowedTokenMints override', () => {
    const customMint = 'CUSTOMmint11111111111111111111111111111111';
    const cart = mainnetUsdcCart({ paymentTokenMint: customMint });
    const result = validateAcpCart(cart, {
      allowedTokenMints: { 'mainnet-beta': [customMint], testnet: [], devnet: [], localnet: [] },
    });
    expect(result.resolvedTokenMint).toBe(customMint);
  });

  it('requires paymentTokenMint when override is given', () => {
    const cart = mainnetUsdcCart();
    validationError(
      () => validateAcpCart(cart, {
        allowedTokenMints: { 'mainnet-beta': ['CUSTOM'], testnet: [], devnet: [], localnet: [] },
      }),
      'invalid_token_mint',
    );
  });

  it('rejects forbidden secret keys hidden in metadata', () => {
    const cart = mainnetUsdcCart({ metadata: { delegatedSigner: 'oops' } });
    validationError(() => validateAcpCart(cart), 'forbidden_secret');
  });

  it('rejects unlimited authority hidden in metadata', () => {
    const cart = mainnetUsdcCart({ metadata: { approvalAuthority: 'unlimited' } });
    validationError(() => validateAcpCart(cart), 'forbidden_authority');
  });

  it('rejects non-positive totalAmount', () => {
    const cart = mainnetUsdcCart({ totalAmount: '0', lineItems: [{ id: 'li', name: 'x', quantity: 1, unitAmount: '0', currency: 'USD' }] });
    validationError(() => validateAcpCart(cart), 'total_non_positive');
  });

  it('rejects malformed totalAmount strings', () => {
    const cart = mainnetUsdcCart({ totalAmount: '1,99' });
    validationError(() => validateAcpCart(cart), 'invalid_amount');
  });

  it('uses MERCHANT_RECIPIENT_MAINNET in the happy-path cart (sanity)', () => {
    const result = validateAcpCart(mainnetUsdcCart());
    expect(result.cart.merchant.recipient).toBe(MERCHANT_RECIPIENT_MAINNET);
  });
});
