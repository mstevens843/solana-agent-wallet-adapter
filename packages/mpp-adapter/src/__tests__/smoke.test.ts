import { describe, expect, it } from 'vitest';

import {
  MPP_PAYMENT_RECEIPT_SCHEMA,
  MPP_PROTOCOL_VERSION,
  MppParseError,
  MppVerifyError,
  buildMppPaymentReceipt,
  challengeToApprovalParams,
  parseMppChallenge,
  verifyMppChallenge,
  verifyMppPaymentReceiptHash,
  type MppChallenge,
} from '../index.js';

const WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const RECIPIENT = 'BvgrFr5Bcaa9NudH3DCxgMnHV1FT1nzD5JtMHsmpKnFB';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = new Date('2026-05-16T12:00:00.000Z');

function challenge(overrides: Partial<MppChallenge> = {}): MppChallenge {
  return {
    protocolVersion: MPP_PROTOCOL_VERSION,
    nonce: 'nonce_001',
    amount: '2.50',
    currency: 'USDC',
    resourceUrl: 'https://merchant.example/resource/123',
    expiresAt: '2026-05-16T13:00:00.000Z',
    paymentMethods: [
      {
        kind: 'solana-spl',
        mint: USDC_MINT,
        recipient: RECIPIENT,
        network: 'devnet',
      },
    ],
    merchant: { id: 'merchant_001', name: 'Acme' },
    metadata: { orderId: 'order_001' },
    ...overrides,
  };
}

describe('mpp-adapter', () => {
  it('exports protocol constants', () => {
    expect(MPP_PROTOCOL_VERSION).toBe('mpp/0.1');
    expect(MPP_PAYMENT_RECEIPT_SCHEMA).toBe('mpp/payment/0.1');
  });

  it('parses a valid MPP challenge from object and JSON string', () => {
    expect(parseMppChallenge(challenge()).paymentMethods[0]?.kind).toBe('solana-spl');
    expect(parseMppChallenge(JSON.stringify(challenge())).merchant?.name).toBe('Acme');
  });

  it('enforces the 32 KiB default challenge size cap', () => {
    expect(() =>
      parseMppChallenge(JSON.stringify(challenge({ nonce: 'n'.repeat(33 * 1024) }))),
    ).toThrowError(MppParseError);
  });

  it('rejects forbidden secrets before structural validation', () => {
    expect(() => parseMppChallenge({ ...challenge(), privateKey: 'nope' })).toThrowError(MppParseError);
    try {
      parseMppChallenge({ ...challenge(), delegatedSigner: 'nope' });
    } catch (err) {
      expect((err as MppParseError).code).toBe('forbidden_secret');
    }
  });

  it('verify rejects expired challenges', () => {
    expect(() =>
      verifyMppChallenge(challenge({ expiresAt: '2026-05-16T11:00:00.000Z' }), { clockNow: NOW }),
    ).toThrowError(MppVerifyError);
  });

  it('verify rejects unsupported rails and mint allowlist misses', () => {
    expect(() =>
      verifyMppChallenge(challenge({ paymentMethods: [] }), { clockNow: NOW }),
    ).toThrowError(MppVerifyError);
    expect(() =>
      verifyMppChallenge(challenge(), { clockNow: NOW, allowedRails: ['solana-sol'] }),
    ).toThrowError(MppVerifyError);
    try {
      verifyMppChallenge(challenge(), { clockNow: NOW, allowedMints: ['DifferentMint11111111111111111111111111111'] });
    } catch (err) {
      expect((err as MppVerifyError).code).toBe('mint_not_allowed');
    }
  });

  it('verify returns a deterministic challenge hash', () => {
    const first = verifyMppChallenge(challenge(), { clockNow: NOW, expectedCluster: 'devnet', allowedMints: [USDC_MINT] });
    const second = verifyMppChallenge(challenge(), { clockNow: NOW, expectedCluster: 'devnet', allowedMints: [USDC_MINT] });
    expect(first.verified).toBe(true);
    expect(first.paymentMethod.mint).toBe(USDC_MINT);
    expect(first.challengeHash).toBe(second.challengeHash);
    expect(first.challengeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps a challenge into an MPP approval payload', () => {
    const verified = verifyMppChallenge(challenge(), { clockNow: NOW });
    const approval = challengeToApprovalParams(challenge(), WALLET, { paymentMethod: verified.paymentMethod });
    expect(approval.kind).toBe('transfer_spl');
    expect(approval.summary).toBe('Agent requested 2.50 USDC to Acme via MPP. Pay to unlock https://merchant.example/resource/123.');
    expect(approval.metadata.connectorId).toBe('mpp');
    expect(approval.metadata.mppChallengeHash).toBe(verified.challengeHash);
  });

  it('builds deterministic, self-verifying payment receipts', () => {
    const verified = verifyMppChallenge(challenge(), { clockNow: NOW });
    const input = {
      challenge: challenge(),
      credential: {
        kind: verified.paymentMethod.kind,
        signature: 'TXSIGFIXTURE',
        txid: 'TXSIGFIXTURE',
        payerWallet: WALLET,
        settledAt: '2026-05-16T12:10:00.000Z',
      },
      walletAddress: WALLET,
      cluster: 'devnet' as const,
      txid: 'TXSIGFIXTURE',
      settledAt: '2026-05-16T12:10:00.000Z',
      issuedAt: '2026-05-16T12:11:00.000Z',
      paymentMethod: verified.paymentMethod,
    };
    const first = buildMppPaymentReceipt(input);
    const second = buildMppPaymentReceipt(input);
    expect(first.schema).toBe(MPP_PAYMENT_RECEIPT_SCHEMA);
    expect(first.artifactHash).toBe(second.artifactHash);
    expect(verifyMppPaymentReceiptHash(first)).toBe(true);
    expect(verifyMppPaymentReceiptHash({ ...first, amount: '999.00' })).toBe(false);
  });
});
