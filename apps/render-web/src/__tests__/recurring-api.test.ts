import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { workflowFinalizationProofMessage } from '@solana-agent-wallet-adapter/workflow';

import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { encodeBase58 } from '../cloud/auth.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createRecurringApiHandler } from '../cloud/recurringRoutes.js';
import {
  MemoryRecurringStore,
  RecurringService,
  RecurringServiceError,
  type RecurringAuditEvent,
  type RecurringOccurrenceRecord,
  type RecurringScheduleRecord,
  type RecurringSession,
} from '../cloud/recurringService.js';
import { RecurringScheduler } from '../cloud/scheduler.js';
import { createWalletSession } from '../cloud/session.js';
import { createRenderWebServer } from '../server.js';
import type { Clock } from '../cloud/store.js';
import { workflowDecisionProofMessage } from '../cloud/workflowService.js';
import type { ApprovalRequestRecord, TransactionFinalizationRecord } from '../cloud/workflowValidation.js';

interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
}

interface ServerCtx {
  port: number;
  store: TestRecurringStore;
  service: RecurringService;
  setNow(now: Date): void;
}

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

const testWalletA = createTestWallet();
const testWalletB = createTestWallet();
const walletA = testWalletA.walletAddress;
const walletB = testWalletB.walletAddress;

