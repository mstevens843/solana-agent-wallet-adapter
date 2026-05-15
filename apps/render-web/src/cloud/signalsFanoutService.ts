// Layer 2 / Phase 1 / Agent 2 — turns one publisher emission into N per-follower
// approval requests, each clamped to the follower's subscription caps. Followers
// always sign manually; fanout never auto-signs. See plan:
// /Users/devlegacy/.claude/plans/ok-please-plan-out-purrfect-squirrel.md
import { randomUUID } from 'node:crypto';

import {
  addDecimalStrings,
  extractTemplateRecipient,
  extractTemplateToken,
  planFanout,
  type FanoutDecision,
  type SignalEmissionRecord,
  type SignalFeedRecord,
  type SignalSubscriptionUsage,
  type SignalSubscriptionRecord,
} from '@solana-agent-wallet-adapter/signals-runtime';
import type {
  ApprovalRequestRecord,
  AuditEventRecord,
  CreateApprovalInput,
  JsonObject,
  JsonValue,
  WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';
import { WorkflowValidationError } from '@solana-agent-wallet-adapter/workflow';

import type { Clock, SignalsStore } from './store.js';
import { WorkflowService, WorkflowServiceError, type WorkflowStore } from './workflowService.js';

export interface SignalsFanoutTickInput {
  store: WorkflowStore & SignalsStore;
  clock: Clock;
  workflowService?: WorkflowService;
  batchLimit?: number;
}

export interface SignalsFanoutTickResult {
  emissionsProcessed: number;
  followersFannedOut: number;
  skipped: number;
  errors: number;
}

const DEFAULT_BATCH_LIMIT = 200;

export async function runSignalsFanoutTick(
  input: SignalsFanoutTickInput,
): Promise<SignalsFanoutTickResult> {
  const { store, clock } = input;
  const workflowService = input.workflowService ?? new WorkflowService(store);
  const undelivered = await store.listUndeliveredSignalEmissions(
    input.batchLimit ?? DEFAULT_BATCH_LIMIT,
  );

  let emissionsProcessed = 0;
  let followersFannedOut = 0;
  let skipped = 0;
  let errors = 0;

  for (const emissionRow of undelivered) {
    const emission = emissionRow.emission as SignalEmissionRecord;
    const feedRow = await store.getSignalFeed(emission.feedId);
    if (!feedRow) {
      await appendAudit(store, emission.publisherWallet, clock, 'signal.fanout.feed_missing', {
        signalEmissionId: emission.id,
        signalFeedId: emission.feedId,
      });
      await store.markSignalEmissionFanoutProcessed(emission.id, 0, clock.now().toISOString());
      emissionsProcessed += 1;
      continue;
    }
    const feed = feedRow.feed as SignalFeedRecord;
    if (feed.status !== 'active') {
      await appendAudit(store, feed.publisherWallet, clock, 'signal.fanout.feed_inactive', {
        signalEmissionId: emission.id,
        signalFeedId: emission.feedId,
        feedStatus: feed.status,
      });
      await store.markSignalEmissionFanoutProcessed(emission.id, 0, clock.now().toISOString());
      emissionsProcessed += 1;
      continue;
    }

    const subscriptionRows = await store.listSignalSubscriptionsForFeed(emission.feedId);
    const subscriptions: SignalSubscriptionRecord[] = subscriptionRows.map(
      (row) => row.subscription as SignalSubscriptionRecord,
    );
    const nowIso = clock.now().toISOString();
    const subscriptionUsage = await loadSubscriptionUsage(store, subscriptions, emission.id);
    const plan = planFanout({ emission, subscriptions, nowIso, subscriptionUsage });
    let delivered = 0;
    let transientErrors = 0;

    for (const decision of plan.decisions) {
      if (decision.verdict === 'skip') {
        skipped += 1;
        await appendAudit(
          store,
          decision.subscription.followerWallet,
          clock,
          'signal.fanout.skipped',
          {
            signalEmissionId: emission.id,
            signalSubscriptionId: decision.subscription.id,
            signalFeedId: emission.feedId,
            reason: decision.reason ?? 'unknown',
          },
        );
        continue;
      }

      const existing = await findExistingFanoutApproval(
        store,
        decision.subscription.followerWallet,
        emission.id,
        decision.subscription.id,
      );
      if (existing) {
        delivered += 1;
        continue;
      }

      try {
        const approval = await workflowService.createApproval(
          { walletAddress: decision.subscription.followerWallet },
          buildApprovalInput({ emission, feed, decision, nowIso }),
        );
        await appendAudit(
          store,
          decision.subscription.followerWallet,
          clock,
          'signal.fanout.proposed',
          {
            signalEmissionId: emission.id,
            signalSubscriptionId: decision.subscription.id,
            signalFeedId: emission.feedId,
            approvalRequestId: approval.id,
            clampedAmount: decision.clampedAmount ?? null,
          },
        );
        delivered += 1;
      } catch (err) {
        if (isApprovalExistsError(err)) {
          const racedExisting = await findExistingFanoutApproval(
            store,
            decision.subscription.followerWallet,
            emission.id,
            decision.subscription.id,
          );
          if (racedExisting) {
            delivered += 1;
            continue;
          }
        }
        errors += 1;
        if (!isDeterministicFanoutError(err)) transientErrors += 1;
        await appendAudit(
          store,
          decision.subscription.followerWallet,
          clock,
          'signal.fanout.errored',
          {
            signalEmissionId: emission.id,
            signalSubscriptionId: decision.subscription.id,
            signalFeedId: emission.feedId,
            error: errorMessage(err),
          },
        );
      }
    }

    if (transientErrors === 0) {
      await store.markSignalEmissionFanoutProcessed(emission.id, delivered, clock.now().toISOString());
    } else {
      await appendAudit(store, emission.publisherWallet, clock, 'signal.fanout.deferred', {
        signalEmissionId: emission.id,
        signalFeedId: emission.feedId,
        delivered,
        transientErrors,
      });
    }
    emissionsProcessed += 1;
    followersFannedOut += delivered;
  }

  return { emissionsProcessed, followersFannedOut, skipped, errors };
}

const SIGNAL_CAP_EXCLUDED_APPROVAL_STATUSES = new Set([
  'rejected',
  'denied',
  'blocked',
  'failed',
  'expired',
  'cancelled',
]);

async function loadSubscriptionUsage(
  store: WorkflowStore,
  subscriptions: readonly SignalSubscriptionRecord[],
  currentEmissionId: string,
): Promise<Map<string, SignalSubscriptionUsage>> {
  const usage = new Map<string, SignalSubscriptionUsage>();
  const byFollower = new Map<string, SignalSubscriptionRecord[]>();
  for (const subscription of subscriptions) {
    usage.set(subscription.id, { executionCount: 0, lifetimeAmount: '0' });
    const current = byFollower.get(subscription.followerWallet) ?? [];
    current.push(subscription);
    byFollower.set(subscription.followerWallet, current);
  }

  for (const [followerWallet, followerSubscriptions] of byFollower) {
    const subscriptionIds = new Set(followerSubscriptions.map((subscription) => subscription.id));
    const seenEmissionsBySubscription = new Map<string, Set<string>>();
    const approvals = await store.listApprovals(followerWallet);
    for (const approval of approvals) {
      if (SIGNAL_CAP_EXCLUDED_APPROVAL_STATUSES.has(approval.status)) continue;
      const metadata = approval.metadata;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
      const signalSubscriptionId = metadata.signalSubscriptionId;
      if (typeof signalSubscriptionId !== 'string' || !subscriptionIds.has(signalSubscriptionId)) continue;
      if (metadata.signalEmissionId === currentEmissionId) continue;
      const current = usage.get(signalSubscriptionId) ?? { executionCount: 0, lifetimeAmount: '0' };
      const signalEmissionId = typeof metadata.signalEmissionId === 'string'
        ? metadata.signalEmissionId
        : approval.id;
      const seen = seenEmissionsBySubscription.get(signalSubscriptionId) ?? new Set<string>();
      if (!seen.has(signalEmissionId)) {
        current.executionCount += 1;
        seen.add(signalEmissionId);
        seenEmissionsBySubscription.set(signalSubscriptionId, seen);
      }
      if (approval.amount && isDecimalString(approval.amount)) {
        current.lifetimeAmount = addDecimalStrings(current.lifetimeAmount, approval.amount);
      }
      usage.set(signalSubscriptionId, current);
    }
  }

  return usage;
}

interface BuildApprovalInputArgs {
  emission: SignalEmissionRecord;
  feed: SignalFeedRecord;
  decision: FanoutDecision;
  nowIso: string;
}

function buildApprovalInput(args: BuildApprovalInputArgs): CreateApprovalInput {
  const { emission, feed, decision, nowIso } = args;
  const template = decision.clampedActionTemplate ?? emission.actionTemplate;
  const kind = stringField(template, 'connectorAction') ?? 'manual_review';
  const token = extractTemplateToken(template);
  const recipient = extractTemplateRecipient(template);
  const tokenLabel = token ?? 'tokens';
  const summary = `Signal copy: ${decision.clampedAmount ?? '0'} ${tokenLabel} from feed ${feed.name}`;
  const cluster = clusterFromFeed(feed);
  const metadata: JsonObject = {
    signalEmissionId: emission.id,
    signalSubscriptionId: decision.subscription.id,
    signalFeedId: emission.feedId,
    publisherWallet: emission.publisherWallet,
    sourceTxid: emission.sourceTxid,
    approvalBoundary:
      'Wallet approval is required for every signal-derived action; the agent does not sign or submit transactions.',
  };
  return {
    kind,
    summary,
    params: template,
    ...(decision.clampedAmount ? { amount: decision.clampedAmount } : {}),
    ...(token ? { token } : {}),
    ...(recipient ? { recipient } : {}),
    ...(cluster ? { cluster } : {}),
    dueAt: nowIso,
    metadata,
  };
}

function clusterFromFeed(feed: SignalFeedRecord): WorkflowCluster | undefined {
  const meta = feed.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const value = meta.cluster;
  if (typeof value !== 'string') return undefined;
  if (value === 'mainnet-beta' || value === 'testnet' || value === 'devnet' || value === 'localnet') {
    return value;
  }
  return undefined;
}

async function findExistingFanoutApproval(
  store: WorkflowStore,
  followerWallet: string,
  emissionId: string,
  subscriptionId: string,
): Promise<ApprovalRequestRecord | undefined> {
  const approvals = await store.listApprovals(followerWallet);
  return approvals.find((approval) => matchesFanoutMetadata(approval, emissionId, subscriptionId));
}

function matchesFanoutMetadata(
  approval: ApprovalRequestRecord,
  emissionId: string,
  subscriptionId: string,
): boolean {
  const md = approval.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  const record = md as Record<string, JsonValue>;
  return record.signalEmissionId === emissionId && record.signalSubscriptionId === subscriptionId;
}

function isApprovalExistsError(err: unknown): boolean {
  return err instanceof WorkflowServiceError && err.code === 'approval_exists';
}

function isDeterministicFanoutError(err: unknown): boolean {
  if (err instanceof WorkflowValidationError) return true;
  if (err instanceof WorkflowServiceError) return err.status < 500;
  return false;
}

function isDecimalString(value: string): boolean {
  return /^[0-9]+(\.[0-9]+)?$/.test(value);
}

async function appendAudit(
  store: WorkflowStore,
  walletAddress: string,
  clock: Clock,
  type: string,
  metadata: JsonObject,
): Promise<void> {
  const record: AuditEventRecord = {
    id: `audit_${randomUUID()}`,
    walletAddress,
    type,
    actor: 'server',
    eventType: type,
    createdAt: clock.now().toISOString(),
    metadata,
  };
  await store.appendAuditEvent(walletAddress, record);
}

function stringField(template: JsonObject | undefined, key: string): string | undefined {
  if (!template) return undefined;
  const value = template[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown_error';
}
