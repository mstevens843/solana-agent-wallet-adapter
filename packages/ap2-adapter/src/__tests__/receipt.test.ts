import { describe, expect, it } from 'vitest';

import { buildAp2InboundReceipt } from '../receipt.js';
import {
  AP2_INBOUND_RECEIPT_SCHEMA,
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

function buildInput() {
  return {
    mandate: mandate(),
    agent: AGENT,
    approval: { id: 'approval-1', kind: 'transfer_spl' as const },
    txid: TXID,
    walletAddress: WALLET,
    cluster: 'mainnet-beta' as const,
    issuedAt: '2026-05-14T10:30:00.000Z',
    finalizedAt: '2026-05-14T10:30:05.000Z',
  };
}

describe('buildAp2InboundReceipt', () => {
  it('produces all required AP2 attestation fields', () => {
    const receipt = buildAp2InboundReceipt(buildInput());
    expect(receipt.schema).toBe(AP2_INBOUND_RECEIPT_SCHEMA);
    expect(receipt.mandateId).toBe('01J0AP2PAYMENT01');
    expect(receipt.mandateType).toBe('payment_mandate');
    expect(receipt.protocolVersion).toBe('ap2/0.1');
    expect(receipt.agent.agentLabel).toBe('Acme');
    expect(receipt.payment.amount).toBe('12.50');
    expect(receipt.payment.memo).toBe('order#123');
    expect(receipt.approval).toEqual({ id: 'approval-1', kind: 'transfer_spl' });
    expect(receipt.execution.txid).toBe(TXID);
    expect(receipt.execution.cluster).toBe('mainnet-beta');
    expect(receipt.execution.finalizedAt).toBe('2026-05-14T10:30:05.000Z');
    expect(receipt.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a deterministic artifactHash for identical input', () => {
    const a = buildAp2InboundReceipt(buildInput());
    const b = buildAp2InboundReceipt(buildInput());
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  it('changes artifactHash when the txid changes', () => {
    const baseline = buildAp2InboundReceipt(buildInput());
    const mutated = buildAp2InboundReceipt({ ...buildInput(), txid: 'DifferentTxid111111111111111111111111111111' });
    expect(mutated.artifactHash).not.toBe(baseline.artifactHash);
  });

  it('changes artifactHash when payment amount changes', () => {
    const baseline = buildAp2InboundReceipt(buildInput());
    const m = mandate();
    m.payment.amount = '99.99';
    const mutated = buildAp2InboundReceipt({ ...buildInput(), mandate: m });
    expect(mutated.artifactHash).not.toBe(baseline.artifactHash);
  });

  it('falls back to finalizedAt when issuedAt is omitted', () => {
    const { issuedAt: _omit, ...rest } = buildInput();
    void _omit;
    const receipt = buildAp2InboundReceipt(rest);
    expect(receipt.issuedAt).toBe(rest.finalizedAt);
  });
});
