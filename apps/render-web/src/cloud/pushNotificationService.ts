import { randomUUID } from 'node:crypto';

import type { JsonObject } from '@solana-agent-wallet-adapter/workflow';

import { createPushSender, type PushSender } from './pushSender.js';
import { redactSecrets } from './redaction.js';
import type { PushDeliveryRecord, PushEventType, PushStore } from './pushTypes.js';

/**
 * The push outbox: enqueue an event once, fan it out to every live device for the wallet, retry with
 * backoff, reap dead tokens, give up eventually.
 *
 * Deliberately a SIBLING of RecurringNotificationService rather than a widening of it. That service's
 * record requires scheduleId/occurrenceId and its table (migration 006) pins them as NOT NULL FKs into
 * recurring_schedules/recurring_occurrences — so it structurally cannot carry "limit order filled" or
 * "transaction confirmed". Widening it would mean an ALTER on a live table plus a transport rewrite of
 * a working, tested webhook path. Instead the recurring sink now feeds BOTH: the webhook (unchanged)
 * and this.
 */
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

export interface PushEnqueueInput {
  walletAddress: string;
  type: PushEventType;
  dedupeKey: string;
  title: string;
  body: string;
  data?: JsonObject;
}

export interface PushNotificationServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  sender?: PushSender;
}

export interface PushDeliverTotals {
  delivered: number;
  failed: number;
  abandoned: number;
  skipped: number;
}

export class PushNotificationService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly sender: PushSender;

  constructor(
    private readonly store: PushStore,
    options: PushNotificationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.sender = options.sender ?? createPushSender({ clock: this.clock });
  }

  /**
   * Idempotent by (wallet, type, dedupeKey). Returns the existing row untouched on a repeat, so a
   * Helius re-delivery or a health poll re-reading the same state can't buzz the phone twice.
   * No live device for the wallet ⇒ nothing is enqueued (no point accruing an outbox for a phone
   * that isn't there).
   */
  async enqueue(input: PushEnqueueInput): Promise<PushDeliveryRecord | undefined> {
    const existing = await this.store.findPushDelivery(input.walletAddress, input.type, input.dedupeKey);
    if (existing) return existing;

    const devices = await this.liveDevicesFor(input.walletAddress, input.type);
    if (!devices.length) return undefined;

    const now = this.now();
    const record: PushDeliveryRecord = {
      id: `push_${this.idFactory()}`,
      walletAddress: input.walletAddress,
      type: input.type,
      dedupeKey: input.dedupeKey,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.savePushDelivery(record);
    return record;
  }

  async deliverDue(limit = 50): Promise<PushDeliverTotals> {
    const due = await this.store.listDuePushDeliveries(this.now(), limit);
    const totals: PushDeliverTotals = { delivered: 0, failed: 0, abandoned: 0, skipped: 0 };
    for (const record of due) {
      const outcome = await this.deliver(record);
      totals[outcome] += 1;
    }
    return totals;
  }

  private async deliver(record: PushDeliveryRecord): Promise<keyof PushDeliverTotals> {
    if (record.status === 'delivered' || record.status === 'abandoned') return 'skipped';
    if (record.attempts >= BACKOFF_MS.length) return this.abandon(record, record.lastError ?? 'Delivery attempts exhausted.');

    const devices = await this.liveDevicesFor(record.walletAddress, record.type);
    if (!devices.length) {
      // Every device either went away or opted out of this category between enqueue and drain.
      // Nothing to retry towards, so retire it rather than spending the backoff ladder on nobody.
      return this.abandon(record, 'No live device for this wallet accepts this category.');
    }

    let sent = 0;
    let retryable: string | undefined;
    let unconfigured = false;
    for (const device of devices) {
      const result = await this.sender.send(device, record);
      if (result.outcome === 'sent') {
        sent += 1;
        continue;
      }
      if (result.outcome === 'invalid-token') {
        // The install is gone. Reap the row so it stops being fanned out to; this is NOT a delivery
        // failure for the event as a whole (the wallet's other phone may still have received it).
        await this.store.disablePushDevice(device.id, result.detail ?? 'Token rejected by the push service.', this.now());
        continue;
      }
      if (result.outcome === 'unconfigured') {
        // `continue` matters: falling through would set `retryable` and turn a missing credential into
        // a real failure, burning the whole backoff ladder (~31h to abandoned) while an operator is
        // still provisioning the APNs/FCM key. The event must survive that wait, not die during it.
        unconfigured = true;
        continue;
      }
      retryable = result.detail ?? 'Push delivery failed.';
    }

    if (sent > 0) {
      const now = this.now();
      const { lastError: _dropped, ...rest } = record;
      await this.store.savePushDelivery({
        ...rest,
        status: 'delivered',
        attempts: record.attempts + 1,
        deliveredAt: now,
        updatedAt: now,
      });
      return 'delivered';
    }
    if (unconfigured && !retryable) {
      // No credentials provisioned yet. Leave it pending and DON'T spend an attempt — the whole
      // stack is inert until an operator adds keys, and a queued event should survive that wait.
      return 'skipped';
    }
    if (!retryable) {
      // Every device was reaped as dead this pass.
      return this.abandon(record, 'All devices for this wallet were rejected by the push service.');
    }
    return this.recordFailure(record, retryable);
  }

  private async recordFailure(record: PushDeliveryRecord, error: string): Promise<'failed' | 'abandoned'> {
    const attempts = record.attempts + 1;
    const now = this.clock();
    if (attempts >= BACKOFF_MS.length) return this.abandon({ ...record, attempts }, error);
    await this.store.savePushDelivery({
      ...record,
      status: 'failed',
      attempts,
      nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.max(0, attempts - 1)]!).toISOString(),
      updatedAt: now.toISOString(),
      lastError: redactSecrets(error),
    });
    return 'failed';
  }

  private async abandon(record: PushDeliveryRecord, error: string): Promise<'abandoned'> {
    const now = this.now();
    await this.store.savePushDelivery({
      ...record,
      status: 'abandoned',
      nextAttemptAt: now,
      updatedAt: now,
      lastError: redactSecrets(error),
    });
    return 'abandoned';
  }

  /** Live devices for a wallet that have opted INTO this category (absent key ⇒ off). */
  private async liveDevicesFor(walletAddress: string, type: PushEventType) {
    const devices = await this.store.listPushDevices(walletAddress);
    return devices.filter((device) => !device.disabledAt && device.categories[type] === true);
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
