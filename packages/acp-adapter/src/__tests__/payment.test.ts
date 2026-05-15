import { describe, expect, it } from 'vitest';

import { validateAcpCart } from '../cartValidator.js';
import { cartToTransferParams } from '../payment.js';
import { MERCHANT_RECIPIENT_MAINNET, mainnetSolCart, mainnetUsdcCart } from './fixtures.js';

describe('cartToTransferParams', () => {
  it('maps a validated cart to transfer-spl params', () => {
    const validated = validateAcpCart(mainnetUsdcCart());
    const params = cartToTransferParams(validated);
    expect(params).toEqual({
      token: 'USDC',
      recipient: MERCHANT_RECIPIENT_MAINNET,
      amount: '19.99',
      dueAt: '2099-01-01T00:00:00.000Z',
      note: 'Order #123',
    });
    expect(Object.isFrozen(params)).toBe(true);
  });

  it('uses synthesized note when cart has no memo', () => {
    const cart = mainnetUsdcCart({ memo: undefined });
    const params = cartToTransferParams(validateAcpCart(cart));
    expect(params.note).toBe(`ACP cart ${cart.id}: ${cart.merchant.name}`);
  });

  it('maps a SOL cart to native SOL transfer params', () => {
    const validated = validateAcpCart(mainnetSolCart());
    const params = cartToTransferParams(validated);
    expect(params).toMatchObject({
      token: 'SOL',
      recipient: MERCHANT_RECIPIENT_MAINNET,
      amount: '0.10',
    });
  });

  it('honors caller-supplied dueAt and note overrides', () => {
    const validated = validateAcpCart(mainnetUsdcCart());
    const params = cartToTransferParams(validated, {
      dueAt: '2030-06-01T00:00:00.000Z',
      note: 'forced',
    });
    expect(params.dueAt).toBe('2030-06-01T00:00:00.000Z');
    expect(params.note).toBe('forced');
  });

  it('omits dueAt when neither cart nor caller provides one', () => {
    const cart = mainnetUsdcCart({ expiresAt: undefined });
    const params = cartToTransferParams(validateAcpCart(cart));
    expect(params.dueAt).toBeUndefined();
  });
});
