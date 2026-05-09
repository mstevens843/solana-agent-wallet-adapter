import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '../cloud/cookies.js';
import { MemoryWorkflowStore } from '../cloud/memoryStore.js';
import { createRecurringApiHandler } from '../cloud/recurringRoutes.js';
import {
  MemoryRecurringStore,
  RecurringService,
  type RecurringAuditEvent,
  type RecurringOccurrenceRecord,
  type RecurringScheduleRecord,
  type RecurringSession,
} from '../cloud/recurringService.js';
import { RecurringScheduler } from '../cloud/scheduler.js';
import { createWalletSession } from '../cloud/session.js';
import { createRenderWebServer } from '../server.js';

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

const walletA = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletB = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

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
    await withRecurringServer(async ({ port, setNow }) => {
      setNow(new Date('2026-05-01T12:00:00Z'));
      const created = await postJson(port, '/api/recurring', {
        ...validIntervalMinutesBody(),
        maxOccurrences: 2,
      }, walletA);
      const schedule = created.body.schedule as RecurringScheduleRecord;

      setNow(new Date('2026-05-01T12:11:00Z'));
      const first = await postJson(port, '/api/recurring/materialize-due', {}, walletA);
      expect((first.body as { results: { reason: string }[] }).results[0]?.reason).toBe('created');

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

      expect(seed.status).toBe(400);
      expect(privateKey.status).toBe(400);
      expect(delegated.status).toBe(400);
      expect(unlimited.status).toBe(400);
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
      }>;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('ready');
      expect(approvals[0]?.recurringScheduleId).toBe(schedule.id);
      expect(approvals[0]?.params?.recurringScheduleId).toBe(schedule.id);
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
      const approval = (inboxBefore.body.approvals as Array<{ id: string }>)[0];
      expect(approval?.id).toBeDefined();

      const decision = await requestJsonWithHeaders(
        port,
        'POST',
        `/api/approvals/${encodeURIComponent(approval!.id)}/approve`,
        { proofSignature: 'sig_recurring_approve' },
        headers,
      );
      expect(decision.status).toBe(200);

      const recurringAfter = await requestJsonWithHeaders(port, 'GET', '/api/recurring', undefined, headers);
      const occurrences = recurringAfter.body.occurrences as RecurringOccurrenceRecord[];
      const synced = occurrences.find((entry) => entry.recurringScheduleId === schedule.id);
      expect(synced?.status).toBe('completed');
    });
  });
});

function validCreateBody(): Record<string, unknown> {
  return {
    cluster: 'devnet',
    token: 'SOL',
    recipient: 'Recipient111111111111111111111111111111111',
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
    recipient: 'Recipient111111111111111111111111111111111',
    amount: '0.10',
    cadence: 'interval_minutes',
    intervalMinutes: 10,
  };
}

function parseCreate(body: Record<string, unknown>): Parameters<RecurringService['createSchedule']>[1] {
  return body as unknown as Parameters<RecurringService['createSchedule']>[1];
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
): Promise<void> {
  const server = createRenderWebServer({
    staticDir: await staticDir(),
    store,
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
