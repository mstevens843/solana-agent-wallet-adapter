import { describe, expect, it } from 'vitest';

import {
  clampAmount,
  clampToSubscriptionCaps,
  compareDecimalStrings,
  evaluateSubscription,
  extractTemplateAmount,
  extractTemplateRecipient,
  extractTemplateToken,
  isRecipientAllowed,
  isTokenAllowed,
  overrideTemplateAmount,
  addDecimalStrings,
  subtractDecimalStrings,
} from '../subscription.js';
import type { SignalSubscriptionRecord } from '../types.js';

const baseSubscription = (overrides: Partial<SignalSubscriptionRecord> = {}): SignalSubscriptionRecord => ({
  id: 'sub_1',
  followerWallet: 'Follower1111111111111111111111111111111111',
  feedId: 'feed_1',
  caps: {
    perRunMaxAmount: '200',
    lifetimeMaxAmount: '10000',
    allowlistedTokens: ['USDC'],
  },
  subscribedAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  status: 'active',
  ...overrides,
});

describe('evaluateSubscription', () => {
  const now = '2026-05-14T00:00:00.000Z';

  it('treats active subscriptions with no expiresAt as deliverable', () => {
    expect(evaluateSubscription(baseSubscription(), now)).toEqual({ kind: 'active' });
  });

  it('skips paused subscriptions', () => {
    expect(evaluateSubscription(baseSubscription({ status: 'paused' }), now)).toEqual({
      kind: 'skip',
      reason: 'subscription_paused',
    });
  });

  it('skips revoked subscriptions', () => {
    expect(evaluateSubscription(baseSubscription({ status: 'revoked' }), now)).toEqual({
      kind: 'skip',
      reason: 'subscription_revoked',
    });
  });

  it('skips subscriptions whose caps.expiresAt is at or before now', () => {
    const expired = baseSubscription({
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        expiresAt: '2026-05-13T23:59:59.999Z',
      },
    });
    expect(evaluateSubscription(expired, now)).toEqual({
      kind: 'skip',
      reason: 'subscription_expired',
    });
  });

  it('keeps subscriptions active when caps.expiresAt is strictly after now', () => {
    const future = baseSubscription({
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        expiresAt: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(evaluateSubscription(future, now)).toEqual({ kind: 'active' });
  });

  it('skips subscriptions that exhausted lifetime amount or max executions', () => {
    expect(evaluateSubscription(baseSubscription(), now, {
      executionCount: 0,
      lifetimeAmount: '10000',
    })).toEqual({ kind: 'skip', reason: 'lifetime_cap_exhausted' });

    expect(evaluateSubscription(baseSubscription({
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        maxExecutions: 2,
      },
    }), now, {
      executionCount: 2,
      lifetimeAmount: '100',
    })).toEqual({ kind: 'skip', reason: 'max_executions_reached' });
  });
});

describe('template field extractors', () => {
  it('reads amount, amountSol, inputAmount in priority order', () => {
    expect(extractTemplateAmount({ amount: '10', amountSol: '99', inputAmount: '5' })).toBe('10');
    expect(extractTemplateAmount({ amountSol: '99', inputAmount: '5' })).toBe('99');
    expect(extractTemplateAmount({ inputAmount: '5' })).toBe('5');
    expect(extractTemplateAmount({})).toBeUndefined();
    expect(extractTemplateAmount(undefined)).toBeUndefined();
    expect(extractTemplateAmount({ amount: '   ' })).toBeUndefined();
  });

  it('reads token, inputToken, mint in priority order', () => {
    expect(extractTemplateToken({ token: 'USDC' })).toBe('USDC');
    expect(extractTemplateToken({ inputToken: 'SOL' })).toBe('SOL');
    expect(extractTemplateToken({ mint: 'Es9vMFrz...' })).toBe('Es9vMFrz...');
    expect(extractTemplateToken({})).toBeUndefined();
  });

  it('reads recipient or to', () => {
    expect(extractTemplateRecipient({ recipient: 'AAA' })).toBe('AAA');
    expect(extractTemplateRecipient({ to: 'BBB' })).toBe('BBB');
    expect(extractTemplateRecipient({})).toBeUndefined();
  });
});

