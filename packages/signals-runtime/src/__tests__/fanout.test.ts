import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';
import { describe, expect, it } from 'vitest';

import { planFanout } from '../fanout.js';
import type {
  SignalEmissionRecord,
  SignalSubscriptionRecord,
} from '../types.js';

const NOW = '2026-05-14T00:00:00.000Z';

function makeEmission(template: JsonObject, overrides: Partial<SignalEmissionRecord> = {}): SignalEmissionRecord {
  return {
    id: 'emission_1',
    feedId: 'feed_1',
    publisherWallet: 'PubWallet11111111111111111111111111111111',
    emittedAt: '2026-05-14T00:00:00.000Z',
    sourceTxid: 'pub_tx_signature_111',
    actionTemplate: template,
    delivered: 0,
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SignalSubscriptionRecord> = {}): SignalSubscriptionRecord {
  return {
    id: 'sub_a',
    followerWallet: 'FollowerA1111111111111111111111111111111',
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
  };
}

describe('planFanout', () => {
  it('clamps a $10K publisher trade to a $200 follower cap', () => {
    const emission = makeEmission({ connectorAction: 'swap', inputToken: 'USDC', amount: '10000', outputToken: 'SOL' });
    const subscription = makeSubscription();
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });

    expect(plan.emissionId).toBe('emission_1');
    expect(plan.feedId).toBe('feed_1');
    expect(plan.decisions).toHaveLength(1);
    const [decision] = plan.decisions;
    expect(decision?.verdict).toBe('deliver');
    expect(decision?.clampedAmount).toBe('200');
    expect(decision?.clampedActionTemplate).toEqual({
      connectorAction: 'swap',
      inputToken: 'USDC',
      amount: '200',
      outputToken: 'SOL',
    });
  });

  it('clamps multiple subscribers independently based on their caps', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '750' });
    const subs = [
      makeSubscription({ id: 'sub_c', followerWallet: 'C111111111111111111111111111111111111111', caps: { perRunMaxAmount: '100', lifetimeMaxAmount: '10000', allowlistedTokens: ['USDC'] } }),
      makeSubscription({ id: 'sub_b', followerWallet: 'B111111111111111111111111111111111111111', caps: { perRunMaxAmount: '500', lifetimeMaxAmount: '10000', allowlistedTokens: ['USDC'] } }),
      makeSubscription({ id: 'sub_a', followerWallet: 'A111111111111111111111111111111111111111', caps: { perRunMaxAmount: '10000', lifetimeMaxAmount: '10000', allowlistedTokens: ['USDC'] } }),
    ];

    const plan = planFanout({ emission, subscriptions: subs, nowIso: NOW });
    // Sorted by id ascending: sub_a, sub_b, sub_c
    expect(plan.decisions.map((d) => d.subscription.id)).toEqual(['sub_a', 'sub_b', 'sub_c']);
    expect(plan.decisions.map((d) => d.clampedAmount)).toEqual(['750', '500', '100']);
    expect(plan.decisions.every((d) => d.verdict === 'deliver')).toBe(true);
  });

  it('skips revoked subscriptions', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '10' });
    const subscription = makeSubscription({ status: 'revoked' });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'subscription_revoked' });
  });

  it('skips paused subscriptions', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '10' });
    const subscription = makeSubscription({ status: 'paused' });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'subscription_paused' });
  });

  it('skips subscriptions whose caps.expiresAt is past', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '10' });
    const subscription = makeSubscription({
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'subscription_expired' });
  });

  it('skips when publisher token is not in the follower allowlist', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'BONK', amount: '10' });
    const subscription = makeSubscription(); // allowlist = ['USDC']
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'token_not_allowed' });
  });

  it('skips when publisher recipient is not in the follower recipient allowlist', () => {
    const emission = makeEmission({ connectorAction: 'transfer_spl', token: 'USDC', amount: '10', recipient: 'OutsideRecipient11111111111111111111111111' });
    const subscription = makeSubscription({
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        allowlistedRecipients: ['ApprovedRecipient1111111111111111111111111'],
      },
    });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'recipient_not_allowed' });
  });

  it('skips when publisher template has no amount field', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC' });
    const subscription = makeSubscription();
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'missing_amount' });
  });

  it('skips when follower perRunMaxAmount is zero', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '10' });
    const subscription = makeSubscription({
      caps: { perRunMaxAmount: '0', lifetimeMaxAmount: '0', allowlistedTokens: ['USDC'] },
    });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'skip', reason: 'missing_amount' });
  });

  it('clamps to remaining lifetime exposure', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '750' });
    const subscription = makeSubscription({
      caps: { perRunMaxAmount: '500', lifetimeMaxAmount: '1000', allowlistedTokens: ['USDC'] },
    });
    const plan = planFanout({
      emission,
      subscriptions: [subscription],
      nowIso: NOW,
      subscriptionUsage: new Map([
        [subscription.id, { executionCount: 1, lifetimeAmount: '875' }],
      ]),
    });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'deliver', clampedAmount: '125' });
    expect(plan.decisions[0]?.clampedActionTemplate).toMatchObject({ amount: '125' });
  });

  it('skips when lifetime exposure or max executions are exhausted', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '10' });
    const lifetime = makeSubscription({ id: 'sub_lifetime' });
    const maxExecutions = makeSubscription({
      id: 'sub_max',
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '10000',
        allowlistedTokens: ['USDC'],
        maxExecutions: 2,
      },
    });
    const plan = planFanout({
      emission,
      subscriptions: [lifetime, maxExecutions],
      nowIso: NOW,
      subscriptionUsage: {
        sub_lifetime: { executionCount: 1, lifetimeAmount: '10000' },
        sub_max: { executionCount: 2, lifetimeAmount: '20' },
      },
    });
    expect(plan.decisions.find((d) => d.subscription.id === 'sub_lifetime')).toMatchObject({
      verdict: 'skip',
      reason: 'lifetime_cap_exhausted',
    });
    expect(plan.decisions.find((d) => d.subscription.id === 'sub_max')).toMatchObject({
      verdict: 'skip',
      reason: 'max_executions_reached',
    });
  });

  it('is deterministic — same input produces identical decisions ordered by subscription id', () => {
    const emission = makeEmission({ connectorAction: 'swap', token: 'USDC', amount: '50' });
    const subs = [
      makeSubscription({ id: 'sub_z', followerWallet: 'Z111111111111111111111111111111111111111' }),
      makeSubscription({ id: 'sub_a', followerWallet: 'A111111111111111111111111111111111111111' }),
    ];
    const plan1 = planFanout({ emission, subscriptions: subs, nowIso: NOW });
    const plan2 = planFanout({ emission, subscriptions: [...subs].reverse(), nowIso: NOW });
    expect(plan1).toEqual(plan2);
    expect(plan1.decisions.map((d) => d.subscription.id)).toEqual(['sub_a', 'sub_z']);
  });

  it('handles amountSol-shaped publisher templates', () => {
    const emission = makeEmission({ connectorAction: 'transfer_sol', token: 'SOL', amountSol: '12.5', recipient: 'AAA' });
    const subscription = makeSubscription({
      caps: { perRunMaxAmount: '1.5', lifetimeMaxAmount: '10', allowlistedTokens: ['SOL'] },
    });
    const plan = planFanout({ emission, subscriptions: [subscription], nowIso: NOW });
    expect(plan.decisions[0]).toMatchObject({ verdict: 'deliver', clampedAmount: '1.5' });
    expect(plan.decisions[0]?.clampedActionTemplate).toMatchObject({ amountSol: '1.5' });
  });
});
