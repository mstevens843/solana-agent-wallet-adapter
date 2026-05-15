import { describe, expect, it } from 'vitest';

import { signals } from '../dev/index.js';

describe('DevLayer1 signals validators', () => {
  it('validates subscription caps and returns the stable request shape', () => {
    expect(signals.validateCreateSignalSubscriptionRequest({
      feedId: 'feed_1',
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '1000',
        allowlistedTokens: ['USDC'],
        maxExecutions: 5,
      },
    })).toMatchObject({
      feedId: 'feed_1',
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '1000',
        allowlistedTokens: ['USDC'],
        maxExecutions: 5,
      },
    });
  });

  it('rejects forbidden authority fields in subscription caps and emissions', () => {
    expect(() => signals.validateCreateSignalSubscriptionRequest({
      feedId: 'feed_1',
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '1000',
        allowlistedTokens: ['USDC'],
        delegatedSigner: 'nope',
      },
    })).toThrow(/not permitted/);

    expect(() => signals.validateCreateSignalEmissionRequest({
      feedId: 'feed_1',
      sourceTxid: '5'.repeat(64),
      actionTemplate: {
        connectorAction: 'swap',
        inputToken: 'USDC',
        amount: '10',
        approvalAuthority: 'unlimited',
      },
    })).toThrow(/not permitted/);
  });

  it('rejects malformed emissions', () => {
    expect(() => signals.validateCreateSignalEmissionRequest({
      feedId: 'feed_1',
      sourceTxid: 'short',
      actionTemplate: {},
    })).toThrow(/at least 32/);
  });
});
