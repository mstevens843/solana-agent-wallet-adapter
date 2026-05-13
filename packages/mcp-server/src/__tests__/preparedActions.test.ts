import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { JsonPreparedActionStore } from '../preparedActions.js';

describe('JsonPreparedActionStore', () => {
  it('persists prepared actions across store instances', async () => {
    const path = await tempStorePath();
    const first = new JsonPreparedActionStore(path);

    const action = await first.addAction({
      kind: 'transfer_sol',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      summary: 'Transfer 0.01 SOL',
      params: { recipient: '11111111111111111111111111111111', amountSol: '0.01' },
      dueAt: '2030-01-01T00:00:00.000Z',
      note: 'Pay contractor invoice #42',
    });

    const second = new JsonPreparedActionStore(path);
    await expect(second.getAction(action.id)).resolves.toMatchObject({
      id: action.id,
      status: 'scheduled',
      summary: 'Transfer 0.01 SOL',
      note: 'Pay contractor invoice #42',
    });
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain(action.id);
  });

  it('normalizes old SOL recurring inbox records that stored amount instead of amountSol', async () => {
    const path = await tempStorePath();
    await writeFile(
      path,
      JSON.stringify({
        actions: [
          {
            id: 'pa_old_sol',
            kind: 'transfer_sol',
            status: 'failed',
            walletAddress: '11111111111111111111111111111111',
            cluster: 'devnet',
            summary: 'Recurring 0.01 SOL payment',
            params: {
              token: 'SOL',
              recipient: '22222222222222222222222222222222',
              amount: '0.01',
            },
            dueAt: '2026-05-01T16:00:00.000Z',
            createdAt: '2026-05-01T16:00:00.000Z',
            updatedAt: '2026-05-01T16:00:00.000Z',
          },
        ],
        recurringPayments: [],
      }),
      'utf8',
    );

    await expect(new JsonPreparedActionStore(path).getAction('pa_old_sol')).resolves.toMatchObject({
      params: {
        amount: '0.01',
        amountSol: '0.01',
      },
    });
  });

  it('defaults repeat schedules active and honors agent-paused schedules', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    const active = await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '22222222222222222222222222222222',
      amount: '0.01',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
    });
    const paused = await store.addRecurringPayment({
      status: 'paused',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '33333333333333333333333333333333',
      amount: '0.02',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
      metadata: {
        agentReviewStatus: 'denied',
        agentReviewDecision: 'deny',
      },
    });

    expect(active.status).toBe('active');
    expect(paused).toMatchObject({
      status: 'paused',
      metadata: {
        agentReviewStatus: 'denied',
        agentReviewDecision: 'deny',
      },
    });
    await expect(store.materializeDueRecurring(new Date('2026-05-08T20:00:00.000Z'))).resolves.toHaveLength(1);
  });

  it('materializes one overdue weekly payment when the user opens later that day', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'USDC',
      recipient: '22222222222222222222222222222222',
      amount: '10',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
      note: 'Weekly content payout',
    });

    const fridayAt8pm = new Date('2026-05-08T20:00:00.000');
    const first = await store.materializeDueRecurring(fridayAt8pm);
    const second = await store.materializeDueRecurring(fridayAt8pm);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'transfer_spl',
      status: 'overdue',
      occurrenceKey: '2026-05-08',
      params: { token: 'USDC', amount: '10' },
      note: 'Weekly content payout',
    });
    expect(second).toHaveLength(0);
    await expect(store.listActions()).resolves.toHaveLength(1);
  });

  it('materializes a recurring swap as a swap approval', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      actionKind: 'swap',
      token: 'SOL',
      inputToken: 'SOL',
      outputToken: 'USDC',
      recipient: '',
      amount: '0.10',
      slippageBps: 50,
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
      note: 'Weekly DCA',
    });

    const due = await store.materializeDueRecurring(new Date('2026-05-08T20:00:00.000'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      kind: 'swap',
      status: 'overdue',
      occurrenceKey: '2026-05-08',
      params: {
        inputToken: 'SOL',
        outputToken: 'USDC',
        amount: '0.10',
        slippageBps: 50,
      },
      note: 'Weekly DCA',
    });
  });

  it('does not create a stale weekly occurrence before the schedule start time', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '22222222222222222222222222222222',
      amount: '0.01',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '09:00',
      startAt: '2026-05-05T12:00:00.000Z',
    });

    await expect(store.materializeDueRecurring(new Date('2026-05-05T12:01:00.000Z'))).resolves.toHaveLength(0);
    const due = await store.materializeDueRecurring(new Date('2026-05-08T16:01:00.000Z'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      kind: 'transfer_sol',
      params: { recipient: '22222222222222222222222222222222', amountSol: '0.01' },
      occurrenceKey: '2026-05-08',
    });
  });

  it('materializes monthly payments and clamps oversized month days', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'USDC',
      recipient: '22222222222222222222222222222222',
      amount: '10',
      cadence: 'monthly',
      dayOfMonth: 31,
      localTime: '09:00',
      startAt: '2026-02-01T00:00:00.000Z',
    });

    const due = await store.materializeDueRecurring(new Date('2026-02-28T18:00:00.000Z'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      occurrenceKey: '2026-02-28',
      params: { token: 'USDC', amount: '10' },
    });
  });

  it('materializes every-N-days payments and stops at max occurrences', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '22222222222222222222222222222222',
      amount: '0.01',
      cadence: 'interval_days',
      intervalDays: 3,
      localTime: '09:00',
      startAt: '2026-05-01T00:00:00',
      maxOccurrences: 1,
    });

    const first = await store.materializeDueRecurring(new Date('2026-05-04T09:01:00'));
    const second = await store.materializeDueRecurring(new Date('2026-05-07T09:01:00'));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ occurrenceKey: '2026-05-04' });
    expect(second).toHaveLength(0);
  });

  it('materializes every-N-hours payments from startAt', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '22222222222222222222222222222222',
      amount: '0.01',
      cadence: 'interval_hours',
      intervalHours: 3,
      startAt: '2026-05-01T09:30:00.000Z',
    });

    const due = await store.materializeDueRecurring(new Date('2026-05-01T16:00:00.000Z'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      occurrenceKey: '2026-05-01T15:30:00.000Z',
      params: { recipient: '22222222222222222222222222222222', amountSol: '0.01' },
    });
  });

  it('materializes every-N-minutes payments and stops at max occurrences', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'USDC',
      recipient: '22222222222222222222222222222222',
      amount: '10',
      cadence: 'interval_minutes',
      intervalMinutes: 15,
      startAt: '2026-05-01T09:00:00.000Z',
      maxOccurrences: 1,
    });

    const first = await store.materializeDueRecurring(new Date('2026-05-01T09:46:00.000Z'));
    const second = await store.materializeDueRecurring(new Date('2026-05-01T10:01:00.000Z'));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      occurrenceKey: '2026-05-01T09:45:00.000Z',
      params: { token: 'USDC', amount: '10' },
    });
    expect(second).toHaveLength(0);
  });

  it('does not materialize another recurring payment while a prior action is unresolved', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    const recurring = await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'USDC',
      recipient: '22222222222222222222222222222222',
      amount: '10',
      cadence: 'interval_minutes',
      intervalMinutes: 15,
      startAt: '2026-05-01T09:00:00.000Z',
    });

    const first = await store.materializeDueRecurring(new Date('2026-05-01T09:46:00.000Z'));
    const blocked = await store.materializeDueRecurring(new Date('2026-05-01T10:01:00.000Z'));
    await store.updateAction(first[0]!.id, { status: 'approved' });
    const next = await store.materializeDueRecurring(new Date('2026-05-01T10:16:00.000Z'));

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ recurringId: recurring.id, occurrenceKey: '2026-05-01T09:45:00.000Z' });
    expect(blocked).toHaveLength(0);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ recurringId: recurring.id, occurrenceKey: '2026-05-01T10:15:00.000Z' });
    await expect(store.listActions()).resolves.toHaveLength(2);
  });

  it('promotes scheduled actions to overdue when their due time passes', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    const action = await store.addAction({
      kind: 'transfer_sol',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      summary: 'Transfer later',
      params: { recipient: '11111111111111111111111111111111', amountSol: '0.01' },
      dueAt: '2030-01-01T00:00:00.000Z',
    });

    expect(action.status).toBe('scheduled');
    await store.updateAction(action.id, { dueAt: '2020-01-01T00:00:00.000Z' });

    await expect(store.getAction(action.id)).resolves.toMatchObject({
      id: action.id,
      status: 'overdue',
    });
  });

  it('lists newest actions first and deletes local inbox records', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    const older = await store.addAction({
      kind: 'transfer_sol',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      summary: 'Older transfer',
      params: { recipient: '11111111111111111111111111111111', amountSol: '0.01' },
      dueAt: '2026-01-01T00:00:00.000Z',
    });
    await store.updateAction(older.id, { createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = await store.addAction({
      kind: 'transfer_sol',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      summary: 'Newer transfer',
      params: { recipient: '11111111111111111111111111111111', amountSol: '0.02' },
      dueAt: '2026-01-01T00:00:00.000Z',
    });
    await store.updateAction(newer.id, { createdAt: '2026-01-02T00:00:00.000Z' });

    await expect(store.listActions()).resolves.toMatchObject([
      { id: newer.id },
      { id: older.id },
    ]);
    await expect(store.deleteAction(older.id)).resolves.toBe(true);
    await expect(store.deleteAction(older.id)).resolves.toBe(false);
    await expect(store.listActions()).resolves.toMatchObject([{ id: newer.id }]);
  });

  it('supports recurring schedule lifecycle, next due views, archives, and receipts', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    const recurring = await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      token: 'SOL',
      recipient: '22222222222222222222222222222222',
      amount: '0.01',
      cadence: 'interval_hours',
      intervalHours: 3,
      startAt: '2026-05-01T09:00:00.000Z',
      maxOccurrences: 2,
      note: 'Ops test',
    });

    await expect(store.listRecurringPaymentViews(new Date('2026-05-01T10:00:00.000Z'))).resolves.toMatchObject([
      { id: recurring.id, nextDueAt: '2026-05-01T12:00:00.000Z' },
    ]);
    await store.updateRecurringPayment(recurring.id, { status: 'paused' });
    await expect(store.materializeDueRecurring(new Date('2026-05-01T13:00:00.000Z'))).resolves.toHaveLength(0);
    await store.updateRecurringPayment(recurring.id, { status: 'active' });
    await expect(store.materializeDueRecurring(new Date('2026-05-01T13:00:00.000Z'))).resolves.toHaveLength(1);

    const [action] = await store.listActions();
    expect(action).toBeDefined();
    await store.updateAction(action!.id, {
      status: 'approved',
      txid: 'abc123',
      txStatus: 'confirmed',
      confirmedAt: '2026-05-01T13:01:00.000Z',
    });
    await expect(store.listReceipts()).resolves.toMatchObject([
      {
        actionId: action!.id,
        status: 'approved',
        txid: 'abc123',
        amount: '0.01',
        token: 'SOL',
        note: 'Ops test',
      },
    ]);
    await expect(store.archiveAction(action!.id)).resolves.toMatchObject({ archived: true });
    await expect(store.deleteRecurringPayment(recurring.id)).resolves.toBe(true);
  });

  it('materializes a connector recurring template into a parametric prepared action', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      actionKind: 'connector',
      token: 'USDC',
      recipient: '',
      amount: '10',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
      connectorActionTemplate: {
        connectorId: 'kamino',
        actionType: 'kamino_deposit',
        params: { token: 'USDC', amount: '10', memo: 'Recurring DCA' },
      },
    });
    const due = await store.materializeDueRecurring(new Date('2026-05-08T20:00:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      kind: 'kamino_deposit',
      params: expect.objectContaining({
        token: 'USDC',
        amount: '10',
        connectorId: 'kamino',
        recurringActionType: 'kamino_deposit',
        pendingPrepare: 'true',
      }),
    });
  });

  it('materializes a recurring blink template with the blink url frozen in params', async () => {
    const store = new JsonPreparedActionStore(await tempStorePath());
    await store.addRecurringPayment({
      walletAddress: '11111111111111111111111111111111',
      cluster: 'devnet',
      actionKind: 'blink',
      token: 'SOL',
      recipient: '',
      amount: '0',
      cadence: 'weekly',
      dayOfWeek: 5,
      localTime: '00:00',
      startAt: '2026-05-01T00:00:00.000Z',
      connectorActionTemplate: {
        connectorId: 'sample',
        actionType: 'blink_action',
        params: { intent: 'claim' },
        blinkUrl: 'https://example.com/blink/claim',
      },
    });
    const due = await store.materializeDueRecurring(new Date('2026-05-08T20:00:00.000Z'));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      kind: 'blink_action',
      params: expect.objectContaining({
        connectorId: 'sample',
        blinkUrl: 'https://example.com/blink/claim',
        intent: 'claim',
        pendingPrepare: 'true',
      }),
    });
  });
});

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sawa-prepared-actions-'));
  return join(dir, 'prepared-actions.json');
}