describe('allowlist checks', () => {
  it('isTokenAllowed is case-insensitive and rejects empty/missing tokens', () => {
    expect(isTokenAllowed('USDC', ['usdc', 'sol'])).toBe(true);
    expect(isTokenAllowed('usdc', ['USDC'])).toBe(true);
    expect(isTokenAllowed('BONK', ['USDC'])).toBe(false);
    expect(isTokenAllowed(undefined, ['USDC'])).toBe(false);
    expect(isTokenAllowed('', ['USDC'])).toBe(false);
    expect(isTokenAllowed('USDC', [])).toBe(false);
  });

  it('isRecipientAllowed permits anyone when allowlist is absent or empty', () => {
    expect(isRecipientAllowed('AAA', undefined)).toBe(true);
    expect(isRecipientAllowed('AAA', [])).toBe(true);
    expect(isRecipientAllowed(undefined, undefined)).toBe(true);
  });

  it('isRecipientAllowed requires membership when allowlist is set', () => {
    expect(isRecipientAllowed('AAA', ['AAA', 'BBB'])).toBe(true);
    expect(isRecipientAllowed('CCC', ['AAA', 'BBB'])).toBe(false);
    expect(isRecipientAllowed(undefined, ['AAA'])).toBe(false);
  });
});

describe('decimal comparison + clamp', () => {
  it('compareDecimalStrings handles integer, fractional, and mixed widths', () => {
    expect(compareDecimalStrings('10000', '200')).toBe(1);
    expect(compareDecimalStrings('200', '10000')).toBe(-1);
    expect(compareDecimalStrings('200', '200')).toBe(0);
    expect(compareDecimalStrings('0.001', '0.01')).toBe(-1);
    expect(compareDecimalStrings('1.5', '1.50')).toBe(0);
    expect(compareDecimalStrings('999999999999999999', '999999999999999998')).toBe(1);
  });

  it('clampAmount returns max when value exceeds it', () => {
    expect(clampAmount('10000', '200')).toBe('200');
    expect(clampAmount('199', '200')).toBe('199');
    expect(clampAmount('200', '200')).toBe('200');
    expect(clampAmount('0.001', '0.01')).toBe('0.001');
  });

  it('compareDecimalStrings throws on invalid input', () => {
    expect(() => compareDecimalStrings('abc', '1')).toThrow(/Invalid decimal/);
    expect(() => compareDecimalStrings('1', '0x10')).toThrow(/Invalid decimal/);
  });

  it('adds, subtracts, and clamps against remaining lifetime caps', () => {
    expect(addDecimalStrings('1.25', '0.750')).toBe('2');
    expect(subtractDecimalStrings('10.00', '3.5')).toBe('6.5');
    expect(clampToSubscriptionCaps('10000', baseSubscription(), {
      executionCount: 1,
      lifetimeAmount: '9900',
    })).toBe('100');
  });
});

describe('overrideTemplateAmount', () => {
  it('rewrites the first present amount key', () => {
    const result = overrideTemplateAmount({ amount: '10000', token: 'USDC' }, '200');
    expect(result.template).toEqual({ amount: '200', token: 'USDC' });
    expect(result.key).toBe('amount');
  });

  it('falls back to amountSol if amount is absent', () => {
    const result = overrideTemplateAmount({ amountSol: '99' }, '1');
    expect(result.template).toEqual({ amountSol: '1' });
    expect(result.key).toBe('amountSol');
  });

  it('inserts amount when no amount-like key exists', () => {
    const result = overrideTemplateAmount({ memo: 'hi' }, '5');
    expect(result.template).toEqual({ memo: 'hi', amount: '5' });
    expect(result.key).toBe('amount');
  });
});
