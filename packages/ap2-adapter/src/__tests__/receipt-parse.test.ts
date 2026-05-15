import { describe, expect, it } from 'vitest';

import { buildAp2InboundReceipt, parseAp2InboundReceipt, verifyAp2InboundReceiptHash } from '../receipt.js';
import {
  AP2_INBOUND_RECEIPT_SCHEMA,
  Ap2ParseError,
  type Ap2InboundReceipt,
  type Ap2PaymentMandate,
  type Ap2VerifiedAgent,
} from '../types.js';

const WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TXID = '4nB9Kk8b4kY3o2hXz3y8sV9oN5pYZxQp8j8R6vF1bC2tH7dM8pV4yQ3xR2gB';

const AGENT: Ap2VerifiedAgent = {
  agentId: 'did:web:merchant.example',
  agentLabel: 'Acme',
  publicKey: '8ZUczUAUSZvMQdpiNPbBNXyrhzHebzMqTNa3qcc5jZ7v',
};

function mandate(): Ap2PaymentMandate {
  return {
    mandateId: '01J0AP2PAYMENT01',
    mandateType: 'payment_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    intentMandateId: '01J0AP2INTENT01',
    agent: AGENT,
    payment: {
      amount: '12.50',
      tokenSymbol: 'USDC',
      tokenMint: USDC_MINT,
      recipient: WALLET,
      cluster: 'mainnet-beta',
      memo: 'order#123',
    },
    signature: '11111111111111111111111111111111',
    signedFields: {},
  };
}

function buildReceipt(): Ap2InboundReceipt {
  return buildAp2InboundReceipt({
    mandate: mandate(),
    agent: AGENT,
    approval: { id: 'approval-1', kind: 'transfer_spl' },
    txid: TXID,
    walletAddress: WALLET,
    cluster: 'mainnet-beta',
    issuedAt: '2026-05-14T10:30:00.000Z',
    finalizedAt: '2026-05-14T10:30:05.000Z',
  });
}

describe('parseAp2InboundReceipt', () => {
  it('round-trips a freshly built receipt through JSON-serialize/parse', () => {
    const original = buildReceipt();
    const serialized = JSON.parse(JSON.stringify(original)) as unknown;
    const parsed = parseAp2InboundReceipt(serialized);
    expect(parsed).toEqual(original);
  });

  it('rejects non-object input', () => {
    try {
      parseAp2InboundReceipt('hello');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap2ParseError);
      expect((err as Ap2ParseError).code).toBe('invalid_receipt:not_object');
    }
  });

  it('rejects a wrong schema string', () => {
    const bad = JSON.parse(JSON.stringify(buildReceipt())) as Record<string, unknown>;
    bad.schema = 'ap2/inbound/0.2';
    try {
      parseAp2InboundReceipt(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_receipt:schema_mismatch');
    }
  });

  it('rejects a non-hex artifactHash', () => {
    const bad = JSON.parse(JSON.stringify(buildReceipt())) as Record<string, unknown>;
    bad.artifactHash = 'not-hex';
    try {
      parseAp2InboundReceipt(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_receipt:bad_hash');
    }
  });

  it('rejects a missing required nested field', () => {
    const bad = JSON.parse(JSON.stringify(buildReceipt())) as Record<string, unknown>;
    (bad.execution as Record<string, unknown>).txid = '';
    try {
      parseAp2InboundReceipt(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_receipt:invalid_field');
    }
  });

  it('rejects unknown enum values', () => {
    const bad = JSON.parse(JSON.stringify(buildReceipt())) as Record<string, unknown>;
    (bad.approval as Record<string, unknown>).kind = 'transfer_unknown';
    try {
      parseAp2InboundReceipt(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_receipt:invalid_field');
    }
  });

  it('preserves the schema constant on the parsed result', () => {
    const parsed = parseAp2InboundReceipt(JSON.parse(JSON.stringify(buildReceipt())));
    expect(parsed.schema).toBe(AP2_INBOUND_RECEIPT_SCHEMA);
  });
});

describe('verifyAp2InboundReceiptHash', () => {
  it('returns true for an unmodified receipt', () => {
    expect(verifyAp2InboundReceiptHash(buildReceipt())).toBe(true);
  });

  it('returns true after JSON round-trip via parseAp2InboundReceipt', () => {
    const original = buildReceipt();
    const parsed = parseAp2InboundReceipt(JSON.parse(JSON.stringify(original)));
    expect(verifyAp2InboundReceiptHash(parsed)).toBe(true);
  });

  it('returns false when the txid is tampered post-build', () => {
    const receipt = buildReceipt();
    const tampered: Ap2InboundReceipt = {
      ...receipt,
      execution: { ...receipt.execution, txid: 'tamperedTxid111111111111111111111111111111' },
    };
    expect(verifyAp2InboundReceiptHash(tampered)).toBe(false);
  });

  it('returns false when payment amount is tampered', () => {
    const receipt = buildReceipt();
    const tampered: Ap2InboundReceipt = {
      ...receipt,
      payment: { ...receipt.payment, amount: '9999.00' },
    };
    expect(verifyAp2InboundReceiptHash(tampered)).toBe(false);
  });

  it('returns false when artifactHash itself is replaced', () => {
    const receipt = buildReceipt();
    const tampered: Ap2InboundReceipt = {
      ...receipt,
      artifactHash: '0'.repeat(64),
    };
    expect(verifyAp2InboundReceiptHash(tampered)).toBe(false);
  });
});