describe('cloud recurring scheduler API', () => {
  it('rejects every recurring endpoint without a wallet session', async () => {
    await withRecurringServer(async ({ port }) => {
      const create = await postJson(port, '/api/recurring', validCreateBody(), null);
      const list = await getJson(port, '/api/recurring', null);
      const update = await patchJson(port, '/api/recurring/anything', { status: 'paused' }, null);
      const remove = await deleteJson(port, '/api/recurring/anything', null);
      const materialize = await postJson(port, '/api/recurring/materialize-due', {}, null);
      for (const response of [create, list, update, remove, materialize]) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'unauthorized' });
      }
    });
  });

  it('rejects malformed recurring ids as validation errors', async () => {
    await withRecurringServer(async ({ port }) => {
      const response = await patchJson(port, '/api/recurring/%E0%A4%A', { status: 'paused' }, walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_id');
    });
  });

  it('rejects terminal schedule states on recurring create requests', async () => {
    await withRecurringServer(async ({ port, service }) => {
      const completed = await postJson(port, '/api/recurring', {
        ...validCreateBody(),
        status: 'completed',
      }, walletA);
      const cancelled = await postJson(port, '/api/recurring', {
        ...validCreateBody(),
        status: 'cancelled',
      }, walletA);

      expect(completed.status).toBe(400);
      expect(completed.body.error).toBe('invalid_status');
      expect(cancelled.status).toBe(400);
      expect(cancelled.body.error).toBe('invalid_status');
      await expect(service.createSchedule({ walletAddress: walletA }, {
        ...parseCreate(validCreateBody()),
        status: 'completed',
      } as unknown as Parameters<RecurringService['createSchedule']>[1])).rejects.toBeInstanceOf(RecurringServiceError);
    });
  });

  it('creates, lists, updates, and deletes recurring schedules', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validCreateBody(), walletA);
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      expect(schedule.id).toMatch(/^recurring_/);
      expect(schedule.walletAddress).toBe(walletA);
      expect(schedule.status).toBe('active');
      expect(schedule.cadence).toBe('weekly');
      expect(schedule.occurrencesCreated).toBe(0);

      const listed = await getJson(port, '/api/recurring', walletA);
      expect(listed.status).toBe(200);
      const ids = (listed.body.schedules as RecurringScheduleRecord[]).map((entry) => entry.id);
      expect(ids).toEqual([schedule.id]);
      expect(listed.body.occurrences).toEqual([]);

      const paused = await patchJson(port, `/api/recurring/${schedule.id}`, { status: 'paused' }, walletA);
      expect(paused.status).toBe(200);
      expect((paused.body.schedule as RecurringScheduleRecord).status).toBe('paused');

      const resumed = await patchJson(port, `/api/recurring/${schedule.id}`, { status: 'active', amount: '0.5' }, walletA);
      expect(resumed.status).toBe(200);
      expect((resumed.body.schedule as RecurringScheduleRecord).status).toBe('active');
      expect((resumed.body.schedule as RecurringScheduleRecord).amount).toBe('0.5');

      const removed = await deleteJson(port, `/api/recurring/${schedule.id}`, walletA);
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual({ ok: true });

      const afterDelete = await getJson(port, '/api/recurring', walletA);
      expect(afterDelete.body.schedules).toEqual([]);
    });
  });

  it('does not materialize a paused schedule but does after resume', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      await patchJson(port, `/api/recurring/${schedule.id}`, { status: 'paused' }, walletA);
      setNow(new Date('2026-05-01T12:10:00Z'));
      const paused = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      const pausedResults = (paused.body as { results: { reason: string }[] }).results;
      expect(pausedResults[0]?.reason).toBe('paused');

      await patchJson(port, `/api/recurring/${schedule.id}`, { status: 'active' }, walletA);
      setNow(new Date('2026-05-01T12:11:00Z'));
      const after = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      const afterResults = (after.body as { results: { reason: string }[] }).results;
      expect(afterResults[0]?.reason).toBe('created');
    });
  });

  it('creates paused agent-reviewed schedules, resumes after agent re-review, and records safe audit transitions', async () => {
    await withRecurringServer(async ({ port, setNow, store }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', {
        ...validIntervalMinutesBody(),
        status: 'paused',
        metadata: deniedAgentMetadata(),
      }, walletA);
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      expect(schedule).toMatchObject({
        status: 'paused',
        metadata: {
          agentReviewStatus: 'denied',
          connectorId: 'kamino',
        },
      });

      setNow(new Date('2026-05-01T12:10:00Z'));
      const paused = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      expect((paused.body as { results: { reason: string }[] }).results[0]?.reason).toBe('paused');

      const resumed = await patchJson(port, `/api/recurring/${schedule.id}`, {
        status: 'active',
        metadata: approvedAgentMetadata(),
      }, walletA);
      expect(resumed.status).toBe(200);
      expect((resumed.body.schedule as RecurringScheduleRecord).status).toBe('active');

      const manualPause = await postJson(port, `/api/recurring/${schedule.id}/pause`, {}, walletA);
      expect(manualPause.status).toBe(200);
      const manualResume = await postJson(port, `/api/recurring/${schedule.id}/resume`, {}, walletA);
      expect(manualResume.status).toBe(200);
      const echoed = await patchJson(port, `/api/recurring/${schedule.id}`, {
        note: 'User updated note after review',
        metadata: approvedAgentMetadata(),
      }, walletA);
      expect(echoed.status).toBe(200);

      const events = store.auditEventsFor(walletA);
      expect(events.find((event) => event.type === 'recurring.schedule.created')?.metadata).toMatchObject({
        previousStatus: '',
        nextStatus: 'paused',
        statusTransition: { from: '', to: 'paused' },
        transitionSource: 'agent',
        agentReviewStatus: 'denied',
        agentReviewDecision: 'deny',
        agentReviewReason: 'Connector facts were missing.',
        connectorId: 'kamino',
      });
      expect(events.find((event) =>
        event.type === 'recurring.schedule.updated' &&
        event.metadata?.nextStatus === 'active' &&
        event.metadata?.transitionSource === 'agent',
      )?.metadata).toMatchObject({
        previousStatus: 'paused',
        nextStatus: 'active',
        transitionSource: 'agent',
        agentReviewStatus: 'approved',
      });
      expect(events.find((event) => event.type === 'recurring.schedule.paused')?.metadata).toMatchObject({
        previousStatus: 'active',
        nextStatus: 'paused',
        transitionSource: 'user',
      });
      expect(events.find((event) => event.type === 'recurring.schedule.resumed')?.metadata).toMatchObject({
        previousStatus: 'paused',
        nextStatus: 'active',
        transitionSource: 'user',
      });
      expect(events.find((event) =>
        event.type === 'recurring.schedule.updated' &&
        event.metadata?.previousStatus === 'active' &&
        event.metadata?.nextStatus === 'active' &&
        event.metadata?.transitionSource === 'user',
      )?.metadata).toMatchObject({
        previousStatus: 'active',
        nextStatus: 'active',
        transitionSource: 'user',
        agentReviewStatus: 'approved',
      });
      expect(JSON.stringify(events.map((event) => event.metadata))).not.toContain('rawPrompt');
    });
  });

  it('scopes schedules and occurrences to the signed-in wallet', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      setNow(new Date('2026-05-01T12:10:00Z'));
      await postJson(port, '/api/recurring/materialize-due', {}, walletA);

      const otherList = await getJson(port, '/api/recurring', walletB);
      expect(otherList.body.schedules).toEqual([]);
      expect(otherList.body.occurrences).toEqual([]);

      expect((await patchJson(port, `/api/recurring/${schedule.id}`, { status: 'paused' }, walletB)).status).toBe(404);
      expect((await deleteJson(port, `/api/recurring/${schedule.id}`, walletB)).status).toBe(404);

      const otherMaterialize = await postJson(port, '/api/recurring/materialize-due', {}, walletB);
      expect((otherMaterialize.body as { results: unknown[] }).results).toEqual([]);
    });
  });

  it('creates one occurrence per due window and dedupes repeated calls', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      setNow(new Date('2026-05-01T12:10:00Z'));
      const first = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      const firstResults = (first.body as { results: Array<{ reason: string; occurrenceKey?: string; occurrenceId?: string }> }).results;
      expect(firstResults).toHaveLength(1);
      expect(firstResults[0]?.reason).toBe('created');
      expect(firstResults[0]?.occurrenceKey).toBeDefined();
      const occurrenceKey = firstResults[0]!.occurrenceKey!;

      const second = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      const secondResults = (second.body as { results: Array<{ reason: string; occurrenceKey?: string }> }).results;
      expect(secondResults).toHaveLength(1);
      expect(secondResults[0]?.reason).toBe('duplicate');
      expect(secondResults[0]?.occurrenceKey).toBe(occurrenceKey);

      const listed = await getJson(port, '/api/recurring', walletA);
      const occurrences = (listed.body.occurrences as RecurringOccurrenceRecord[])
        .filter((entry) => entry.recurringScheduleId === schedule.id);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.status).toBe('ready');
      expect(occurrences[0]?.occurrenceKey).toBe(occurrenceKey);
    });
  });

  it('lazy-materializes due work on GET /api/recurring', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      setNow(new Date('2026-05-01T12:15:00Z'));
      const listed = await getJson(port, '/api/recurring', walletA);
      const occurrences = (listed.body.occurrences as RecurringOccurrenceRecord[])
        .filter((entry) => entry.recurringScheduleId === schedule.id);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]?.status).toBe('ready');
    });
  });

  it('completes the schedule when maxOccurrences is reached', async () => {
    await withRecurringServer(async ({ port, setNow, store }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', {
        ...validIntervalMinutesBody(),
        maxOccurrences: 2,
      }, walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      setNow(new Date('2026-05-01T12:11:00Z'));
      const first = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      expect((first.body as { results: { reason: string }[] }).results[0]?.reason).toBe('created');
      const [firstOccurrence] = await store.listOccurrences(walletA, schedule.id);
      await store.saveOccurrence(walletA, {
        ...firstOccurrence!,
        status: 'completed',
        updatedAt: new Date('2026-05-01T12:12:00Z').toISOString(),
      });

      setNow(new Date('2026-05-01T12:21:00Z'));
      const second = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      expect((second.body as { results: { reason: string }[] }).results[0]?.reason).toBe('created');

      setNow(new Date('2026-05-01T12:31:00Z'));
      const third = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      expect((third.body as { results: { reason: string }[] }).results[0]?.reason).toBe('completed');

      const listed = await getJson(port, '/api/recurring', walletA);
      const reloaded = (listed.body.schedules as RecurringScheduleRecord[]).find((entry) => entry.id === schedule.id);
      expect(reloaded?.status).toBe('completed');
    });
  });

  it('rejects forbidden secrets, delegated signers, and unlimited approval authority', async () => {
    await withRecurringServer(async ({ port }) => {
      const seed = await postJson(port, '/api/recurring', { ...validCreateBody(), seedPhrase: 'leak' }, walletA);
      const privateKey = await postJson(port, '/api/recurring', { ...validCreateBody(), privateKey: 'leak' }, walletA);
      const delegated = await postJson(port, '/api/recurring', { ...validCreateBody(), delegatedSigner: 'server' }, walletA);
      const unlimited = await postJson(port, '/api/recurring', { ...validCreateBody(), approvalAuthority: 'unlimited' }, walletA);
      const nestedReviewSecret = await postJson(port, '/api/recurring', {
        ...validCreateBody(),
        metadata: { agentReview: { privateKey: 'leak' } },
      }, walletA);

      expect(seed.status).toBe(400);
      expect(privateKey.status).toBe(400);
      expect(delegated.status).toBe(400);
      expect(unlimited.status).toBe(400);
      expect(nestedReviewSecret.status).toBe(400);
      expect(nestedReviewSecret.body.error).toBe('forbidden_secret');
    });
  });

  it('appends an audit event for each materialized occurrence', async () => {
    await withRecurringServer(async ({ port, store, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      setNow(new Date('2026-05-01T12:10:00Z'));
      await postJson(port, '/api/recurring/materialize-due', {}, walletA);

      const events = store.auditEventsFor(walletA);
      expect(events.some((event) => event.type === 'recurring.schedule.created')).toBe(true);
      expect(events.some((event) => event.type === 'recurring.materialized')).toBe(true);
    });
  });

  it('registers materialized occurrences as Phase 3 approvals via the approval sink', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    const sinkCalls: Array<{ scheduleId: string; occurrenceId: string }> = [];
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ schedule, occurrence }) => {
        sinkCalls.push({ scheduleId: schedule.id, occurrenceId: occurrence.id });
        return { approvalId: `approval_for_${occurrence.id}` };
      },
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    now = new Date('2026-05-01T12:11:00Z');
    const results = await service.materializeDueOccurrences({ walletAddress: walletA });

    expect(results[0]?.reason).toBe('created');
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]?.scheduleId).toBe(schedule.id);

    const occurrences = await store.listOccurrences(walletA);
    expect(occurrences[0]?.approvalRequestId).toBe(`approval_for_${occurrences[0]?.id}`);
  });

  it('does not duplicate approval sink calls when materialization races', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    let ids = 0;
    const sinkCalls: Array<{ scheduleId: string; occurrenceId: string }> = [];
    const service = new RecurringService(store, {
      clock: () => now,
      idFactory: () => String(++ids),
      approvalSink: async ({ schedule, occurrence }) => {
        await Promise.resolve();
        sinkCalls.push({ scheduleId: schedule.id, occurrenceId: occurrence.id });
        return { approvalId: `approval_for_${occurrence.id}` };
      },
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    now = new Date('2026-05-01T12:11:00Z');
    const [first, second] = await Promise.all([
      service.materializeDueOccurrences({ walletAddress: walletA }),
      service.materializeDueOccurrences({ walletAddress: walletA }),
    ]);

    const reasons = [first[0]?.reason, second[0]?.reason].sort();
    const occurrences = await store.listOccurrences(walletA, schedule.id);
    const reloaded = await store.getSchedule(walletA, schedule.id);
    const materializedAuditEvents = store.auditEventsFor(walletA)
      .filter((event) => event.type === 'recurring.materialized');

    expect(reasons).toEqual(['created', 'duplicate']);
    expect(sinkCalls).toHaveLength(1);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.approvalRequestId).toBe(`approval_for_${sinkCalls[0]?.occurrenceId}`);
    expect(reloaded?.occurrencesCreated).toBe(1);
    expect(materializedAuditEvents).toHaveLength(1);
  });

  it('does not materialize another recurring occurrence while the previous approval is unresolved', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    const approvalStatuses = new Map<string, string>();
    const sinkCalls: Array<{ scheduleId: string; occurrenceId: string }> = [];
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ schedule, occurrence }) => {
        const approvalId = `approval_for_${occurrence.id}`;
        approvalStatuses.set(approvalId, 'ready');
        sinkCalls.push({ scheduleId: schedule.id, occurrenceId: occurrence.id });
        return { approvalId };
      },
      approvalStatusReader: async (_walletAddress, approvalId) => ({
        status: approvalStatuses.get(approvalId) ?? 'ready',
      }),
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    now = new Date('2026-05-01T12:11:00Z');
    const first = await service.materializeDueOccurrences({ walletAddress: walletA });
    expect(first[0]?.reason).toBe('created');

    now = new Date('2026-05-01T12:21:00Z');
    const blocked = await service.materializeDueOccurrences({ walletAddress: walletA });
    expect(blocked[0]?.reason).toBe('pending_approval');
    expect(sinkCalls).toHaveLength(1);
    await expect(store.listOccurrences(walletA, schedule.id)).resolves.toHaveLength(1);

    const approvalId = (await store.listOccurrences(walletA, schedule.id))[0]?.approvalRequestId;
    expect(approvalId).toBeDefined();
    approvalStatuses.set(approvalId!, 'approved');

    now = new Date('2026-05-01T12:31:00Z');
    const next = await service.materializeDueOccurrences({ walletAddress: walletA });
    expect(next[0]?.reason).toBe('created');
    expect(sinkCalls).toHaveLength(2);
    await expect(store.listOccurrences(walletA, schedule.id)).resolves.toHaveLength(2);
  });

  it('rejects a non-positive maxOccurrences at create', async () => {
    await withRecurringServer(async ({ service }) => {
      await expect(
        service.createSchedule(
          { walletAddress: walletA },
          { ...parseCreate(validIntervalMinutesBody()), maxOccurrences: 0 },
        ),
      ).rejects.toMatchObject({ code: 'invalid_max_occurrences' });
    });
  });

  it('rejects an expiry that falls before the first scheduled run', async () => {
    await withRecurringServer(async ({ service }) => {
      await expect(
        service.createSchedule(
          { walletAddress: walletA },
          { ...parseCreate(validCreateBody()), expiresAt: '2000-01-01T00:00:00.000Z' },
        ),
      ).rejects.toMatchObject({ code: 'expires_before_first_run' });
    });
  });

  it('rejects a weekly schedule created without a valid dayOfWeek', async () => {
    await withRecurringServer(async ({ service }) => {
      const body = parseCreate(validCreateBody()) as unknown as Record<string, unknown>;
      delete body.dayOfWeek;
      await expect(
        service.createSchedule(
          { walletAddress: walletA },
          body as unknown as Parameters<RecurringService['createSchedule']>[1],
        ),
      ).rejects.toMatchObject({ code: 'invalid_cadence_fields' });
    });
  });

  it('does not consume a maxOccurrences slot when the approval sink fails, then retries', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    let sinkShouldFail = true;
    const sinkCalls: string[] = [];
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ occurrence }) => {
        sinkCalls.push(occurrence.id);
        if (sinkShouldFail) throw new Error('approval service unavailable');
        return { approvalId: `approval_for_${occurrence.id}` };
      },
    });

    const schedule = await service.createSchedule(
      { walletAddress: walletA },
      { ...parseCreate(validIntervalMinutesBody()), maxOccurrences: 1 },
    );

    // Sink throws on the first materialize: the occurrence stays retryable, the
    // schedule does NOT consume its single maxOccurrences slot or complete.
    now = new Date('2026-05-01T12:11:00Z');
    const failed = await service.materializeDueOccurrences({ walletAddress: walletA });
    expect(failed[0]?.reason).toBe('pending_approval');
    let reloaded = await store.getSchedule(walletA, schedule.id);
    expect(reloaded?.occurrencesCreated ?? 0).toBe(0);
    expect(reloaded?.status).toBe('active');

    // Sink recovers; after the recoverable age threshold the occurrence retries,
    // attaches, and only then does the slot count and the schedule complete.
    sinkShouldFail = false;
    now = new Date('2026-05-01T12:12:00Z');
    await service.materializeDueOccurrences({ walletAddress: walletA });
    reloaded = await store.getSchedule(walletA, schedule.id);
    expect(reloaded?.occurrencesCreated).toBe(1);
    expect(reloaded?.status).toBe('completed');
    const occurrences = await store.listOccurrences(walletA, schedule.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.approvalRequestId).toBe(`approval_for_${occurrences[0]?.id}`);
    expect(sinkCalls).toHaveLength(2);
  });

  it('persists timezone and fires weekly occurrences at the zone-local time', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-01-05T12:00:00Z'); // Monday
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ occurrence }) => ({ approvalId: `approval_for_${occurrence.id}` }),
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, {
      ...parseCreate(validCreateBody()),
      dayOfWeek: 5, // Friday
      localTime: '09:00',
      timezone: 'America/New_York',
    });
    expect(schedule.timezone).toBe('America/New_York');
    // Next Friday is 2026-01-09; 09:00 EST = 14:00 UTC.
    expect(schedule.nextDueAt).toBe('2026-01-09T14:00:00.000Z');

    now = new Date('2026-01-09T15:00:00Z'); // just after the Friday run
    const results = await service.materializeDueOccurrences({ walletAddress: walletA });
    expect(results[0]?.reason).toBe('created');
    const occurrences = await store.listOccurrences(walletA, schedule.id);
    expect(occurrences[0]?.dueAt).toBe('2026-01-09T14:00:00.000Z');
    expect(occurrences[0]?.occurrenceKey).toBe('2026-01-09');
  });

  it('repairs a claimed occurrence that was saved before approval registration completed', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    const sinkCalls: Array<{ scheduleId: string; occurrenceId: string }> = [];
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ schedule, occurrence }) => {
        sinkCalls.push({ scheduleId: schedule.id, occurrenceId: occurrence.id });
        return { approvalId: `approval_for_${occurrence.id}` };
      },
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    await store.saveOccurrence(walletA, {
      id: 'occurrence_interrupted',
      recurringScheduleId: schedule.id,
      walletAddress: walletA,
      cluster: 'devnet',
      status: 'ready',
      occurrenceKey: '2026-05-01T12:10:00.000Z',
      dueAt: '2026-05-01T12:10:00.000Z',
      createdAt: '2026-05-01T12:10:00.000Z',
      updatedAt: '2026-05-01T12:10:00.000Z',
    });

    now = new Date('2026-05-01T12:11:00Z');
    const first = await service.materializeDueOccurrences({ walletAddress: walletA });
    const second = await service.materializeDueOccurrences({ walletAddress: walletA });

    const occurrences = await store.listOccurrences(walletA, schedule.id);
    const reloaded = await store.getSchedule(walletA, schedule.id);
    const materializedAuditEvents = store.auditEventsFor(walletA)
      .filter((event) => event.type === 'recurring.materialized');

    expect(first[0]?.reason).toBe('duplicate');
    expect(second[0]?.reason).toBe('duplicate');
    expect(sinkCalls).toEqual([{ scheduleId: schedule.id, occurrenceId: 'occurrence_interrupted' }]);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.approvalRequestId).toBe('approval_for_occurrence_interrupted');
    expect(occurrences[0]?.status).toBe('approval_pending');
    expect(reloaded?.occurrencesCreated).toBe(1);
    expect(reloaded?.nextDueAt).toBeDefined();
    expect(materializedAuditEvents).toHaveLength(1);
    expect(materializedAuditEvents[0]?.metadata).toMatchObject({ recovered: true });
  });

  it('does not repair stale occurrences that already have approval state', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    const sinkCalls: Array<{ scheduleId: string; occurrenceId: string }> = [];
    const service = new RecurringService(store, {
      clock: () => now,
      approvalSink: async ({ schedule, occurrence }) => {
        sinkCalls.push({ scheduleId: schedule.id, occurrenceId: occurrence.id });
        return { approvalId: `approval_for_${occurrence.id}` };
      },
    });

    const schedule = await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    await store.saveOccurrence(walletA, {
      id: 'occurrence_existing_approval',
      recurringScheduleId: schedule.id,
      walletAddress: walletA,
      cluster: 'devnet',
      status: 'approval_pending',
      approvalRequestId: 'approval_existing',
      occurrenceKey: '2026-05-01T12:10:00.000Z',
      dueAt: '2026-05-01T12:10:00.000Z',
      createdAt: '2026-05-01T12:10:00.000Z',
      updatedAt: '2026-05-01T12:10:00.000Z',
    });

    now = new Date('2026-05-01T12:11:00Z');
    const result = await service.materializeDueOccurrences({ walletAddress: walletA });

    const occurrences = await store.listOccurrences(walletA, schedule.id);
    const materializedAuditEvents = store.auditEventsFor(walletA)
      .filter((event) => event.type === 'recurring.materialized');

    expect(result[0]?.reason).toBe('duplicate');
    expect(sinkCalls).toEqual([]);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.approvalRequestId).toBe('approval_existing');
    expect(occurrences[0]?.status).toBe('approval_pending');
    expect(materializedAuditEvents).toHaveLength(0);
  });

  it('runs the in-process scheduler tick across all known wallets', async () => {
    const store = new TestRecurringStore();
    let now = new Date('2026-05-01T12:00:00Z');
    const service = new RecurringService(store, { clock: () => now });
    const scheduler = new RecurringScheduler({ service, store, enabled: false });

    await service.createSchedule({ walletAddress: walletA }, parseCreate(validIntervalMinutesBody()));
    await service.createSchedule({ walletAddress: walletB }, parseCreate(validIntervalMinutesBody()));

    now = new Date('2026-05-01T12:11:00Z');
    const tick = await scheduler.tick();
    const wallets = tick.walletResults.map((entry) => entry.walletAddress).sort();
    expect(wallets).toEqual([walletA, walletB].sort());
    for (const wallet of tick.walletResults) {
      expect(wallet.results.some((entry) => entry.reason === 'created')).toBe(true);
    }
  });

  it('materializes due cloud schedules into the render Approval Inbox without duplicates', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      };
      const created = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        ...validIntervalMinutesBody(),
        startAt: '2020-01-01T00:00:00.000Z',
        metadata: approvedAgentMetadata(),
      }, headers);
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      const first = await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
      const second = await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
      expect((first.body.results as Array<{ reason: string }>)[0]?.reason).toBe('created');
      expect((second.body.results as Array<{ reason: string }>)[0]?.reason).toBe('duplicate');

      const inbox = await requestJsonWithHeaders(port, 'GET', '/api/approvals', undefined, headers);
      const approvals = inbox.body.approvals as Array<{
        id: string;
        recurringScheduleId?: string;
        status: string;
        params?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('ready');
      expect(approvals[0]?.recurringScheduleId).toBe(schedule.id);
      expect(approvals[0]?.params?.recurringScheduleId).toBe(schedule.id);
      expect(approvals[0]?.metadata).toMatchObject({
        recurringScheduleId: schedule.id,
        recurringOccurrenceId: expect.any(String),
        occurrenceKey: expect.any(String),
        actionKind: 'transfer',
        connectorId: 'kamino',
        operation: 'deposit',
        agentReviewStatus: 'approved',
        agentReviewDecision: 'approve',
        agentReviewSummary: 'Review passed this recurring schedule.',
        approvalBoundary: 'This prepares a wallet approval request; it does not sign.',
      });
      expect(JSON.stringify(approvals[0]?.metadata)).not.toContain('rawPrompt');
    });
  });

  it('dry-runs and applies recurring approval backlog cleanup', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });
    await store.saveApproval(walletA, testApproval('approval_old', {
      recurringScheduleId: 'recurring_cleanup',
      recurringOccurrenceId: 'occurrence_old',
      occurrenceKey: '2026-05-01T12:10:00.000Z',
      dueAt: '2026-05-01T12:10:00.000Z',
      createdAt: '2026-05-01T12:10:10.000Z',
      updatedAt: '2026-05-01T12:10:10.000Z',
    }));
    await store.saveApproval(walletA, testApproval('approval_new', {
      recurringScheduleId: 'recurring_cleanup',
      recurringOccurrenceId: 'occurrence_new',
      occurrenceKey: '2026-05-01T12:20:00.000Z',
      dueAt: '2026-05-01T12:20:00.000Z',
      createdAt: '2026-05-01T12:20:10.000Z',
      updatedAt: '2026-05-01T12:20:10.000Z',
    }));
    await store.saveApproval(walletA, testApproval('approval_one_time'));
    await store.saveApproval(walletA, testApproval('approval_terminal', {
      recurringScheduleId: 'recurring_cleanup',
      recurringOccurrenceId: 'occurrence_done',
      status: 'approved',
      dueAt: '2026-05-01T12:00:00.000Z',
    }));

    await withRenderRecurringServer(store, async (port) => {
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      };
      const dryRun = await requestJsonWithHeaders(
        port,
        'POST',
        '/api/approvals/cleanup-recurring-backlog',
        { dryRun: true },
        headers,
      );
      expect(dryRun.body).toMatchObject({
        dryRun: true,
        scanned: 2,
        schedulesAffected: 1,
        kept: 1,
        cancelled: 1,
      });
      expect((await store.getApproval(walletA, 'approval_old'))?.status).toBe('ready');

      const applied = await requestJsonWithHeaders(
        port,
        'POST',
        '/api/approvals/cleanup-recurring-backlog',
        { dryRun: false },
        headers,
      );
      expect(applied.body).toMatchObject({
        dryRun: false,
        scanned: 2,
        schedulesAffected: 1,
        kept: 1,
        cancelled: 1,
      });

      const inbox = await requestJsonWithHeaders(port, 'GET', '/api/approvals', undefined, headers);
      const approvals = inbox.body.approvals as ApprovalRequestRecord[];
      expect(approvals.map((approval) => approval.id).sort()).toEqual(['approval_new', 'approval_one_time']);
      expect((await store.getApproval(walletA, 'approval_old'))?.status).toBe('cancelled');
      expect((await store.getApproval(walletA, 'approval_terminal'))?.status).toBe('approved');
    });
  });

  it('persists recurring swaps and materializes them as swap approvals', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      };
      const created = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        ...validSwapBody(),
        startAt: '2020-01-01T00:00:00.000Z',
      }, headers);
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      expect(schedule).toMatchObject({
        actionKind: 'swap',
        token: 'SOL',
        inputToken: 'SOL',
        outputToken: 'USDC',
        slippageBps: 50,
      });

      const materialized = await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
      expect((materialized.body.results as Array<{ reason: string }>)[0]?.reason).toBe('created');

      const inbox = await requestJsonWithHeaders(port, 'GET', '/api/approvals', undefined, headers);
      const approvals = inbox.body.approvals as Array<{
        kind: string;
        recurringScheduleId?: string;
        params?: Record<string, unknown>;
      }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        kind: 'swap',
        recurringScheduleId: schedule.id,
        params: {
          inputToken: 'SOL',
          outputToken: 'USDC',
          amount: '0.10',
          slippageBps: '50',
        },
      });
    });
  });

  it('rejects cloud recurring schedules over configured spend policy caps', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const response = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        ...validCreateBody(),
        amount: '0.25',
      }, {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('recurring_exceeds_policy');
      expect(response.body.message).toContain('per week');
    }, {
      recurringPolicy: { maxPerWeekAmount: { SOL: '0.10' } },
    });
  });

  it('evaluates policy caps against metadata.totalAmount for skill-monetization splits', async () => {
    // A user with a $9/mo USDC cap should NOT be able to install a $10/mo
    // skill, even if the platform takes 15% (schedule.amount = 8.5 < 9).
    // The cap must look at what the user actually pays.
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const response = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        cluster: 'devnet',
        token: 'USDC',
        recipient: walletB,
        amount: '8.5',
        cadence: 'monthly',
        dayOfMonth: 8,
        localTime: '09:30',
        note: 'Skill monetization split',
        metadata: {
          source: 'skill_install_monetization',
          skillInstallId: 'install_x',
          skillId: 'friday-dca',
          monetizationKind: 'monthly',
          platformWallet: walletA,
          platformAmount: '1.5',
          totalAmount: '10',
          platformFeeBps: 1500,
        },
      }, {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('recurring_exceeds_policy');
      expect(response.body.message).toContain('per month');
    }, {
      recurringPolicy: { maxPerMonthAmount: { USDC: '9' } },
    });
  });

  it('advances nextDueAt strictly past the just-materialized occurrence', async () => {
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      setNow(new Date('2026-05-01T12:11:00Z'));
      const result = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      const reasons = (result.body as { results: Array<{ reason: string; occurrenceKey?: string }> }).results;
      expect(reasons[0]?.reason).toBe('created');
      const occurrenceKey = reasons[0]?.occurrenceKey;
      expect(occurrenceKey).toBeDefined();

      const listed = await getJson(port, '/api/recurring', walletA);
      const reloaded = (listed.body.schedules as RecurringScheduleRecord[]).find((entry) => entry.id === schedule.id);
      expect(reloaded?.nextDueAt).toBeDefined();
      expect(new Date(reloaded!.nextDueAt!).getTime()).toBeGreaterThan(new Date('2026-05-01T12:11:00Z').getTime());
      // The next due must not point at the just-materialized window.
      expect(reloaded!.nextDueAt!.slice(0, 19)).not.toBe(occurrenceKey?.slice(0, 19));
    });
  });

  it('rejects PATCH that breaks cadence-field consistency', async () => {
    await withRecurringServer(async ({ port }) => {
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      const broken = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'monthly' },
        walletA,
      );
      expect(broken.status).toBe(400);
      expect((broken.body as { error?: string }).error).toBe('invalid_cadence_fields');

      const ok = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'monthly', dayOfMonth: 15, localTime: '10:00' },
        walletA,
      );
      expect(ok.status).toBe(200);
      expect((ok.body.schedule as RecurringScheduleRecord).cadence).toBe('monthly');
    });
  });

  it('syncs occurrence status to completed after the linked approval is approved', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withMockServerFinalization(async () => {
      await withRenderRecurringServer(store, async (port) => {
        const headers = {
          cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
        };

        const created = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
          ...validIntervalMinutesBody(),
          startAt: '2020-01-01T00:00:00.000Z',
        }, headers);
        const schedule = created.body.schedule as RecurringScheduleRecord;

        const materialized = await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
        expect((materialized.body.results as Array<{ reason: string }>)[0]?.reason).toBe('created');

        const inboxBefore = await requestJsonWithHeaders(port, 'GET', '/api/approvals', undefined, headers);
        const approval = (inboxBefore.body.approvals as ApprovalRequestRecord[])[0];
        expect(approval?.id).toBeDefined();

        const preview = await requestJsonWithHeaders(
          port,
          'POST',
          `/api/approvals/${encodeURIComponent(approval!.id)}/finalization/prepare`,
          {},
          headers,
        );
        expect(preview.status).toBe(201);
        const finalization = preview.body.finalization as TransactionFinalizationRecord;

        const decision = await requestJsonWithHeaders(
          port,
          'POST',
          `/api/approvals/${encodeURIComponent(approval!.id)}/finalization/${encodeURIComponent(finalization.id)}/submit`,
          {
            ...finalizationProofBody(approval!, finalization),
            finalizationId: finalization.id,
            finalizationStatus: 'confirmed',
            txStatus: 'confirmed',
            txid: 'tx_recurring_finalized',
            transactionHash: finalization.transactionHash,
            messageHash: finalization.messageHash,
            quoteHash: finalization.quote?.quoteHash,
            simulationHash: finalization.simulation?.simulationHash,
          },
          headers,
        );
        expect(decision.status).toBe(200);

        const recurringAfter = await requestJsonWithHeaders(port, 'GET', '/api/recurring', undefined, headers);
        const occurrences = recurringAfter.body.occurrences as RecurringOccurrenceRecord[];
        const synced = occurrences.find((entry) => entry.recurringScheduleId === schedule.id);
        expect(synced?.status).toBe('completed');

        const history = await requestJsonWithHeaders(
          port,
          'GET',
          `/api/recurring/${encodeURIComponent(schedule.id)}/occurrences?limit=1`,
          undefined,
          headers,
        );
        expect(history.status).toBe(200);
        const historyOccurrence = (history.body.occurrences as Array<{
          id: string;
          statusLabel?: { label: string; tone: string };
          approval?: { id: string; status: string; txid?: string; txStatus?: string };
          completed?: { id: string; txid?: string; status: string };
        }>)[0];
        expect(historyOccurrence?.approval).toMatchObject({
          id: approval!.id,
          status: 'approved',
          txid: 'tx_recurring_finalized',
          txStatus: 'confirmed',
        });
        expect(historyOccurrence?.completed).toMatchObject({
          status: 'approved',
          txid: 'tx_recurring_finalized',
        });
        expect(historyOccurrence?.statusLabel).toEqual({ label: 'Executed', tone: 'success' });
      });
    });
  });

  it('rejects invalid occurrence-history status filters', async () => {
    await withRecurringServer(async ({ port }) => {
      const created = await postJson(port, '/api/recurring', validCreateBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      const response = await getJson(port, `/api/recurring/${schedule.id}/occurrences?status=wat`, walletA);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_occurrence_status');
    });
  });

  it('syncs occurrence status to cancelled when the linked approval is denied', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      };

      const created = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        ...validIntervalMinutesBody(),
        startAt: '2020-01-01T00:00:00.000Z',
      }, headers);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
      const inbox = await requestJsonWithHeaders(port, 'GET', '/api/approvals', undefined, headers);
      const approval = (inbox.body.approvals as ApprovalRequestRecord[])[0];

      const denied = await requestJsonWithHeaders(
        port,
        'POST',
        `/api/approvals/${encodeURIComponent(approval!.id)}/deny`,
        decisionProofBody(approval!, 'rejected'),
        headers,
      );
      expect(denied.status).toBe(200);

      const recurringAfter = await requestJsonWithHeaders(port, 'GET', '/api/recurring', undefined, headers);
      const synced = (recurringAfter.body.occurrences as RecurringOccurrenceRecord[]).find(
        (entry) => entry.recurringScheduleId === schedule.id,
      );
      expect(synced?.status).toBe('cancelled');
    });
  });

  it('does not change occurrence status while the linked approval is still pending', async () => {
    const store = new MemoryWorkflowStore();
    const session = await createWalletSession({
      store,
      walletAddress: walletA,
      clock: { now: () => new Date('2026-05-08T20:00:00.000Z') },
    });

    await withRenderRecurringServer(store, async (port) => {
      const headers = {
        cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      };

      const created = await requestJsonWithHeaders(port, 'POST', '/api/recurring', {
        ...validIntervalMinutesBody(),
        startAt: '2020-01-01T00:00:00.000Z',
      }, headers);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);
      const before = await requestJsonWithHeaders(port, 'GET', '/api/recurring', undefined, headers);
      const occurrenceBefore = (before.body.occurrences as RecurringOccurrenceRecord[]).find(
        (entry) => entry.recurringScheduleId === schedule.id,
      );
      expect(occurrenceBefore?.status).toBe('approval_pending');

      // Force a re-sync by calling materialize-due again without changing the approval.
      await requestJsonWithHeaders(port, 'POST', '/api/recurring/materialize-due', {}, headers);

      const after = await requestJsonWithHeaders(port, 'GET', '/api/recurring', undefined, headers);
      const occurrenceAfter = (after.body.occurrences as RecurringOccurrenceRecord[]).find(
        (entry) => entry.recurringScheduleId === schedule.id,
      );
      expect(occurrenceAfter?.status).toBe('approval_pending');
    });
  });

  it('rejects PATCH cadence: weekly without dayOfWeek', async () => {
    await withRecurringServer(async ({ port }) => {
      const created = await postJson(port, '/api/recurring', validIntervalMinutesBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      const broken = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'weekly', localTime: '09:30' },
        walletA,
      );
      expect(broken.status).toBe(400);
      expect((broken.body as { error?: string }).error).toBe('invalid_cadence_fields');

      const ok = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'weekly', dayOfWeek: 1, localTime: '09:30' },
        walletA,
      );
      expect(ok.status).toBe(200);
      expect((ok.body.schedule as RecurringScheduleRecord).cadence).toBe('weekly');
    });
  });

  it('rejects PATCH cadence: interval_days without intervalDays', async () => {
    await withRecurringServer(async ({ port }) => {
      const created = await postJson(port, '/api/recurring', validCreateBody(), walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      const broken = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'interval_days' },
        walletA,
      );
      expect(broken.status).toBe(400);
      expect((broken.body as { error?: string }).error).toBe('invalid_cadence_fields');

      const ok = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { cadence: 'interval_days', intervalDays: 3 },
        walletA,
      );
      expect(ok.status).toBe(200);
      expect((ok.body.schedule as RecurringScheduleRecord).cadence).toBe('interval_days');
    });
  });

  it('round-trips expiresAt and notifications, but never returns webhookSecret to the client', async () => {
    await withRecurringServer(async ({ port, store }) => {
      const created = await postJson(
        port,
        '/api/recurring',
        {
          ...validCreateBody(),
          expiresAt: '2026-12-31T00:00:00.000Z',
          notifications: { inApp: true, webhookUrl: 'https://example.test/webhook' },
        },
        walletA,
      );
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      expect(schedule.expiresAt).toBe('2026-12-31T00:00:00.000Z');
      expect(schedule.notifications).toEqual({ inApp: true, webhookUrl: 'https://example.test/webhook' });
      // Server may store a generated secret in the JSONB record (Phase 4) but must never echo it back.
      expect((schedule.notifications as Record<string, unknown> | undefined)?.webhookSecret).toBeUndefined();

      // Simulate a server-side secret being persisted (as Phase 4 will do at create time).
      const stored = await store.getSchedule(walletA, schedule.id);
      const withSecret: RecurringScheduleRecord = {
        ...stored!,
        notifications: { ...stored!.notifications, webhookSecret: 'never-leak-this-secret' },
      };
      await store.saveSchedule(walletA, withSecret);

      // GET /:id should not return the secret.
      const fetched = await getJson(port, `/api/recurring/${schedule.id}`, walletA);
      expect(fetched.status).toBe(200);
      const fetchedSchedule = fetched.body.schedule as RecurringScheduleRecord;
      expect(fetchedSchedule.notifications?.webhookUrl).toBe('https://example.test/webhook');
      expect((fetchedSchedule.notifications as Record<string, unknown> | undefined)?.webhookSecret).toBeUndefined();

      // GET /api/recurring (list) should not return the secret either.
      const listed = await getJson(port, '/api/recurring', walletA);
      expect(listed.status).toBe(200);
      for (const entry of listed.body.schedules as RecurringScheduleRecord[]) {
        expect((entry.notifications as Record<string, unknown> | undefined)?.webhookSecret).toBeUndefined();
      }

      // PATCH should also scrub on response.
      const patched = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { notifications: { inApp: false, webhookUrl: 'https://example.test/webhook2' } },
        walletA,
      );
      expect(patched.status).toBe(200);
      expect(typeof patched.body.webhookSecretOnce).toBe('string');
      const patchedSchedule = patched.body.schedule as RecurringScheduleRecord;
      expect(patchedSchedule.notifications?.webhookUrl).toBe('https://example.test/webhook2');
      expect((patchedSchedule.notifications as Record<string, unknown> | undefined)?.webhookSecret).toBeUndefined();

      const rotate = await postJson(port, `/api/recurring/${schedule.id}/notifications/rotate`, {}, walletA);
      expect(rotate.status).toBe(200);
      expect(typeof rotate.body.webhookSecretOnce).toBe('string');
      expect(rotate.body.webhookSecretOnce).not.toBe(patched.body.webhookSecretOnce);

      const notifications = await getJson(port, `/api/recurring/${schedule.id}/notifications`, walletA);
      expect(notifications.status).toBe(200);
      expect(notifications.body).toMatchObject({
        enabled: true,
        webhookUrl: 'https://example.test/webhook2',
        deliveries: [],
      });
    });
  });

  it('rejects client-supplied webhookSecret in notifications', async () => {
    await withRecurringServer(async ({ port }) => {
      const response = await postJson(
        port,
        '/api/recurring',
        {
          ...validCreateBody(),
          notifications: { webhookUrl: 'https://example.test/x', webhookSecret: 'attempt-to-set' },
        },
        walletA,
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_notifications');
    });
  });

  it('rejects invalid expiresAt and webhookUrl values', async () => {
    await withRecurringServer(async ({ port }) => {
      const badExpiry = await postJson(
        port,
        '/api/recurring',
        { ...validCreateBody(), expiresAt: 'not-a-timestamp' },
        walletA,
      );
      expect(badExpiry.status).toBe(400);
      expect(badExpiry.body.error).toBe('invalid_iso_timestamp');

      const badWebhook = await postJson(
        port,
        '/api/recurring',
        { ...validCreateBody(), notifications: { webhookUrl: 'not a url' } },
        walletA,
      );
      expect(badWebhook.status).toBe(400);
      expect(badWebhook.body.error).toBe('invalid_notifications');

      const localhostWebhook = await postJson(
        port,
        '/api/recurring',
        { ...validCreateBody(), notifications: { webhookUrl: 'https://localhost/webhook' } },
        walletA,
      );
      expect(localhostWebhook.status).toBe(400);
      expect(localhostWebhook.body.error).toBe('invalid_notifications');

      const privateIpWebhook = await postJson(
        port,
        '/api/recurring',
        { ...validCreateBody(), notifications: { webhookUrl: 'https://127.0.0.1:9000/webhook' } },
        walletA,
      );
      expect(privateIpWebhook.status).toBe(400);
      expect(privateIpWebhook.body.error).toBe('invalid_notifications');
    });
  });

  it('rejects unsupported cloud recurring transfer tokens at create and update time', async () => {
    await withRecurringServer(async ({ port }) => {
      const unsupportedCreate = await postJson(
        port,
        '/api/recurring',
        { ...validCreateBody(), token: 'BONK' },
        walletA,
      );
      expect(unsupportedCreate.status).toBe(409);
      expect(unsupportedCreate.body.error).toBe('unsupported_cloud_recurring_token');

      const created = await postJson(port, '/api/recurring', validCreateBody(), walletA);
      expect(created.status).toBe(201);
      const schedule = created.body.schedule as RecurringScheduleRecord;
      const unsupportedUpdate = await patchJson(
        port,
        `/api/recurring/${schedule.id}`,
        { token: 'BONK' },
        walletA,
      );
      expect(unsupportedUpdate.status).toBe(409);
      expect(unsupportedUpdate.body.error).toBe('unsupported_cloud_recurring_token');
    });
  });

  // ─── $SKR recurring schedules — Android-only ecosystem token ────────────
  //
  // $SKR is the env-gated Solana Mobile Seeker ecosystem token. The recurring
  // service must (a) reject SKR with the same `unsupported_cloud_recurring_token`
  // error as any other unknown symbol when the deployment is not configured for
  // $SKR settlement, and (b) accept it cleanly once `SKR_TOKEN_MINT` is set —
  // by symbol *or* by the literal mint string, since both forms show up in
  // recurring-service callers downstream.
  describe('$SKR token gating', () => {
    const VALID_SKR_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

    it('rejects token: "SKR" with unsupported_cloud_recurring_token when SKR_TOKEN_MINT is unset', async () => {
      await withSkrEnv({}, async () => {
        await withRecurringServer(async ({ port }) => {
          const res = await postJson(
            port,
            '/api/recurring',
            { ...validCreateBody(), token: 'SKR' },
            walletA,
          );
          expect(res.status).toBe(409);
          expect(res.body.error).toBe('unsupported_cloud_recurring_token');
          // Surface the dynamic error message including SKR in the supported
          // list when env IS set — and excluding it when not.
          expect(String(res.body.message ?? '')).not.toContain('SKR');
        });
      });
    });

    it('accepts token: "SKR" symbol when SKR_TOKEN_MINT is configured', async () => {
      await withSkrEnv({ SKR_TOKEN_MINT: VALID_SKR_MINT }, async () => {
        await withRecurringServer(async ({ port }) => {
          const res = await postJson(
            port,
            '/api/recurring',
            { ...validCreateBody(), token: 'SKR' },
            walletA,
          );
          expect(res.status).toBe(201);
          expect((res.body.schedule as RecurringScheduleRecord).token).toBe('SKR');
        });
      });
    });

    it('accepts the configured SKR mint as the token literal (round-trip from prepared-action params)', async () => {
      // The recurring schedule may be created either by symbol ("SKR") or by
      // the literal mint string when the upstream caller passed the mint
      // directly. Both flow into `isSupportedCloudTransferToken`.
      await withSkrEnv({ SKR_TOKEN_MINT: VALID_SKR_MINT }, async () => {
        await withRecurringServer(async ({ port }) => {
          const res = await postJson(
            port,
            '/api/recurring',
            { ...validCreateBody(), token: VALID_SKR_MINT },
            walletA,
          );
          expect(res.status).toBe(201);
          expect((res.body.schedule as RecurringScheduleRecord).token).toBe(VALID_SKR_MINT);
        });
      });
    });

    it('mentions SKR in the unsupported-token error message when env is set but a different unknown token is used', async () => {
      await withSkrEnv({ SKR_TOKEN_MINT: VALID_SKR_MINT }, async () => {
        await withRecurringServer(async ({ port }) => {
          const res = await postJson(
            port,
            '/api/recurring',
            { ...validCreateBody(), token: 'BONK' },
            walletA,
          );
          expect(res.status).toBe(409);
          expect(res.body.error).toBe('unsupported_cloud_recurring_token');
          // The dynamic supported-tokens list now includes SKR — operator gets
          // an honest message instead of the pre-feature "SOL and USDC only".
          expect(String(res.body.message ?? '')).toContain('SKR');
        });
      });
    });
  });
});

