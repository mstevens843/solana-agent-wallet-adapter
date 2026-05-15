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
  cluster: 'mainnet-beta',
});

describe('validateCreateAcpCartRequest', () => {
  it('accepts a minimal valid request and returns a parsed AcpCart', () => {
    const out = validateCreateAcpCartRequest({ cart: baseCart() });
    expect(out.cart.id).toBe('cart_1');
    expect(out.cart.merchant.recipient).toBe('4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd');
    expect(out.cart.cluster).toBe('mainnet-beta');
    expect(out.cluster).toBeUndefined();
    expect(Object.isFrozen(out.cart)).toBe(true);
  });

  it('accepts a cluster from WORKFLOW_CLUSTERS', () => {
    const out = validateCreateAcpCartRequest({ cart: baseCart(), cluster: 'mainnet-beta' });
    expect(out.cluster).toBe('mainnet-beta');
  });

  it('attaches a receivedAt ISO timestamp', () => {
    const out = validateCreateAcpCartRequest({ cart: baseCart() });
    expect(out.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

  it('accepts a JSON-encoded cart string and parses it', () => {
    const out = validateCreateAcpCartRequest({ cart: JSON.stringify(baseCart()) });
    expect(out.cart.id).toBe('cart_1');
    expect(out.cart.cluster).toBe('mainnet-beta');
  });

  it("normalizes the legacy 'mainnet' cart-cluster alias", () => {
    const out = validateCreateAcpCartRequest({ cart: { ...baseCart(), cluster: 'mainnet' } });
    expect(out.cart.cluster).toBe('mainnet-beta');
  });

  it('rejects missing cart', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({}))).toMatchObject({
      code: 'missing_field',
      path: '$.cart',
    });
  });

  it('rejects a non-object/non-string cart with invalid_acp_cart:invalid_object', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: 123 }))).toMatchObject({
      code: 'invalid_acp_cart:invalid_object',
      path: '$.cart',
    });
  });

  it('wraps malformed JSON as invalid_acp_cart:invalid_json', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: '{nope' }))).toMatchObject({
      code: 'invalid_acp_cart:invalid_json',
      path: '$.cart',
    });
  });

  it('propagates AcpParseError missing_field as invalid_acp_cart:missing_field', () => {
    const cart = { ...baseCart() } as Record<string, unknown>;
    delete cart.id;
    expect(workflowError(() => validateCreateAcpCartRequest({ cart }))).toMatchObject({
      code: 'invalid_acp_cart:missing_field',
    });
  });

  it('rejects an unknown outer cluster', () => {
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: baseCart(), cluster: 'btc' }))).toMatchObject({
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

  it('rejects forbidden secret hidden inside a JSON-string cart (string-path defense)', () => {
    const cart = baseCart();
    (cart.merchant as Record<string, unknown>).delegatedSigner = 'server-wallet';
    expect(workflowError(() => validateCreateAcpCartRequest({ cart: JSON.stringify(cart) }))).toMatchObject({
      code: 'forbidden_secret',
    });
  });
});

describe('validateAcpReceiptIssuanceRequest', () => {
  it('accepts a valid request and attaches receivedAt', () => {
    const out = validateAcpReceiptIssuanceRequest({
      cartId: 'cart_1',
      txid: 'tx_1',
      walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    });
    expect(out).toMatchObject({ cartId: 'cart_1', txid: 'tx_1' });
    expect(out.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
