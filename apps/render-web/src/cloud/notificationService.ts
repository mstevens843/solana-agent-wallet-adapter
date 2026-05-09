import { createHmac, randomUUID } from 'node:crypto';

import type { JsonObject, RecurringOccurrenceRecord, RecurringScheduleRecord } from '@solana-agent-wallet-adapter/workflow';

import type { RecurringStore } from './recurringService.js';
import { redactSecrets } from './redaction.js';
import { assertWebhookDestinationAllowed } from './webhookSecurity.js';

export type RecurringNotificationDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'abandoned';

export interface RecurringNotificationDeliveryRecord {
  id: string;
  walletAddress: string;
  type: 'recurring.occurrence.ready';
  scheduleId: string;
  occurrenceId: string;
  payload: JsonObject;
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
  listNotificationDeliveries?(
    walletAddress: string,
    scheduleId: string,
    limit: number,
  ): Promise<RecurringNotificationDeliveryRecord[]>;
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
const DELIVERY_TIMEOUT_MS = 10_000;
const OCCURRENCE_READY_TYPE = 'recurring.occurrence.ready' as const;

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
    const existing = await this.store.findNotificationDelivery(walletAddress, occurrenceId, OCCURRENCE_READY_TYPE);
    if (existing) return existing;

    const schedule = await this.store.getSchedule(walletAddress, scheduleId);
    const occurrence = await this.store.getOccurrence(walletAddress, occurrenceId);
    if (!schedule || !occurrence) return undefined;
    const webhookUrl = schedule.notifications?.webhookUrl;
    const webhookSecret = schedule.notifications?.webhookSecret;
    if (!webhookUrl || !webhookSecret) return undefined;

    const now = this.now();
    const record: RecurringNotificationDeliveryRecord = {
      id: deliveryId(occurrenceId, OCCURRENCE_READY_TYPE),
      walletAddress,
      type: OCCURRENCE_READY_TYPE,
      scheduleId,
      occurrenceId,
      payload: occurrenceReadyPayload(schedule, occurrence),
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
    const safeRecord = scrubNotificationDeliveryForResponse(record);
    if (safeRecord.status === 'delivered' || safeRecord.status === 'abandoned') return safeRecord.status;
    const schedule = await this.store.getSchedule(safeRecord.walletAddress, safeRecord.scheduleId);
    const webhookUrl = schedule?.notifications?.webhookUrl;
    const webhookSecret = schedule?.notifications?.webhookSecret;
    if (!webhookUrl || !webhookSecret) {
      return this.recordFailure(safeRecord, 'Webhook notifications are disabled for this recurring schedule.');
    }
    if (safeRecord.attempts >= BACKOFF_MS.length) {
      const abandoned = {
        ...safeRecord,
        status: 'abandoned',
        updatedAt: this.now(),
        lastError: safeRecord.lastError ?? 'Delivery attempts exhausted.',
      } satisfies RecurringNotificationDeliveryRecord;
      await this.store.saveNotificationDelivery(abandoned);
      await this.auditAbandoned(abandoned);
      return 'abandoned';
    }

    const body = JSON.stringify(safeRecord.payload);
    const timestamp = this.now();
    try {
      if (this.fetchFn === fetch) {
        await assertWebhookDestinationAllowed(webhookUrl);
      }
      const response = await this.fetchFn(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-agentic-delivery-id': safeRecord.id,
          'x-agentic-signature': `sha256=${hmacSha256(webhookSecret, `${timestamp}.${body}`)}`,
          'x-agentic-timestamp': timestamp,
        },
        body,
        signal: timeoutSignal(DELIVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        const now = this.now();
        const { lastError: _lastError, ...recordWithoutLastError } = safeRecord;
        await this.store.saveNotificationDelivery({
          ...recordWithoutLastError,
          status: 'delivered',
          attempts: safeRecord.attempts + 1,
          deliveredAt: now,
          updatedAt: now,
        });
        return 'delivered';
      }
      return this.recordFailure(safeRecord, `Webhook returned HTTP ${response.status}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook delivery failed.';
      return this.recordFailure(safeRecord, message);
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
    const updated: RecurringNotificationDeliveryRecord = {
      ...scrubNotificationDeliveryForResponse(record),
      status: abandoned ? 'abandoned' : 'failed',
      attempts,
      nextAttemptAt: typeof nextAttemptAt === 'string' ? nextAttemptAt : nextAttemptAt.toISOString(),
      updatedAt: now.toISOString(),
      lastError: redactSecrets(error),
    };
    await this.store.saveNotificationDelivery(updated);
    if (abandoned) await this.auditAbandoned(updated);
    return abandoned ? 'abandoned' : 'failed';
  }

  private async auditAbandoned(record: RecurringNotificationDeliveryRecord): Promise<void> {
    await this.store.appendAuditEvent(record.walletAddress, {
      id: `audit_${this.idFactory()}`,
      walletAddress: record.walletAddress,
      type: 'recurring.notification.abandoned',
      scheduleId: record.scheduleId,
      occurrenceId: record.occurrenceId,
      createdAt: this.now(),
      metadata: {
        deliveryId: record.id,
        attempts: record.attempts,
        ...(record.lastError ? { lastError: record.lastError } : {}),
      },
    });
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

export function scrubNotificationDeliveryForResponse(
  record: RecurringNotificationDeliveryRecord,
): RecurringNotificationDeliveryRecord {
  const {
    webhookSecret: _webhookSecret,
    webhookUrl: _webhookUrl,
    ...safe
  } = record as RecurringNotificationDeliveryRecord & {
    webhookSecret?: string;
    webhookUrl?: string;
  };
  return { ...safe };
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

function deliveryId(
  occurrenceId: string,
  type: RecurringNotificationDeliveryRecord['type'],
): string {
  const safeOccurrenceId = occurrenceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeType = type.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `delivery_${safeType}_${safeOccurrenceId}`;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  const maybeTimeout = AbortSignal as typeof AbortSignal & {
    timeout?: (milliseconds: number) => AbortSignal;
  };
  if (typeof maybeTimeout.timeout === 'function') return maybeTimeout.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
