import { describe, expect, it } from 'vitest';

import { RECEIPT_SCHEMA, USDC_MINT_MAINNET } from '../constants.js';
import { AcpReceiptError } from '../errors.js';
import {
  buildAcpOutboundReceipt,
  canonicalJsonStringify,
  hashCart,
} from '../receipt.js';
import { MERCHANT_RECIPIENT_MAINNET, mainnetUsdcCart } from './fixtures.js';

const WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

function receiptError(action: () => unknown, code: string): AcpReceiptError {
  try {
    action();
  } catch (err) {
    expect(err).toBeInstanceOf(AcpReceiptError);
    const e = err as AcpReceiptError;
    expect(e.code).toBe(code);
    return e;
  }
  throw new Error('Expected AcpReceiptError.');
}

describe('buildAcpOutboundReceipt', () => {
  it('builds a structurally complete receipt', () => {
    const receipt = buildAcpOutboundReceipt({
      cart: mainnetUsdcCart(),
      walletAddress: WALLET,
      txid: 'mockTxId123',
    });
    expect(receipt.schema).toBe(RECEIPT_SCHEMA);
    expect(receipt.receiptVersion).toBe('1');
    expect(receipt.receiptId).toMatch(/^acp_rcpt_[0-9a-f-]{36}$/);
    expect(receipt.walletAddress).toBe(WALLET);
    expect(receipt.txid).toBe('mockTxId123');
    expect(receipt.recipient).toBe(MERCHANT_RECIPIENT_MAINNET);
    expect(receipt.cluster).toBe('mainnet-beta');
    expect(receipt.cartHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('omits paymentTokenMint and metadata when absent from the cart', () => {
    const receipt = buildAcpOutboundReceipt({
      cart: mainnetUsdcCart(),
      walletAddress: WALLET,
      txid: 'tx',
    });
    expect(receipt.paymentTokenMint).toBeUndefined();
    expect(receipt.metadata).toBeUndefined();
  });

  it('round-trips paymentTokenMint and metadata from the cart', () => {
    const receipt = buildAcpOutboundReceipt({
      cart: mainnetUsdcCart({
        paymentTokenMint: USDC_MINT_MAINNET,
        metadata: { orderRef: 'op_42' },
      }),
      walletAddress: WALLET,
      txid: 'tx',
    });
    expect(receipt.paymentTokenMint).toBe(USDC_MINT_MAINNET);
    expect(receipt.metadata).toEqual({ orderRef: 'op_42' });
  });

  it('produces a deterministic cartHash for the same cart', () => {
    const cart = mainnetUsdcCart();
    expect(hashCart(cart)).toBe(hashCart(cart));
  });

  it('produces a different cartHash when memo changes', () => {
    const a = hashCart(mainnetUsdcCart({ memo: 'a' }));
    const b = hashCart(mainnetUsdcCart({ memo: 'b' }));
    expect(a).not.toBe(b);
  });

  it('throws on missing walletAddress', () => {
    receiptError(
      () => buildAcpOutboundReceipt({ cart: mainnetUsdcCart(), walletAddress: '', txid: 'tx' }),
      'missing_field',
    );
  });

  it('throws on missing txid', () => {
    receiptError(
      () => buildAcpOutboundReceipt({ cart: mainnetUsdcCart(), walletAddress: WALLET, txid: '' }),
      'missing_field',
    );
  });

  it('rejects invalid settledAt', () => {
    receiptError(
      () => buildAcpOutboundReceipt({
        cart: mainnetUsdcCart(),
        walletAddress: WALLET,
        txid: 'tx',
        settledAt: 'not-a-date',
      }),
      'invalid_timestamp',
    );
  });
});

describe('canonicalJsonStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('omits undefined values', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles arrays preserving order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});
