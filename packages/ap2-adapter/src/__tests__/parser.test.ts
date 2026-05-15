import { describe, expect, it } from 'vitest';

import { Ap2ParseError } from '../types.js';
import { parseAp2Mandate } from '../parser.js';

const RECIPIENT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const AGENT_PUBKEY = '11111111111111111111111111111111';
const SIGNATURE = '5wHu1qwD7y6kBxr5xPjQ9rW3v2QH1mZkXyP3vDqJ4hT8YqLfWxK2nKj3PpRzU1jM9hN6vQzS8tA9wEx2bRyF7';

function intentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    mandateId: '01J0AP2INBOUND01',
    mandateType: 'intent_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    agent: {
      agentId: 'did:web:merchant.example',
      agentLabel: 'Acme',
      publicKey: AGENT_PUBKEY,
    },
    intent: {
      description: 'Subscription Tier B',
      cap: {
        amount: '12.50',
        tokenSymbol: 'USDC',
        tokenMint: USDC_MINT,
        recipient: RECIPIENT,
        cluster: 'mainnet-beta',
        memo: 'order#123',
      },
      maxRuns: 1,
    },
    signature: SIGNATURE,
    signedFields: {
      mandateId: '01J0AP2INBOUND01',
      mandateType: 'intent_mandate',
      protocolVersion: 'ap2/0.1',
      issuedAt: '2026-05-14T10:00:00.000Z',
      expiresAt: '2026-05-14T11:00:00.000Z',
      intent: {
        description: 'Subscription Tier B',
        cap: {
          amount: '12.50',
          tokenSymbol: 'USDC',
          tokenMint: USDC_MINT,
          recipient: RECIPIENT,
          cluster: 'mainnet-beta',
          memo: 'order#123',
        },
        maxRuns: 1,
      },
    },
  };
  return { ...base, ...overrides };
}

function paymentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    mandateId: '01J0AP2PAYMENT01',
    mandateType: 'payment_mandate',
    protocolVersion: 'ap2/0.1',
    issuedAt: '2026-05-14T10:00:00.000Z',
    expiresAt: '2026-05-14T11:00:00.000Z',
    intentMandateId: '01J0AP2INBOUND01',
    agent: {
      agentId: 'did:web:merchant.example',
      agentLabel: 'Acme',
      publicKey: AGENT_PUBKEY,
    },
    payment: {
      amount: '12.50',
      tokenSymbol: 'USDC',
      tokenMint: USDC_MINT,
      recipient: RECIPIENT,
      cluster: 'mainnet-beta',
    },
    signature: SIGNATURE,
    signedFields: {
      mandateId: '01J0AP2PAYMENT01',
      mandateType: 'payment_mandate',
      protocolVersion: 'ap2/0.1',
      issuedAt: '2026-05-14T10:00:00.000Z',
      expiresAt: '2026-05-14T11:00:00.000Z',
      intentMandateId: '01J0AP2INBOUND01',
      payment: {
        amount: '12.50',
        tokenSymbol: 'USDC',
        tokenMint: USDC_MINT,
        recipient: RECIPIENT,
        cluster: 'mainnet-beta',
      },
    },
  };
  return { ...base, ...overrides };
}

describe('parseAp2Mandate', () => {
  it('round-trips a valid IntentMandate', () => {
    const mandate = parseAp2Mandate(intentFixture());
    expect(mandate.mandateType).toBe('intent_mandate');
    if (mandate.mandateType !== 'intent_mandate') throw new Error('discriminant');
    expect(mandate.mandateId).toBe('01J0AP2INBOUND01');
    expect(mandate.agent.agentLabel).toBe('Acme');
    expect(mandate.intent.cap.amount).toBe('12.50');
    expect(mandate.intent.cap.cluster).toBe('mainnet-beta');
    expect(mandate.intent.cap.memo).toBe('order#123');
    expect(mandate.intent.maxRuns).toBe(1);
  });

  it('round-trips a valid PaymentMandate', () => {
    const mandate = parseAp2Mandate(paymentFixture());
    expect(mandate.mandateType).toBe('payment_mandate');
    if (mandate.mandateType !== 'payment_mandate') throw new Error('discriminant');
    expect(mandate.intentMandateId).toBe('01J0AP2INBOUND01');
    expect(mandate.payment.tokenSymbol).toBe('USDC');
    expect(mandate.payment.memo).toBeUndefined();
  });

  it('parses a JSON string input', () => {
    const json = JSON.stringify(intentFixture());
    const mandate = parseAp2Mandate(json);
    expect(mandate.mandateType).toBe('intent_mandate');
  });

  it('rejects non-JSON string input', () => {
    expect(() => parseAp2Mandate('{not json')).toThrowError(Ap2ParseError);
    try {
      parseAp2Mandate('{not json');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_json');
    }
  });

  it('rejects input exceeding the byte cap', () => {
    const oversize = 'x'.repeat(70 * 1024);
    try {
      parseAp2Mandate(oversize);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap2ParseError);
      expect((err as Ap2ParseError).code).toBe('mandate_too_large');
    }
  });

  it('rejects missing mandateType', () => {
    const broken = intentFixture();
    delete broken.mandateType;
    try {
      parseAp2Mandate(broken);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Ap2ParseError);
      expect((err as Ap2ParseError).code).toBe('missing_field');
    }
  });

  it('rejects unknown mandateType', () => {
    try {
      parseAp2Mandate(intentFixture({ mandateType: 'subscription_mandate' }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_field');
    }
  });

  it('rejects forbidden privateKey field nested in intent', () => {
    const broken = intentFixture();
    const intent = broken.intent as Record<string, unknown>;
    intent.privateKey = 'hunter2';
    try {
      parseAp2Mandate(broken);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('forbidden_secret');
    }
  });

  it('rejects forbidden recoveryphrase key with mixed case and separator', () => {
    const broken = intentFixture();
    (broken as Record<string, unknown>).Recovery_Phrase = 'a b c';
    try {
      parseAp2Mandate(broken);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('forbidden_secret');
    }
  });

  it('rejects malformed amount', () => {
    for (const bad of ['1.0.0', '-5', 'abc', '']) {
      const broken = intentFixture();
      const intent = broken.intent as Record<string, unknown>;
      const cap = intent.cap as Record<string, unknown>;
      cap.amount = bad;
      try {
        parseAp2Mandate(broken);
        throw new Error(`expected throw for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(Ap2ParseError);
      }
    }
  });

  it('rejects invalid ISO timestamp', () => {
    try {
      parseAp2Mandate(intentFixture({ expiresAt: 'tomorrow' }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_field');
    }
  });

  it('rejects signedFields that diverge from top-level', () => {
    const broken = intentFixture();
    const signedFields = broken.signedFields as Record<string, unknown>;
    signedFields.mandateId = 'tampered';
    try {
      parseAp2Mandate(broken);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('signed_fields_mismatch');
    }
  });

  it('rejects non-base58 recipient', () => {
    const broken = intentFixture();
    const intent = broken.intent as Record<string, unknown>;
    const cap = intent.cap as Record<string, unknown>;
    cap.recipient = 'not_base58_!!!';
    try {
      parseAp2Mandate(broken);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Ap2ParseError).code).toBe('invalid_field');
    }
  });
});
