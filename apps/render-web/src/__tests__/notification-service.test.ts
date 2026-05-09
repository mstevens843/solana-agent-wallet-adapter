import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  RecurringNotificationService,
  type RecurringNotificationDeliveryRecord,
} from '../cloud/notificationService.js';
import {
  MemoryRecurringStore,
  type RecurringOccurrenceRecord,
  type RecurringScheduleRecord,
} from '../cloud/recurringService.js';

describe('RecurringNotificationService', () => {
  it('enqueues and delivers signed recurring occurrence webhooks', async () => {
    const store = new TestNotificationStore();
    const schedule = recurringSchedule();
    const occurrence = recurringOccurrence(schedule.id);
    await store.saveSchedule(schedule.walletAddress, schedule);
    await store.saveOccurrence(schedule.walletAddress, occurrence);

    let body = '';
    let signature = '';
    let timestamp = '';
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body ?? '');
      const headers = new Headers(init?.headers);
      signature = headers.get('x-agentic-signature') ?? '';
      timestamp = headers.get('x-agentic-timestamp') ?? '';
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const service = new RecurringNotificationService(store, {
      clock: () => new Date('2026-05-09T12:00:00.000Z'),
      idFactory: () => 'test',
      fetchFn,
    });

    await service.enqueueOccurrenceReady(schedule.walletAddress, schedule.id, occurrence.id);
    const result = await service.deliverDue();

    expect(result).toEqual({ delivered: 1, failed: 0, abandoned: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(timestamp).toBe('2026-05-09T12:00:00.000Z');
    expect(signature).toBe(`sha256=${createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex')}`);
    expect(store.deliveries[0]?.status).toBe('delivered');
    expect(store.deliveries[0]).not.toHaveProperty('webhookSecret');
  });

  it('does not enqueue duplicate occurrence-ready deliveries', async () => {
    const store = new TestNotificationStore();
    const schedule = recurringSchedule();
    const occurrence = recurringOccurrence(schedule.id);
    await store.saveSchedule(schedule.walletAddress, schedule);
    await store.saveOccurrence(schedule.walletAddress, occurrence);
    const service = new RecurringNotificationService(store, { idFactory: () => 'test' });

    await service.enqueueOccurrenceReady(schedule.walletAddress, schedule.id, occurrence.id);
    await service.enqueueOccurrenceReady(schedule.walletAddress, schedule.id, occurrence.id);

    expect(store.deliveries).toHaveLength(1);
  });
});

class TestNotificationStore extends MemoryRecurringStore {
  readonly deliveries: RecurringNotificationDeliveryRecord[] = [];

  async saveNotificationDelivery(record: RecurringNotificationDeliveryRecord): Promise<void> {
    const index = this.deliveries.findIndex((entry) => (
      entry.id === record.id ||
      (entry.occurrenceId === record.occurrenceId && entry.type === record.type)
    ));
    if (index >= 0) this.deliveries[index] = structuredClone(record);
    else this.deliveries.push(structuredClone(record));
  }

  async findNotificationDelivery(
    walletAddress: string,
    occurrenceId: string,
    type: RecurringNotificationDeliveryRecord['type'],
  ): Promise<RecurringNotificationDeliveryRecord | undefined> {
    return this.deliveries.find((entry) => (
      entry.walletAddress === walletAddress &&
      entry.occurrenceId === occurrenceId &&
      entry.type === type
    ));
  }

  async listDueNotificationDeliveries(nowIso: string, limit: number): Promise<RecurringNotificationDeliveryRecord[]> {
    const now = Date.parse(nowIso);
    return this.deliveries
      .filter((entry) => entry.status === 'pending' || entry.status === 'failed')
      .filter((entry) => Date.parse(entry.nextAttemptAt) <= now)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }

  async listNotificationDeliveries(
    walletAddress: string,
    scheduleId: string,
    limit: number,
  ): Promise<RecurringNotificationDeliveryRecord[]> {
    return this.deliveries
      .filter((entry) => entry.walletAddress === walletAddress && entry.scheduleId === scheduleId)
      .slice(0, limit)
      .map((entry) => structuredClone(entry));
  }
}

function recurringSchedule(): RecurringScheduleRecord {
  return {
    id: 'recurring_test',
    status: 'active',
    walletAddress: 'wallet_test',
    cluster: 'devnet',
    token: 'SOL',
    recipient: 'recipient_test',
    amount: '0.25',
    cadence: 'weekly',
    dayOfWeek: 6,
    localTime: '09:00',
    createdAt: '2026-05-09T12:00:00.000Z',
    updatedAt: '2026-05-09T12:00:00.000Z',
    occurrencesCreated: 0,
    notifications: {
      webhookUrl: 'https://example.test/webhook',
      webhookSecret: 'secret',
    },
  };
}

function recurringOccurrence(scheduleId: string): RecurringOccurrenceRecord {
  return {
    id: 'occurrence_test',
    recurringScheduleId: scheduleId,
    walletAddress: 'wallet_test',
    cluster: 'devnet',
    status: 'approval_pending',
    occurrenceKey: '2026-05-09',
    dueAt: '2026-05-09T12:00:00.000Z',
    createdAt: '2026-05-09T12:00:00.000Z',
    updatedAt: '2026-05-09T12:00:00.000Z',
    approvalRequestId: 'approval_test',
  };
}