function validCreateBody(): Record<string, unknown> {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient: walletB,
    amount: '0.25',
    cadence: 'weekly',
    dayOfWeek: 1,
    localTime: '09:30',
    note: 'Weekly payroll batch',
  };
}

function validIntervalMinutesBody(): Record<string, unknown> {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient: walletB,
    amount: '0.10',
    cadence: 'interval_minutes',
    intervalMinutes: 10,
  };
}

function validSwapBody(): Record<string, unknown> {
  return {
    cluster: 'devnet',
    actionKind: 'swap',
    token: 'SOL',
    inputToken: 'SOL',
    outputToken: 'USDC',
    recipient: '',
    amount: '0.10',
    slippageBps: 50,
    cadence: 'interval_minutes',
    intervalMinutes: 10,
  };
}

function approvedAgentMetadata(): Record<string, unknown> {
  return {
    agentReview: {
      summary: 'Review passed this recurring schedule.',
      reason: 'Cadence and approval boundary are clear.',
      rawPrompt: 'This should never appear in audit or approval summary metadata.',
    },
    agentReviewStatus: 'approved',
    agentReviewDecision: 'approve',
    agentReviewCheckedAt: '2026-05-01T12:00:00.000Z',
    agentReviewProvider: 'openai',
    agentReviewModel: 'review-model',
    connectorId: 'kamino',
    connectorName: 'Kamino',
    capability: 'earn',
    operation: 'deposit',
    factLabels: ['Reserve', 'Wallet'],
    actionSource: 'connector',
    approvalBoundary: 'This prepares a wallet approval request; it does not sign.',
  };
}

