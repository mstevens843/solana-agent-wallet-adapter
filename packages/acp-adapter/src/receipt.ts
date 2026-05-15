import { createHash, randomUUID } from 'node:crypto';

import { RECEIPT_SCHEMA, RECEIPT_VERSION } from './constants.js';
import { AcpReceiptError } from './errors.js';
import type { AcpCart, AcpReceipt } from './types.js';

export interface BuildAcpOutboundReceiptInput {
  readonly cart: AcpCart;
  readonly walletAddress: string;
  readonly txid: string;
  readonly settledAt?: string;
}

export function buildAcpOutboundReceipt(input: BuildAcpOutboundReceiptInput): AcpReceipt {
  const walletAddress = requireString(input.walletAddress, 'walletAddress');
  const txid = requireString(input.txid, 'txid');
  const settledAt = input.settledAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(settledAt))) {
    throw new AcpReceiptError('invalid_timestamp', 'settledAt must be an ISO-8601 timestamp.', '$.settledAt');
  }
  const cartHash = hashCart(input.cart);
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    receiptVersion: RECEIPT_VERSION,
    receiptId: `acp_rcpt_${randomUUID()}`,
    cartId: input.cart.id,
    cartHash,
    walletAddress,
    txid,
    settledAt,
    amount: input.cart.totalAmount,
    token: input.cart.paymentToken,
    ...(input.cart.paymentTokenMint !== undefined ? { paymentTokenMint: input.cart.paymentTokenMint } : {}),
    recipient: input.cart.merchant.recipient,
    cluster: input.cart.cluster,
    merchant: input.cart.merchant,
    lineItems: input.cart.lineItems,
    ...(input.cart.memo !== undefined ? { memo: input.cart.memo } : {}),
    ...(input.cart.metadata !== undefined ? { metadata: input.cart.metadata } : {}),
  });
}

export function hashCart(cart: AcpCart): string {
  return createHash('sha256').update(canonicalJsonStringify(cart)).digest('hex');
}

// Deterministic stringifier: sorts object keys at every depth so logically
// equal carts always hash the same regardless of input field order.
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AcpReceiptError('invalid_number', 'Cannot canonicalize non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(',')}}`;
  }
  throw new AcpReceiptError('invalid_value', `Cannot canonicalize value of type ${typeof value}.`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AcpReceiptError('missing_field', `${field} is required.`, `$.${field}`);
  }
  return value;
}
