import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from '../index.js';
import {
  validateAcpReceiptIssuanceRequest,
  validateCreateAcpCartRequest,
} from '../dev/acp.js';

function workflowError(action: () => unknown): WorkflowValidationError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowValidationError);
    return err as WorkflowValidationError;
  }
  throw new Error('Expected WorkflowValidationError.');
}

const baseCart = (): Record<string, unknown> => ({
  id: 'cart_1',
  cartVersion: '1',
  merchant: { id: 'm', name: 'n', recipient: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd' },
  lineItems: [{ id: 'li', name: 'item', quantity: 1, unitAmount: '1.00', currency: 'USD' }],
  totalAmount: '1.00',
  currency: 'USD',
  paymentToken: 'USDC',
  cluster: 'mainnet',
});

describe('validateCreateAcpCartRequest', () => {
  it('accepts a minimal valid request', () => {
    const out = validateCreateAcpCartRequest({ cart: baseCart() });
    expect(out.cart.id).toBe('cart_1');
    expect(out.cluster).toBeUndefined();
  });

  it('threads through optional fields', () => {
    const out = validateCreateAcpCartRequest({
      cart: baseCart(),
      cluster: 'devnet',
      note: 'hello',
      dueAt: '2030-01-01T00:00:00.000Z',
    });
    expect(out).toMatchObject({ cluster: 'devnet', note: 'hello', dueAt: '2030-01-01T00:00:00.000Z' });
  });

  it('rejects missing cart', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({}))).toMatchObject({
      code: 'missing_field',
      path: '$.cart',
    });
  });

  it('rejects non-object cart', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: 'oops' }))).toMatchObject({
      code: 'invalid_object',
      path: '$.cart',
    });
  });

  it('rejects unknown cluster', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: baseCart(), cluster: 'testnet' }))).toMatchObject({
      code: 'invalid_enum',
      path: '$.cluster',
    });
  });

  it('rejects unparseable dueAt', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: baseCart(), dueAt: 'not-a-date' }))).toMatchObject({
      code: 'invalid_timestamp',
      path: '$.dueAt',
    });
  });

  it('rejects oversized note', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: baseCart(), note: 'x'.repeat(501) }))).toMatchObject({
      code: 'field_too_long',
      path: '$.note',
    });
  });

  it('rejects forbidden secret keys smuggled into cart.merchant', () => {
    const cart = baseCart();
    (cart.merchant as Record<string, unknown>).delegatedSigner = 'server-wallet';
    expect(workflowError(() => validateCreateAcpCartRequest({ cart }))).toMatchObject({
      code: 'forbidden_secret',
    });
  });

  it('rejects unlimited approval authority in cart.metadata', () => {
    const cart = { ...baseCart(), metadata: { approvalAuthority: 'unlimited' } };
    expect(workflowError(() => validateCreateAcpCartRequest({ cart }))).toMatchObject({
      code: 'forbidden_authority',
    });
  });
});

describe('validateAcpReceiptIssuanceRequest', () => {
  it('accepts a valid request', () => {
    const out = validateAcpReceiptIssuanceRequest({
      cartId: 'cart_1',
      txid: 'tx_1',
      walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    });
    expect(out).toMatchObject({ cartId: 'cart_1', txid: 'tx_1' });
  });

  it('rejects missing txid', () => {
    expect(workflowError(() => validateAcpReceiptIssuanceRequest({
      cartId: 'c',
      walletAddress: 'w',
    }))).toMatchObject({ code: 'missing_field', path: '$.txid' });
  });

  it('rejects missing walletAddress', () => {
    expect(workflowError(() => validateAcpReceiptIssuanceRequest({
      cartId: 'c',
      txid: 't',
    }))).toMatchObject({ code: 'missing_field', path: '$.walletAddress' });
  });
});