function deniedAgentMetadata(): Record<string, unknown> {
  return {
    ...approvedAgentMetadata(),
    agentReview: {
      summary: 'Agent denied this recurring schedule.',
      reason: 'Connector facts were missing.',
      rawPrompt: 'This should never appear in audit metadata.',
    },
    agentReviewStatus: 'denied',
    agentReviewDecision: 'deny',
  };
}

function parseCreate(body: Record<string, unknown>): Parameters<RecurringService['createSchedule']>[1] {
  return body as unknown as Parameters<RecurringService['createSchedule']>[1];
}

function decisionProofBody(
  approval: ApprovalRequestRecord,
  decision: 'approved' | 'rejected',
  wallet: TestWallet = testWalletA,
): Record<string, unknown> {
  const message = workflowDecisionProofMessage({ approval, decision });
  return {
    proofSignature: signMessage(message, wallet.privateKey),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function finalizationProofBody(
  approval: ApprovalRequestRecord,
  finalization: TransactionFinalizationRecord,
  wallet: TestWallet = testWalletA,
): Record<string, unknown> {
  const message = workflowFinalizationProofMessage({ approval, finalization });
  return {
    proofSignature: signMessage(message, wallet.privateKey),
    decisionProofMessage: message,
    signatureEncoding: 'base58',
  };
}

function testApproval(
  id: string,
  overrides: Partial<ApprovalRequestRecord> = {},
): ApprovalRequestRecord {
  const now = '2026-05-01T12:00:00.000Z';
  return {
    id,
    walletAddress: walletA,
    kind: 'transfer_sol',
    status: 'ready',
    summary: 'Recurring approval cleanup test',
    params: {},
    cluster: 'devnet',
    dueAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    privateKey,
  };
}

function signMessage(message: string, privateKey: KeyObject): string {
  return encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), privateKey));
}

