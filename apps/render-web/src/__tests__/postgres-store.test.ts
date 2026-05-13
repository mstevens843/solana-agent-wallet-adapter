import { randomUUID } from 'node:crypto';

import pg from 'pg';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresWorkflowStore, type PgClient, type PgConnection } from '../cloud/postgresStore.js';
import { RecurringService, type RecurringOccurrenceRecord } from '../cloud/recurringService.js';
import type { AuthNonceRecord, WalletSessionRecord } from '../cloud/store.js';
import type { ApprovalRequestRecord, PlanDraftRecord } from '../cloud/workflowValidation.js';

const { Pool } = pg;
const walletA = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletB = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('postgres workflow store', () => {
  it('runs migrations inside a dedicated checked-out connection', async () => {
    const client = new TrackingPoolClient();
    const store = new PostgresWorkflowStore({ client });

    await store.migrate();

    expect(client.poolQueries.some((name) => name === 'BEGIN' || name === 'COMMIT' || name === 'ROLLBACK')).toBe(false);
    expect(client.connections).toHaveLength(1);
    expect(client.connections[0]?.queries[0]).toBe('BEGIN');
    expect(client.connections[0]?.queries[1]).toBe('SELECT pg_advisory_xact_lock(1788732421, 424242)');
    expect(client.connections.at(-1)?.queries.some((query) => query.includes('approval_requests_active_plan_draft_idx'))).toBe(true);
    expect(client.connections.at(-1)?.queries.some((query) => query.includes('duplicate_active_plan_approval'))).toBe(true);
    expect(client.connections.at(-1)?.queries.some((query) => query.includes('approval_requests_active_recurring_occurrence_idx'))).toBe(true);
    expect(client.connections.at(-1)?.queries.some((query) => query.includes('duplicate_active_recurring_occurrence_approval'))).toBe(true);
    expect(client.connections[0]?.queries.at(-1)).toBe('COMMIT');
    expect(client.connections[0]?.released).toBe(true);
  });

  it('persists workflow records across store instances and keeps wallet scope', async () => {
    const client = new FakePgClient();
    const first = new PostgresWorkflowStore({ client });
    const second = new PostgresWorkflowStore({ client });

    await first.savePlan(walletA, samplePlan('plan_a', walletA));

    expect((await second.listPlans(walletA)).map((plan) => plan.id)).toEqual(['plan_a']);
    expect(await second.listPlans(walletB)).toEqual([]);
    expect(await second.getPlan(walletB, 'plan_a')).toBeUndefined();
  });

  it('persists wallet-scoped preferences across store instances', async () => {
    const client = new FakePgClient();
    const first = new PostgresWorkflowStore({ client });
    const second = new PostgresWorkflowStore({ client });

    await first.savePreference(walletA, {
      namespace: 'ai-settings',
      payload: { mode: 'hosted', provider: 'openai', model: 'gpt-5' },
      updatedAt: '2026-05-08T20:00:00.000Z',
      version: 1,
    });

    expect(await second.getPreference(walletA, 'ai-settings')).toMatchObject({
      namespace: 'ai-settings',
      payload: { mode: 'hosted', provider: 'openai', model: 'gpt-5' },
      version: 1,
    });
    expect(await second.getPreference(walletB, 'ai-settings')).toBeUndefined();
    expect((await second.listPreferences(walletA)).map((entry) => entry.namespace)).toEqual(['ai-settings']);
  });

  it('maps active approval plan uniqueness conflicts to approval_exists', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });

    await store.saveApproval(walletA, sampleApproval('approval_1', walletA, { planDraftId: 'plan_a' }));

    await expect(store.saveApproval(walletA, sampleApproval('approval_2', walletA, { planDraftId: 'plan_a' })))
      .rejects.toMatchObject({ code: 'approval_exists' });
    await expect(store.saveApproval(walletB, sampleApproval('approval_3', walletB, { planDraftId: 'plan_a' })))
      .resolves.toBeUndefined();
    await expect(store.saveApproval(walletA, sampleApproval('approval_4', walletA, {
      planDraftId: 'plan_a',
      status: 'approved',
    }))).resolves.toBeUndefined();
  });

  it('maps active recurring occurrence approval conflicts to approval_exists', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });

    await store.saveApproval(walletA, sampleApproval('approval_1', walletA, {
      planDraftId: undefined,
      recurringScheduleId: 'recurring_1',
      recurringOccurrenceId: 'occurrence_1',
    }));

    await expect(store.saveApproval(walletA, sampleApproval('approval_2', walletA, {
      planDraftId: undefined,
      recurringScheduleId: 'recurring_1',
      recurringOccurrenceId: 'occurrence_1',
    }))).rejects.toMatchObject({ code: 'approval_exists' });
    await expect(store.saveApproval(walletB, sampleApproval('approval_3', walletB, {
      planDraftId: undefined,
      recurringScheduleId: 'recurring_1',
      recurringOccurrenceId: 'occurrence_1',
    }))).resolves.toBeUndefined();
  });

  it('atomically consumes auth nonces so replayed wallet sign-ins fail', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    const nonce = sampleNonce();

    await store.createAuthNonce(nonce);
    expect(await store.getAuthNonce(nonce.nonce)).not.toHaveProperty('consumedAt');

    const consumed = await store.consumeAuthNonce(nonce.nonce, '2026-05-08T20:01:00.000Z');
    const replay = await store.consumeAuthNonce(nonce.nonce, '2026-05-08T20:02:00.000Z');

    expect(consumed).toMatchObject({ nonce: nonce.nonce, consumedAt: '2026-05-08T20:01:00.000Z' });
    expect(replay).toBeUndefined();
  });

  it('does not atomically consume expired auth nonces', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    const nonce = sampleNonce({ expiresAt: '2026-05-08T20:01:00.000Z' });

    await store.createAuthNonce(nonce);

    expect(await store.consumeAuthNonce(nonce.nonce, '2026-05-08T20:01:00.000Z')).toBeUndefined();
    expect(await store.getAuthNonce(nonce.nonce)).not.toHaveProperty('consumedAt');
  });

  it('stores an auth nonce before the wallet has a verified user row', async () => {
    const client = new FakePgClient();
    const store = new PostgresWorkflowStore({ client });
    const nonce = sampleNonce();

    await store.createAuthNonce(nonce);

    expect(client.userUpserts).toBe(0);
    expect(await store.getAuthNonce(nonce.nonce)).toMatchObject({
      nonce: nonce.nonce,
      walletAddress: walletA,
    });
  });

  it('cleans expired nonces and sessions', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    const nonce = sampleNonce({ expiresAt: '2026-05-08T19:00:00.000Z' });
    const session = sampleSession({ expiresAt: '2026-05-08T19:00:00.000Z' });

    await store.createAuthNonce(nonce);
    await store.createSession(session);
    await store.cleanupExpired('2026-05-08T20:00:00.000Z');

    expect(await store.getAuthNonce(nonce.nonce)).toBeUndefined();
    expect(await store.getSession(session.tokenHash)).toBeUndefined();
  });

  it('materializes a recurring due window only once', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    let now = new Date('2026-05-08T20:00:00.000Z');
    const service = new RecurringService(store, { clock: () => now });

    const schedule = await service.createSchedule({ walletAddress: walletA }, {
      cluster: 'devnet',
      token: 'SOL',
      recipient: 'Recipient111111111111111111111111111111111',
      amount: '0.10',
      cadence: 'interval_minutes',
      intervalMinutes: 10,
    });

    now = new Date('2026-05-08T20:12:00.000Z');
    const first = await service.materializeDueOccurrences({ walletAddress: walletA });
    const second = await service.materializeDueOccurrences({ walletAddress: walletA });
    const occurrences = await store.listOccurrences(walletA, schedule.id);

    expect(first[0]?.reason).toBe('created');
    expect(second[0]?.reason).toBe('duplicate');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.occurrenceKey).toBe(first[0]?.occurrenceKey);
  });

  it('claims recurring occurrences by wallet schedule window', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    const schedule = scheduleRecord();
    await store.saveSchedule(walletA, schedule);

    const first = await store.claimOccurrence(walletA, occurrenceRecord('occurrence_1', schedule.id));
    const second = await store.claimOccurrence(walletA, occurrenceRecord('occurrence_2', schedule.id));
    const occurrences = await store.listOccurrences(walletA, schedule.id);

    expect(first).toMatchObject({ created: true, occurrence: { id: 'occurrence_1' } });
    expect(second).toMatchObject({ created: false, occurrence: { id: 'occurrence_1' } });
    expect(occurrences).toHaveLength(1);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('postgres workflow store integration', () => {
  it('migrates real Postgres and persists wallet-scoped records', async () => {
    if (!testDatabaseUrl) return;
    const schema = `agentic_test_${randomUUID().replace(/-/g, '_')}`;
    const admin = new Pool({ connectionString: testDatabaseUrl });
    const pool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schema}`,
    });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const first = new PostgresWorkflowStore({ client: pool });
      const second = new PostgresWorkflowStore({ client: pool });
      await first.migrate();

      await first.createAuthNonce(sampleNonce());
      const consumed = await first.consumeAuthNonce('nonce_1', '2026-05-08T20:01:00.000Z');
      const replay = await first.consumeAuthNonce('nonce_1', '2026-05-08T20:02:00.000Z');
      await first.savePlan(walletA, samplePlan('plan_a', walletA));
      await first.saveApproval(walletA, sampleApproval('approval_a', walletA, { planDraftId: 'plan_a' }));

      expect(consumed).toMatchObject({ nonce: 'nonce_1' });
      expect(replay).toBeUndefined();
      expect((await second.listPlans(walletA)).map((plan) => plan.id)).toEqual(['plan_a']);
      expect(await second.listPlans(walletB)).toEqual([]);
      await expect(second.saveApproval(walletA, sampleApproval('approval_b', walletA, { planDraftId: 'plan_a' })))
        .rejects.toMatchObject({ code: 'approval_exists' });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});

interface JsonRow<T> {
  id: string;
  wallet_address: string;
  record: T;
  status?: string;
  created_at?: string;
  updated_at?: string;
  recurring_schedule_id?: string;
  occurrence_key?: string;
  due_at?: string;
}

class FakePgClient implements PgClient {
  readonly nonces = new Map<string, Record<string, unknown>>();
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly plans = new Map<string, JsonRow<PlanDraftRecord>>();
  readonly approvals = new Map<string, JsonRow<ApprovalRequestRecord>>();
  readonly schedules = new Map<string, JsonRow<ReturnType<typeof scheduleRecord>>>();
  readonly occurrences = new Map<string, JsonRow<RecurringOccurrenceRecord>>();
  readonly preferences = new Map<string, {
    wallet_address: string;
    namespace: string;
    payload: unknown;
    updated_at: string;
    version: number;
  }>();
  userUpserts = 0;

  async query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    const name = query.name ?? query.text.trim();
    const values = query.values ?? [];

    switch (name) {
      case 'user.upsert':
        this.userUpserts += 1;
        return result([]);
      case 'audit.insert':
        return result([]);

      case 'nonce.upsert': {
        this.nonces.set(String(values[0]), {
          nonce: values[0],
          wallet_address: values[1],
          domain: values[2],
          issued_at: values[3],
          expires_at: values[4],
          message: values[5],
          created_at: values[6],
          consumed_at: values[7] ?? null,
        });
        return result([]);
      }

      case 'nonce.get': {
        const row = this.nonces.get(String(values[0]));
        return result(row ? [row] : []);
      }

      case 'nonce.consume': {
        const row = this.nonces.get(String(values[0]));
        if (!row || row.consumed_at) return result([]);
        if (Date.parse(String(row.expires_at)) <= Date.parse(String(values[1]))) return result([]);
        row.consumed_at = values[1];
        return result([row]);
      }

      case 'nonces.cleanup': {
        const cutoff = Date.parse(String(values[0]));
        for (const [nonce, row] of this.nonces) {
          if (Date.parse(String(row.expires_at)) <= cutoff || row.consumed_at) this.nonces.delete(nonce);
        }
        return result([]);
      }

      case 'session.upsert': {
        this.sessions.set(String(values[0]), {
          token_hash: values[0],
          wallet_address: values[1],
          created_at: values[2],
          expires_at: values[3],
          last_seen_at: values[4],
          revoked_at: values[5] ?? null,
        });
        return result([]);
      }

      case 'session.get': {
        const row = this.sessions.get(String(values[0]));
        return result(row ? [row] : []);
      }

      case 'sessions.cleanup': {
        const cutoff = Date.parse(String(values[0]));
        for (const [tokenHash, row] of this.sessions) {
          if (Date.parse(String(row.expires_at)) <= cutoff || row.revoked_at) this.sessions.delete(tokenHash);
        }
        return result([]);
      }

      case 'plan.upsert': {
        const record = JSON.parse(String(values[5])) as PlanDraftRecord;
        this.plans.set(record.id, {
          id: record.id,
          wallet_address: String(values[1]),
          status: String(values[2]),
          created_at: String(values[3]),
          updated_at: String(values[4]),
          record,
        });
        return result([]);
      }

      case 'plan.list':
        return result([...this.plans.values()].filter((row) => row.wallet_address === values[0]).map((row) => ({ record: row.record })));

      case 'plan.get': {
        const row = this.plans.get(String(values[1]));
        return result(row && row.wallet_address === values[0] ? [{ record: row.record }] : []);
      }

      case 'preference.upsert': {
        const row = {
          wallet_address: String(values[0]),
          namespace: String(values[1]),
          version: Number(values[2]),
          updated_at: String(values[3]),
          payload: JSON.parse(String(values[4])) as unknown,
        };
        this.preferences.set(`${row.wallet_address}:${row.namespace}`, row);
        return result([row]);
      }

      case 'preference.get': {
        const row = this.preferences.get(`${String(values[0])}:${String(values[1])}`);
        return result(row ? [row] : []);
      }

      case 'preference.list': {
        const namespaceFilter = Array.isArray(values[1]) ? new Set(values[1].map(String)) : undefined;
        const rows = [...this.preferences.values()]
          .filter((row) => row.wallet_address === values[0])
          .filter((row) => !namespaceFilter || namespaceFilter.has(row.namespace))
          .sort((left, right) => left.namespace.localeCompare(right.namespace));
        return result(rows);
      }

      case 'approval.upsert': {
        const record = JSON.parse(String(values[6])) as ApprovalRequestRecord;
        const planDraftId = approvalPlanDraftId(record);
        const duplicatePlan = planDraftId && isActiveApprovalStatusForIndex(record.status)
          ? [...this.approvals.values()].find((entry) => {
            return entry.wallet_address === values[1] &&
              entry.id !== record.id &&
              approvalPlanDraftId(entry.record) === planDraftId &&
              isActiveApprovalStatusForIndex(entry.record.status);
          })
          : undefined;
        if (duplicatePlan) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "approval_requests_active_plan_draft_idx"'), {
            code: '23505',
            constraint: 'approval_requests_active_plan_draft_idx',
          });
        }
        const duplicateRecurring = record.recurringOccurrenceId && isActiveApprovalStatusForIndex(record.status)
          ? [...this.approvals.values()].find((entry) => {
            return entry.wallet_address === values[1] &&
              entry.id !== record.id &&
              entry.record.recurringOccurrenceId === record.recurringOccurrenceId &&
              isActiveApprovalStatusForIndex(entry.record.status);
          })
          : undefined;
        if (duplicateRecurring) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "approval_requests_active_recurring_occurrence_idx"'), {
            code: '23505',
            constraint: 'approval_requests_active_recurring_occurrence_idx',
          });
        }
        this.approvals.set(record.id, {
          id: record.id,
          wallet_address: String(values[1]),
          status: String(values[2]),
          due_at: String(values[3]),
          created_at: String(values[4]),
          updated_at: String(values[5]),
          record,
        });
        return result([]);
      }

      case 'approval.list':
        return result([...this.approvals.values()].filter((row) => row.wallet_address === values[0]).map((row) => ({ record: row.record })));

      case 'approval.get': {
        const row = this.approvals.get(String(values[1]));
        return result(row && row.wallet_address === values[0] ? [{ record: row.record }] : []);
      }

      case 'recurring.schedule.upsert': {
        const record = JSON.parse(String(values[7])) as ReturnType<typeof scheduleRecord>;
        this.schedules.set(record.id, {
          id: record.id,
          wallet_address: String(values[1]),
          status: String(values[2]),
          created_at: String(values[5]),
          updated_at: String(values[6]),
          record,
        });
        return result([]);
      }

      case 'recurring.schedule.list':
        return result([...this.schedules.values()].filter((row) => row.wallet_address === values[0]).map((row) => ({ record: row.record })));

      case 'recurring.occurrence.findByKey': {
        const row = [...this.occurrences.values()].find((entry) => {
          return entry.wallet_address === values[0] &&
            entry.recurring_schedule_id === values[1] &&
            entry.occurrence_key === values[2];
        });
        return result(row ? [{ record: row.record }] : []);
      }

      case 'recurring.occurrence.upsert': {
        const duplicate = [...this.occurrences.values()].find((entry) => {
          return entry.wallet_address === values[2] &&
            entry.recurring_schedule_id === values[1] &&
            entry.occurrence_key === values[4] &&
            entry.id !== values[0];
        });
        if (duplicate) return result([]);
        const record = JSON.parse(String(values[8])) as RecurringOccurrenceRecord;
        this.occurrences.set(record.id, {
          id: record.id,
          wallet_address: String(values[2]),
          recurring_schedule_id: String(values[1]),
          status: String(values[3]),
          occurrence_key: String(values[4]),
          due_at: String(values[5]),
          created_at: String(values[6]),
          updated_at: String(values[7]),
          record,
        });
        return result([]);
      }

      case 'recurring.occurrence.claim': {
        const duplicate = [...this.occurrences.values()].find((entry) => {
          return entry.wallet_address === values[2] &&
            entry.recurring_schedule_id === values[1] &&
            entry.occurrence_key === values[4];
        });
        if (duplicate) return result([{ record: duplicate.record }]);
        const record = JSON.parse(String(values[8])) as RecurringOccurrenceRecord;
        this.occurrences.set(record.id, {
          id: record.id,
          wallet_address: String(values[2]),
          recurring_schedule_id: String(values[1]),
          status: String(values[3]),
          occurrence_key: String(values[4]),
          due_at: String(values[5]),
          created_at: String(values[6]),
          updated_at: String(values[7]),
          record,
        });
        return result([{ record }]);
      }

      case 'recurring.occurrence.list':
      case 'recurring.occurrence.listForSchedule':
        return result([...this.occurrences.values()]
          .filter((row) => row.wallet_address === values[0])
          .filter((row) => values[1] ? row.recurring_schedule_id === values[1] : true)
          .map((row) => ({ record: row.record })));

      default:
        throw new Error(`Unhandled fake pg query: ${name}`);
    }
  }
}

class TrackingPoolClient implements PgClient {
  readonly poolQueries: string[] = [];
  readonly connections: TrackingConnection[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    this.poolQueries.push(queryName(query));
    return result([]);
  }

  async connect(): Promise<PgConnection> {
    const connection = new TrackingConnection();
    this.connections.push(connection);
    return connection;
  }
}

class TrackingConnection implements PgConnection {
  readonly queries: string[] = [];
  released = false;

  async query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    this.queries.push(queryName(query));
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

function queryName(query: QueryConfig): string {
  return query.name ?? query.text.trim();
}

function result<R extends QueryResultRow>(rows: Array<Record<string, unknown>>): QueryResult<R> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rowCount: rows.length,
    rows: rows as R[],
  };
}

function sampleNonce(overrides: Partial<AuthNonceRecord> = {}): AuthNonceRecord {
  return {
    nonce: 'nonce_1',
    walletAddress: walletA,
    domain: 'agentic-signer.com',
    issuedAt: '2026-05-08T20:00:00.000Z',
    expiresAt: '2026-05-08T20:05:00.000Z',
    message: 'Sign in to Agentic Cloud.',
    createdAt: '2026-05-08T20:00:00.000Z',
    ...overrides,
  };
}

function sampleSession(overrides: Partial<WalletSessionRecord> = {}): WalletSessionRecord {
  return {
    tokenHash: 'token_hash_1',
    walletAddress: walletA,
    createdAt: '2026-05-08T20:00:00.000Z',
    expiresAt: '2026-05-15T20:00:00.000Z',
    lastSeenAt: '2026-05-08T20:00:00.000Z',
    ...overrides,
  };
}

function samplePlan(id: string, walletAddress: string): PlanDraftRecord {
  return {
    id,
    walletAddress,
    plan: {
      intent: 'Send SOL',
      route: 'Wallet approval required.',
      risk: 'Medium.',
      approval: 'Review in wallet.',
    },
    title: 'Send SOL',
    intent: 'Send SOL',
    route: 'Wallet approval required.',
    risk: 'Medium.',
    approval: 'Review in wallet.',
    createdAt: '2026-05-08T20:00:00.000Z',
    updatedAt: '2026-05-08T20:00:00.000Z',
    source: 'template',
    category: 'payments',
    actionType: 'transfer_sol',
    parameters: { amount: '0.1' },
    fields: [{ label: 'Amount', value: '0.1 SOL' }],
    safeguards: ['Wallet approval required.'],
    templateId: 'send-sol',
    templateTitle: 'Send SOL',
    prompt: 'Send SOL',
    cluster: 'devnet',
    status: 'draft',
  };
}

function sampleApproval(
  id: string,
  walletAddress: string,
  overrides: Partial<ApprovalRequestRecord> = {},
): ApprovalRequestRecord {
  return {
    id,
    walletAddress,
    planDraftId: 'plan_a',
    kind: 'transfer_sol',
    status: 'ready',
    summary: 'Approve SOL transfer',
    params: { amount: '0.1' },
    cluster: 'devnet',
    dueAt: '2026-05-08T20:00:00.000Z',
    createdAt: '2026-05-08T20:00:00.000Z',
    updatedAt: '2026-05-08T20:00:00.000Z',
    ...overrides,
  };
}

function approvalPlanDraftId(record: ApprovalRequestRecord): string | undefined {
  return record.planDraftId ?? record.planId;
}

function isActiveApprovalStatusForIndex(status: string): boolean {
  return status === 'pending' || status === 'scheduled' || status === 'ready' || status === 'overdue' || status === 'approval_pending';
}

function scheduleRecord() {
  return {
    id: 'recurring_1',
    status: 'active' as const,
    walletAddress: walletA,
    cluster: 'devnet' as const,
    token: 'SOL',
    recipient: 'Recipient111111111111111111111111111111111',
    amount: '0.10',
    cadence: 'interval_minutes' as const,
    intervalMinutes: 10,
    createdAt: '2026-05-08T20:00:00.000Z',
    updatedAt: '2026-05-08T20:00:00.000Z',
  };
}

function occurrenceRecord(id: string, scheduleId: string): RecurringOccurrenceRecord {
  return {
    id,
    recurringScheduleId: scheduleId,
    walletAddress: walletA,
    cluster: 'devnet',
    status: 'ready',
    occurrenceKey: '2026-05-08T20:10:00.000Z',
    dueAt: '2026-05-08T20:10:00.000Z',
    createdAt: '2026-05-08T20:10:00.000Z',
    updatedAt: '2026-05-08T20:10:00.000Z',
  };
}
