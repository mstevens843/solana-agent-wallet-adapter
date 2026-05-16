import { describe, expect, it } from 'vitest';

import {
  MPP_PAYMENT_RECEIPT_SCHEMA,
  MPP_PROTOCOL_VERSION,
  MppParseError,
  MppReceiptError,
  MppVerifyError,
  buildMppPaymentReceipt,
  challengeToApprovalParams,
  parseMppChallenge,
  verifyMppChallenge,
} from '../index.js';

describe('mpp-adapter scaffolding', () => {
  it('exports protocol constants', () => {
    expect(MPP_PROTOCOL_VERSION).toBe('mpp/0.1');
    expect(MPP_PAYMENT_RECEIPT_SCHEMA).toBe('mpp/payment/0.1');
  });

  it('parser stub throws not_implemented MppParseError', () => {
    try {
      parseMppChallenge({});
      expect.fail('expected parseMppChallenge stub to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MppParseError);
      expect((err as MppParseError).code).toBe('not_implemented');
    }
  });

  it('verifier + mapper stubs throw not_implemented MppVerifyError', () => {
    expect(() =>
      verifyMppChallenge({} as never, { clockNow: new Date() }),
    ).toThrow(MppVerifyError);
    expect(() => challengeToApprovalParams({} as never, 'wallet')).toThrow(MppVerifyError);
  });

  it('receipt stub throws not_implemented MppReceiptError', () => {
    expect(() =>
      buildMppPaymentReceipt({
        challenge: {} as never,
        credential: {} as never,
        walletAddress: 'wallet',
        cluster: 'devnet',
        settledAt: new Date().toISOString(),
      }),
    ).toThrow(MppReceiptError);
  });
});