async function withMockServerFinalization(callback: () => Promise<void>): Promise<void> {
  const previous = process.env.AGENTIC_MOCK_FINALIZATION;
  process.env.AGENTIC_MOCK_FINALIZATION = '1';
  try {
    await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENTIC_MOCK_FINALIZATION;
    } else {
      process.env.AGENTIC_MOCK_FINALIZATION = previous;
    }
  }
}

const SKR_ENV_KEYS = [
  'SKR_TOKEN_MINT',
  'SKR_TOKEN_DECIMALS',
  'SKR_SKILL_BOUNTY_ACTIVE',
  'SKR_SESSION_DEFAULT',
] as const;

type SkrEnvOverrides = Partial<Record<(typeof SKR_ENV_KEYS)[number], string | undefined>>;

/**
 * Run a callback with the given SKR_* env vars set, restoring the previous
 * values afterward. Mirrors `withMockServerFinalization` so SKR tests don't
 * leak state into other suites running in the same vitest worker.
 */
async function withSkrEnv(overrides: SkrEnvOverrides, callback: () => Promise<void>): Promise<void> {
  const previous = new Map<(typeof SKR_ENV_KEYS)[number], string | undefined>();
  for (const key of SKR_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withRecurringServer(callback: (ctx: ServerCtx) => Promise<void>): Promise<void> {
  const store = new TestRecurringStore();
  let now = new Date('2026-05-01T12:00:00Z');
  const service = new RecurringService(store, { clock: () => now });
  const handler = createRecurringApiHandler({
    service,
    getSession(req): RecurringSession | null {
      const wallet = req.headers['x-test-wallet'];
      return typeof wallet === 'string' && wallet ? { walletAddress: wallet } : null;
    },
  });

  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    }, (err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : 'error');
    });
  });

  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback({
      port: address.port,
      store,
      service,
      setNow(next: Date) {
        now = next;
      },
    });
  } finally {
    await close(server);
  }
}

