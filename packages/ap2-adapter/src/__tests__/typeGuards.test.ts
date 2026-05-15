import { describe, expect, it } from 'vitest';

import {
  isIntentMandate,
  isPaymentMandate,
  type Ap2IntentMandate,
  type Ap2Mandate,
  type Ap2PaymentMandate,
} from '../types.js';

const COMMON = {
  mandateId: 'm1',
  protocolVersion: 'ap2/0.1',
  issuedAt: '2026-05-14T10:00:00.000Z',
  expiresAt: '2026-05-14T11:00:00.000Z',
  agent: { agentId: 'a', agentLabel: 'Acme', publicKey: '11111111111111111111111111111111' },
  signature: '11111111111111111111111111111111',
  signedFields: {},
};

const intent: Ap2IntentMandate = {
  ...COMMON,
  mandateType: 'intent_mandate',
  intent: {
    description: 'sub',
    cap: {
      amount: '1',
      tokenSymbol: 'USDC',
      tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      recipient: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
      cluster: 'mainnet-beta',
    },
  },
};

const payment: Ap2PaymentMandate = {
  ...COMMON,
  mandateType: 'payment_mandate',
  intentMandateId: 'i1',
  payment: {
    amount: '1',
    tokenSymbol: 'USDC',
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    recipient: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
    cluster: 'mainnet-beta',
  },
};

describe('isIntentMandate / isPaymentMandate', () => {
  it('discriminates the union correctly', () => {
    expect(isIntentMandate(intent)).toBe(true);
    expect(isIntentMandate(payment)).toBe(false);
    expect(isPaymentMandate(intent)).toBe(false);
    expect(isPaymentMandate(payment)).toBe(true);
  });

  it('narrows the type inside a conditional', () => {
    const mandate: Ap2Mandate = intent;
    if (isIntentMandate(mandate)) {
      expect(mandate.intent.cap.amount).toBe('1');
    } else {
      throw new Error('expected IntentMandate');
    }
  });

  it('narrows PaymentMandate inside a conditional', () => {
    const mandate: Ap2Mandate = payment;
    if (isPaymentMandate(mandate)) {
      expect(mandate.intentMandateId).toBe('i1');
      expect(mandate.payment.amount).toBe('1');
    } else {
      throw new Error('expected PaymentMandate');
    }
  });
});
