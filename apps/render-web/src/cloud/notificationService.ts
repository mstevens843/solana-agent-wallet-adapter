import { createHmac, randomUUID } from 'node:crypto';

import type { JsonObject, RecurringOccurrenceRecord, RecurringScheduleRecord } from '@solana-agent-wallet-adapter/workflow';

import type { RecurringStore } from './recurringService.js';
import { redactSecrets } from './redaction.js';

export type RecurringNotificationDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface RecurringNotificationDeliveryRecord {
  id: string;
  walletAddress: string;
  type: 'recurring.occurrence.ready';
  scheduleId: string;
  occurrenceId: string;
  payload: JsonObject;
  webhookUrl: string;
  webhookSecret: string;
  status: RecurringNotificationDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringNotificationStore {
  saveNotificationDelivery(record: RecurringNotificationDeliveryRecord): Promise<void>;
  findNotificationDelivery(
    walletAddress: string,
    occurrenceId: string,
    type: RecurringNotificationDeliveryRecord['type'],
  ): Promise<RecurringNotificationDeliveryRecord | undefined>;
  listDueNotificationDeliveries(nowIso: string, limit: number): Promise<RecurringNotificationDeliveryRecord[]>;
}

export interface RecurringNotificationServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  fetchFn?: typeof fetch;
}

type Store = RecurringStore & RecurringNotificationStore;

const BACKOFF_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

export class RecurringNotificationService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly store: Store,
    options: RecurringNotificationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async enqueueOccurrenceReady(
    walletAddress: string,
    scheduleId: string,
    occurrenceId: string,
  ): Promise<RecurringNotificationDeliveryRecord | undefined> {
    const existing = await this.store.findNotificationDelivery(walletAddress, occurrenceId, 'recurring.occurrence.ready');
    if (existing) return existing;

    const schedule = await this.store.getSchedule(walletAddress, scheduleId);
    const occurrence = await this.store.getOccurrence(walletAddress, occurrenceId);
    if (!schedule || !occurrence) return undefined;
    const webhookUrl = schedule.notifications?.webhookUrl;
    const webhookSecret = schedule.notifications?.webhookSecret;
    if (!webhookUrl || !webhookSecret) return undefined;

    const now = this.now();
    const record: RecurringNotificationDeliveryRecord = {
      id: `delivery_${this.idFactory()}`,
      walletAddress,
      type: 'recurring.occurrence.ready',
      scheduleId,
      occurrenceId,
      payload: occurrenceReadyPayload(schedule, occurrence),
      webhookUrl,
      webhookSecret,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveNotificationDelivery(record);
    return record;
  }

  async deliverDue(limit = 25): Promise<{ delivered: number; failed: number; abandoned: number }> {
    const due = await this.store.listDueNotificationDeliveries(this.now(), limit);
    const totals = { delivered: 0, failed: 0, abandoned: 0 };
    for (const record of due) {
      const result = await this.deliver(record);
      totals[result] += 1;
    }
    return totals;
  }

  private async deliver(
    record: RecurringNotificationDeliveryRecord,
  ): Promise<'delivered' | 'failed' | 'abandoned'> {
    if (record.status === 'delivered' || record.status === 'abandoned') return record.status;
    if (record.attempts >= BACKOFF_MS.length) {
      await this.store.saveNotificationDelivery({
        ...record,
        status: 'abandoned',
        updatedAt: this.now(),
        lastError: record.lastError ?? 'Delivery attempts exhausted.',
      });
      return 'abandoned';
    }

    const body = JSON.stringify(record.payload);
    try {
      const response = await this.fetchFn(record.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agentic-delivery-id': record.id,
          'x-agentic-signature': `sha256=${hmacSha256(record.webhookSecret, body)}`,
        },
        body,
      });
      if (response.ok) {
        const now = this.now();
        await this.store.saveNotificationDelivery({
          ...record,
          status: 'delivered',
          attempts: record.attempts + 1,
          deliveredAt: now,
          updatedAt: now,
          lastError: undefined,
        });
        return 'delivered';
      }
      return this.recordFailure(record, `Webhook returned HTTP ${response.status}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook delivery failed.';
      return this.recordFailure(record, message);
    }
  }

  private async recordFailure(
    record: RecurringNotificationDeliveryRecord,
    error: string,
  ): Promise<'failed' | 'abandoned'> {
    const attempts = record.attempts + 1;
    const now = this.clock();
    const abandoned = attempts >= BACKOFF_MS.length;
    const nextAttemptAt = abandoned
      ? now
      : new Date(now.getTime() + BACKOFF_MS[Math.max(0, attempts - 1)]!).toISOString();
    await this.store.saveNotificationDelivery({
      ...record,
      status: abandoned ? 'abandoned' : 'failed',
      attempts,
      nextAttemptAt: typeof nextAttemptAt === 'string' ? nextAttemptAt : nextAttemptAt.toISOString(),
      updatedAt: now.toISOString(),
      lastError: redactSecrets(error),
    });
    return abandoned ? 'abandoned' : 'failed';
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

export function isRecurringNotificationStore(value: unknown): value is RecurringNotificationStore {
  const candidate = value as Partial<RecurringNotificationStore> | undefined;
  return Boolean(
    candidate &&
    typeof candidate.saveNotificationDelivery === 'function' &&
    typeof candidate.findNotificationDelivery === 'function' &&
    typeof candidate.listDueNotificationDeliveries === 'function',
  );
}

function occurrenceReadyPayload(
  schedule: RecurringScheduleRecord,
  occurrence: RecurringOccurrenceRecord,
): JsonObject {
  return {
    type: 'recurring.occurrence.ready',
    scheduleId: schedule.id,
    occurrenceId: occurrence.id,
    dueAt: occurrence.dueAt,
    summary: `${schedule.amount} ${schedule.token} recurring approval`,
    walletAddress: schedule.walletAddress,
    cluster: schedule.cluster,
    amount: schedule.amount,
    token: schedule.token,
    recipient: schedule.recipient,
  };
}

function hmacSha256(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