async function withRenderRecurringServer(
  store: MemoryWorkflowStore,
  callback: (port: number) => Promise<void>,
  options: {
    recurringPolicy?: {
      maxPerWeekAmount?: Record<string, string>;
      maxPerMonthAmount?: Record<string, string>;
      maxLifetimeAmount?: Record<string, string>;
    };
    clock?: Clock;
  } = {},
): Promise<void> {
  const server = createRenderWebServer({
    staticDir: await staticDir(),
    store,
    recurringPolicy: options.recurringPolicy,
    // Default to the same fixed clock used by the cookie-based tests so session
    // expiry checks line up with createWalletSession timestamps. Tests using
    // x-test-wallet auth are unaffected.
    clock: options.clock ?? { now: () => new Date('2026-05-08T20:00:00.000Z') },
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port.');
    await callback(address.port);
  } finally {
    await close(server);
  }
}

async function staticDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentic-render-recurring-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  await mkdir(join(dir, 'app'));
  await writeFile(join(dir, 'app', 'index.html'), '<!doctype html><div id="app"></div>');
  return dir;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function postJson(port: number, path: string, body: unknown, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'POST', path, body, walletAddress);
}

function patchJson(port: number, path: string, body: unknown, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'PATCH', path, body, walletAddress);
}

function getJson(port: number, path: string, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'GET', path, undefined, walletAddress);
}

function deleteJson(port: number, path: string, walletAddress: string | null = walletA): Promise<TestResponse> {
  return jsonRequest(port, 'DELETE', path, undefined, walletAddress);
}

function jsonRequest(
  port: number,
  method: string,
  path: string,
  body: unknown,
  walletAddress: string | null,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (walletAddress) headers['x-test-wallet'] = walletAddress;

    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function requestJsonWithHeaders(
  port: number,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders: Record<string, string | number> = { ...headers };
    if (payload !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(payload);
    }

    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method, headers: requestHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('error', reject);
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

class TestRecurringStore extends MemoryRecurringStore {
  auditEventsFor(walletAddress: string): RecurringAuditEvent[] {
    return this.getAuditEvents().filter((event) => event.walletAddress === walletAddress);
  }
}
