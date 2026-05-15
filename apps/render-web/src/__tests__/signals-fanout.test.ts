import type {
  SignalEmissionRecord,
  SignalFeedRecord,
  SignalSubscriptionRecord,
} from '@solana-agent-wallet-adapter/signals-runtime';
import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';
import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { runSignalsFanoutTick } from '../cloud/signalsFanoutService.js';
import type {
  SignalEmissionStoreRecord,
  SignalFeedStoreRecord,
  SignalSubscriptionStoreRecord,
} from '../cloud/store.js';

const PUBLISHER = 'PubWallet1111111111111111111111111111111';
const FOLLOWER_A = 'FollowerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FOLLOWER_B = 'FollowerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const FEED_ID = 'feed_friday_swap';
const EMISSION_ID = 'emission_abc';

class FixedClock {
  constructor(private value: Date) {}
  now(): Date {
    return this.value;
  }
  set(value: Date): void {
    this.value = value;
  }
}

const FIXED_NOW = new Date('2026-05-14T12:00:00.000Z');

function makeFeed(overrides: Partial<SignalFeedRecord> = {}): SignalFeedRecord {
  return {
    id: FEED_ID,
    publisherWallet: PUBLISHER,
    name: 'Friday Swap',
    description: 'Publisher executes Friday afternoon DCA swaps.',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function feedRow(feed: SignalFeedRecord): SignalFeedStoreRecord {
  return {
    id: feed.id,
    publisherWallet: feed.publisherWallet,
    status: feed.status,
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
    feed,
  };
}

function makeSubscription(
  overrides: Partial<SignalSubscriptionRecord> & { id: string; followerWallet: string },
): SignalSubscriptionRecord {
  return {
    feedId: FEED_ID,
    caps: {
      perRunMaxAmount: '200',
      lifetimeMaxAmount: '10000',
      allowlistedTokens: ['USDC'],
    },
    subscribedAt: '2026-05-05T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function subscriptionRow(sub: SignalSubscriptionRecord): SignalSubscriptionStoreRecord {
  return {
    id: sub.id,
    followerWallet: sub.followerWallet,
    feedId: sub.feedId,
    status: sub.status,
    subscribedAt: sub.subscribedAt,
    updatedAt: sub.updatedAt,
    subscription: sub,
  };
}

function makeEmission(
  template: JsonObject,
  overrides: Partial<SignalEmissionRecord> = {},
): SignalEmissionRecord {
  return {
    id: EMISSION_ID,
    feedId: FEED_ID,
    publisherWallet: PUBLISHER,
    emittedAt: '2026-05-14T11:55:00.000Z',
    sourceTxid: 'pub_tx_signature_xyz',
    actionTemplate: template,
    delivered: 0,
    ...overrides,
  };
}

function emissionRow(emission: SignalEmissionRecord): SignalEmissionStoreRecord {
  return {
    id: emission.id,
    feedId: emission.feedId,
    publisherWallet: emission.publisherWallet,
    emittedAt: emission.emittedAt,
    delivered: emission.delivered,
    emission,
  };
}

describe('runSignalsFanoutTick', () => {
  let store: MemoryWorkflowStore;
  let clock: FixedClock;

  beforeEach(() => {
    store = new MemoryWorkflowStore();
    clock = new FixedClock(FIXED_NOW);
  });

  it('fans an emission out to all active subscribers and clamps to per-run caps', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalSubscription(
      subscriptionRow(
        makeSubscription({
          id: 'sub_a',
          followerWallet: FOLLOWER_A,
          caps: { perRunMaxAmount: '200', lifetimeMaxAmount: '10000', allowlistedTokens: ['USDC'] },
        }),
      ),
    );
    await store.saveSignalSubscription(
      subscriptionRow(
        makeSubscription({
          id: 'sub_b',
          followerWallet: FOLLOWER_B,
          caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '10000', allowlistedTokens: ['USDC'] },
        }),
      ),
    );
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '10000',
          slippageBps: '50',
        }),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });

    expect(result.emissionsProcessed).toBe(1);
    expect(result.followersFannedOut).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const approvalsA = await store.listApprovals(FOLLOWER_A);
    const approvalsB = await store.listApprovals(FOLLOWER_B);
    expect(approvalsA).toHaveLength(1);
    expect(approvalsB).toHaveLength(1);
    expect(approvalsA[0]?.kind).toBe('swap');
    expect(approvalsA[0]?.amount).toBe('200');
    expect(approvalsB[0]?.amount).toBe('50');
    expect(approvalsA[0]?.params).toMatchObject({
      amount: '200',
      inputToken: 'USDC',
      outputToken: 'SOL',
      connectorAction: 'swap',
    });
    expect(approvalsA[0]?.metadata).toMatchObject({
      signalEmissionId: EMISSION_ID,
      signalSubscriptionId: 'sub_a',
      signalFeedId: FEED_ID,
      publisherWallet: PUBLISHER,
      sourceTxid: 'pub_tx_signature_xyz',
    });
    expect(approvalsA[0]?.status).toBe('ready');

    const emissions = await store.listUndeliveredSignalEmissions();
    expect(emissions).toHaveLength(0);

    const auditsA = await store.forWallet(FOLLOWER_A).listAuditEvents();
    expect(auditsA.map((entry) => entry.type)).toContain('signal.fanout.proposed');
  });

  it('marks a zero-subscriber emission processed without counting fake deliveries', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '100',
        }),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });

    expect(result.emissionsProcessed).toBe(1);
    expect(result.followersFannedOut).toBe(0);
    expect(result.skipped).toBe(0);
    expect(await store.listUndeliveredSignalEmissions()).toEqual([]);
  });

  it('enforces lifetime caps from existing signal-derived approvals', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalSubscription(
      subscriptionRow(
        makeSubscription({
          id: 'sub_a',
          followerWallet: FOLLOWER_A,
          caps: { perRunMaxAmount: '500', lifetimeMaxAmount: '250', allowlistedTokens: ['USDC'] },
        }),
      ),
    );
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '200',
          slippageBps: '50',
        }),
      ),
    );
    await runSignalsFanoutTick({ store, clock });

    await store.saveSignalEmission(
      emissionRow(
        makeEmission(
          {
            connectorAction: 'swap',
            inputToken: 'USDC',
            outputToken: 'SOL',
            amount: '200',
            slippageBps: '50',
          },
          { id: 'emission_second', sourceTxid: 'pub_tx_signature_2' },
        ),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });
    expect(result.errors).toBe(0);
    expect(result.followersFannedOut).toBe(1);
    const approvals = await store.listApprovals(FOLLOWER_A);
    expect(approvals.map((approval) => approval.amount)).toEqual(['200', '50']);
  });

  it('is idempotent: re-running with delivered=0 does not double-fan', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalSubscription(
      subscriptionRow(makeSubscription({ id: 'sub_a', followerWallet: FOLLOWER_A })),
    );
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '1000',
          slippageBps: '50',
        }),
      ),
    );

    const first = await runSignalsFanoutTick({ store, clock });
    expect(first.followersFannedOut).toBe(1);

    // Second tick: emission is already delivered → no work.
    const second = await runSignalsFanoutTick({ store, clock });
    expect(second.emissionsProcessed).toBe(0);
    expect(second.followersFannedOut).toBe(0);

    // Simulate a mid-tick crash: reset delivered=0 and re-run. The per-follower
    // metadata lookup should prevent a duplicate approval.
    await store.saveSignalEmission({
      ...emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '1000',
          slippageBps: '50',
        }),
      ),
      delivered: 0,
    });
    const third = await runSignalsFanoutTick({ store, clock });
    expect(third.emissionsProcessed).toBe(1);
    expect(third.followersFannedOut).toBe(1); // counts the already-existing approval
    const approvalsA = await store.listApprovals(FOLLOWER_A);
    expect(approvalsA).toHaveLength(1); // no duplicate
  });

  it('skips emissions for paused feeds but still marks them delivered', async () => {
    await store.saveSignalFeed(feedRow(makeFeed({ status: 'paused' })));
    await store.saveSignalSubscription(
      subscriptionRow(makeSubscription({ id: 'sub_a', followerWallet: FOLLOWER_A })),
    );
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '100',
          slippageBps: '50',
        }),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });
    expect(result.emissionsProcessed).toBe(1);
    expect(result.followersFannedOut).toBe(0);
    expect(await store.listApprovals(FOLLOWER_A)).toEqual([]);

    const publisherAudits = await store.forWallet(PUBLISHER).listAuditEvents();
    expect(publisherAudits.map((e) => e.type)).toContain('signal.fanout.feed_inactive');

    // Re-running must not loop back to this emission.
    const second = await runSignalsFanoutTick({ store, clock });
    expect(second.emissionsProcessed).toBe(0);
  });

  it('records subscription-level skip reasons (revoked / token mismatch)', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalSubscription(
      subscriptionRow(makeSubscription({ id: 'sub_a', followerWallet: FOLLOWER_A, status: 'revoked' })),
    );
    await store.saveSignalSubscription(
      subscriptionRow(
        makeSubscription({
          id: 'sub_b',
          followerWallet: FOLLOWER_B,
          caps: { perRunMaxAmount: '100', lifetimeMaxAmount: '10000', allowlistedTokens: ['SOL'] },
        }),
      ),
    );
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '100',
          slippageBps: '50',
        }),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });
    expect(result.followersFannedOut).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.emissionsProcessed).toBe(1);

    const auditsA = await store.forWallet(FOLLOWER_A).listAuditEvents();
    expect(
      auditsA.find((e) => e.type === 'signal.fanout.skipped')?.metadata?.reason,
    ).toBe('subscription_revoked');

    const auditsB = await store.forWallet(FOLLOWER_B).listAuditEvents();
    expect(
      auditsB.find((e) => e.type === 'signal.fanout.skipped')?.metadata?.reason,
    ).toBe('token_not_allowed');
  });

  it('isolates per-subscriber failures so one bad emission cannot poison the batch', async () => {
    await store.saveSignalFeed(feedRow(makeFeed()));
    await store.saveSignalSubscription(
      subscriptionRow(makeSubscription({ id: 'sub_a', followerWallet: FOLLOWER_A })),
    );
    await store.saveSignalSubscription(
      subscriptionRow(makeSubscription({ id: 'sub_b', followerWallet: FOLLOWER_B })),
    );
    // Publisher template contains a forbidden authority field; createApproval
    // should reject this via guardrails for every follower in the loop.
    await store.saveSignalEmission(
      emissionRow(
        makeEmission({
          connectorAction: 'swap',
          inputToken: 'USDC',
          outputToken: 'SOL',
          amount: '100',
          slippageBps: '50',
          approvalAuthority: 'unlimited',
        }),
      ),
    );

    const result = await runSignalsFanoutTick({ store, clock });
    expect(result.emissionsProcessed).toBe(1);
    expect(result.errors).toBeGreaterThan(0);
    expect(result.followersFannedOut).toBe(0);

    const erroredAudits = (await store.forWallet(FOLLOWER_A).listAuditEvents()).filter(
      (e) => e.type === 'signal.fanout.errored',
    );
    expect(erroredAudits.length).toBeGreaterThan(0);
  });
});
