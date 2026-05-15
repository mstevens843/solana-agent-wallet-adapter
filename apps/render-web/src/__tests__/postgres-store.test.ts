import { randomUUID } from 'node:crypto';

import pg from 'pg';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { runAggregatorRoll } from '../cloud/aggregatorJob.js';
import type { EvidenceReceiptRecord } from '../cloud/evidenceService.js';
import { migration008SkillsLayer2 } from '../cloud/migrations/008_skills_layer2.js';
import { migration009SignalSubscriptionActiveUnique } from '../cloud/migrations/009_signal_subscription_active_unique.js';
import { migration010SkillInstallsReinstallIndex } from '../cloud/migrations/010_skill_installs_reinstall_index.js';
import { migration011SignalsFanoutHardening } from '../cloud/migrations/011_signals_fanout_hardening.js';
import { PostgresWorkflowStore, type PgClient, type PgConnection } from '../cloud/postgresStore.js';
import { RecurringService, type RecurringOccurrenceRecord } from '../cloud/recurringService.js';
import type {
  AuthNonceRecord,
  SkillExecutionStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
  SignalEmissionStoreRecord,
  SignalFeedStoreRecord,
  SignalSubscriptionStoreRecord,
  WalletSessionRecord,
} from '../cloud/store.js';
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
    expect(client.connections.at(-1)?.queries.some((query) => query.includes('approval_requests_active_signal_fanout_idx'))).toBe(true);
    expect(client.connections[0]?.queries.at(-1)).toBe('COMMIT');
    expect(client.connections[0]?.released).toBe(true);
  });

  it('uses non-revoked uniqueness for signal subscriptions', () => {
    expect(migration008SkillsLayer2.sql).not.toContain('UNIQUE (follower_wallet, feed_id)');
    expect(migration008SkillsLayer2.sql).toContain('signal_subscriptions_active_unique_idx');
    expect(migration008SkillsLayer2.sql).toContain("WHERE status <> 'revoked'");
    expect(migration009SignalSubscriptionActiveUnique.sql).toContain(
      'DROP CONSTRAINT IF EXISTS signal_subscriptions_follower_wallet_feed_id_key',
    );
    expect(migration009SignalSubscriptionActiveUnique.sql).toContain("WHERE status <> 'revoked'");
  });

  it('uses non-revoked uniqueness for skill installs after the follow-up migration', () => {
    expect(migration010SkillInstallsReinstallIndex.sql).toContain(
      'DROP CONSTRAINT IF EXISTS skill_installs_wallet_address_skill_id_key',
    );
    expect(migration010SkillInstallsReinstallIndex.sql).toContain('skill_installs_wallet_skill_active_idx');
    expect(migration010SkillInstallsReinstallIndex.sql).toContain("WHERE status <> 'revoked'");
  });

  it('hardens signal fanout processing state and duplicate approval protection', () => {
    expect(migration011SignalsFanoutHardening.sql).toContain('fanout_processed_at');
    expect(migration011SignalsFanoutHardening.sql).toContain('signal_emissions_unprocessed_idx');
    expect(migration011SignalsFanoutHardening.sql).toContain('approval_requests_active_signal_fanout_idx');
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

  it('persists Layer 2 skill records across store instances', async () => {
    const client = new FakePgClient();
    const first = new PostgresWorkflowStore({ client });
    const second = new PostgresWorkflowStore({ client });

    await first.saveSkillManifest(sampleSkillManifest('friday-dca'));
    await first.saveSkillInstall(sampleSkillInstall('skill_install_1', walletA, 'friday-dca'));
    await first.saveSkillExecution(sampleSkillExecution('skill_exec_1', 'skill_install_1', walletA, 'friday-dca'));

    expect(await second.getSkillManifest('friday-dca')).toMatchObject({ id: 'friday-dca' });
    expect((await second.listSkillManifests()).map((record) => record.id)).toEqual(['friday-dca']);
    expect((await second.listSkillInstallsForWallet(walletA)).map((record) => record.id)).toEqual(['skill_install_1']);
    expect(await second.getSkillInstall('skill_install_1')).toMatchObject({ status: 'active' });
    expect((await second.listActiveSkillInstalls()).map((record) => record.id)).toEqual(['skill_install_1']);
    expect((await second.listSkillExecutionsByInstall('skill_install_1')).map((record) => record.id)).toEqual(['skill_exec_1']);
    expect((await second.listSkillExecutionsForSkill('friday-dca')).map((record) => record.id)).toEqual(['skill_exec_1']);
    expect(await second.listSkillExecutionsForSkill('friday-dca', '2026-05-08T20:01:00.000Z')).toEqual([]);

    await first.saveSkillInstall({
      ...sampleSkillInstall('skill_install_1', walletA, 'friday-dca'),
      status: 'revoked',
      updatedAt: '2026-05-08T20:02:00.000Z',
    });
    expect(await second.listActiveSkillInstalls()).toEqual([]);
  });

  it('runs the aggregator roll against Postgres-backed skills and evidence records', async () => {
    const client = new FakePgClient();
    const store = new PostgresWorkflowStore({ client });

    await store.saveSkillManifest(sampleSkillManifest('friday-dca'));
    await store.saveSkillInstall(sampleSkillInstall('skill_install_1', walletA, 'friday-dca'));
    await store.saveEvidence(walletA, sampleEvidence('evidence_1', walletA, { gasUsed: '0.001', pnl: '7.5' }));
    await store.saveSkillExecution(sampleSkillExecution('skill_exec_1', 'skill_install_1', walletA, 'friday-dca', {
      evidenceReceiptId: 'evidence_1',
    }));

    const result = await runAggregatorRoll({
      store,
      clock: { now: () => new Date('2026-05-08T21:00:00.000Z') },
    });
    const skill = await store.getAggregatorSnapshot('skill:friday-dca');
    const wallet = await store.getAggregatorSnapshot(`wallet:${walletA}`);

    expect(result).toEqual({ skillSnapshots: 1, walletSnapshots: 1 });
    expect(skill?.snapshot).toMatchObject({
      skillId: 'friday-dca',
      installs: 1,
      totalExecutions: 1,
      successRate: 1,
      medianGasUsd: '0.001',
    });
    expect(wallet?.snapshot).toMatchObject({
      walletAddress: walletA,
      totalExecutions: 1,
      totalGasUsd: '0.001',
      totalProfitUsd: '7.5',
    });
  });

  it('deletes Layer 2 workspace records and owned aggregator snapshots', async () => {
    const client = new FakePgClient();
    const store = new PostgresWorkflowStore({ client });
    const keptManifest = sampleSkillManifest('kept-skill');

    await store.saveSkillManifest(sampleSkillManifest('friday-dca'));
    await store.saveSkillManifest({
      ...keptManifest,
      authorWallet: walletB,
      manifest: {
        ...(keptManifest.manifest as Record<string, unknown>),
        authorWallet: walletB,
      },
    });
    await store.saveSkillInstall(sampleSkillInstall('skill_install_1', walletA, 'friday-dca'));
    await store.saveSkillExecution(sampleSkillExecution('skill_exec_1', 'skill_install_1', walletA, 'friday-dca'));
    await store.saveSignalFeed(signalFeedRecord('feed_1', walletA));
    await store.saveSignalFeed(signalFeedRecord('feed_keep', walletB));
    await store.saveSignalSubscription(signalSubscriptionRecord('sub_1', walletA, 'feed_keep'));
    await store.saveSignalEmission(signalEmissionRecord('emission_1', 'feed_1', walletA));
    await store.saveAggregatorSnapshot({
      key: `wallet:${walletA}`,
      kind: 'wallet',
      computedAt: '2026-05-08T21:00:00.000Z',
      snapshot: { walletAddress: walletA, totalExecutions: 1 },
    });
    await store.saveAggregatorSnapshot({
      key: 'skill:friday-dca',
      kind: 'skill',
      computedAt: '2026-05-08T21:00:00.000Z',
      snapshot: { skillId: 'friday-dca', totalExecutions: 1 },
    });
    await store.saveAggregatorSnapshot({
      key: 'skill:kept-skill',
      kind: 'skill',
      computedAt: '2026-05-08T21:00:00.000Z',
      snapshot: { skillId: 'kept-skill', totalExecutions: 1 },
    });

    const counts = await store.deleteCloudWorkspace(walletA);

    expect(counts).toMatchObject({
      skillManifests: 1,
      skillInstalls: 1,
      skillExecutions: 1,
      signalFeeds: 1,
      signalSubscriptions: 1,
      signalEmissions: 1,
      aggregatorSnapshots: 2,
    });
    expect(await store.getSkillManifest('friday-dca')).toBeUndefined();
    expect(await store.getSkillManifest('kept-skill')).toMatchObject({ authorWallet: walletB });
    expect(await store.listSkillInstallsForWallet(walletA)).toEqual([]);
    expect(await store.listSkillExecutionsByInstall('skill_install_1')).toEqual([]);
    expect(await store.listSignalFeedsByPublisher(walletA)).toEqual([]);
    expect(await store.listSignalFeedsByPublisher(walletB)).toHaveLength(1);
    expect(await store.listSignalSubscriptionsForFollower(walletA)).toEqual([]);
    expect(await store.listUndeliveredSignalEmissions()).toEqual([]);
    expect(await store.getAggregatorSnapshot(`wallet:${walletA}`)).toBeUndefined();
    expect(await store.getAggregatorSnapshot('skill:friday-dca')).toBeUndefined();
    expect(await store.getAggregatorSnapshot('skill:kept-skill')).toMatchObject({ key: 'skill:kept-skill' });
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

  it('maps active signal fanout approval conflicts to approval_exists', async () => {
    const store = new PostgresWorkflowStore({ client: new FakePgClient() });
    const metadata = {
      signalEmissionId: 'emission_1',
      signalSubscriptionId: 'sub_1',
    };

    await store.saveApproval(walletA, sampleApproval('approval_1', walletA, {
      planDraftId: undefined,
      metadata,
    }));

    await expect(store.saveApproval(walletA, sampleApproval('approval_2', walletA, {
      planDraftId: undefined,
      metadata,
    }))).rejects.toMatchObject({ code: 'approval_exists' });
    await expect(store.saveApproval(walletB, sampleApproval('approval_3', walletB, {
      planDraftId: undefined,
      metadata,
    }))).resolves.toBeUndefined();
    await expect(store.saveApproval(walletA, sampleApproval('approval_4', walletA, {
      planDraftId: undefined,
      metadata,
      status: 'rejected',
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

  it('persists signal feeds, subscriptions, and queued emissions across store instances', async () => {
    const client = new FakePgClient();
    const first = new PostgresWorkflowStore({ client });
    const second = new PostgresWorkflowStore({ client });

    await first.saveSignalFeed(signalFeedRecord('feed_1', walletA));

    expect(await second.getSignalFeed('feed_1')).toMatchObject({
      id: 'feed_1',
      publisherWallet: walletA,
    });
    expect((await second.listSignalFeedsByPublisher(walletA)).map((feed) => feed.id)).toEqual(['feed_1']);
    expect(await second.listSignalFeedsByPublisher(walletB)).toEqual([]);

    await first.saveSignalSubscription(signalSubscriptionRecord('sub_1', walletB, 'feed_1'));
    expect((await second.listSignalSubscriptionsForFollower(walletB)).map((sub) => sub.id)).toEqual(['sub_1']);
    expect((await second.listSignalSubscriptionsForFeed('feed_1')).map((sub) => sub.id)).toEqual(['sub_1']);

    await first.saveSignalEmission(signalEmissionRecord('emission_1', 'feed_1', walletA));
    expect((await second.listUndeliveredSignalEmissions()).map((emission) => emission.id)).toEqual(['emission_1']);

    await second.markSignalEmissionFanoutProcessed('emission_1', 1, '2026-05-08T20:05:00.000Z');
    expect(await first.listUndeliveredSignalEmissions()).toEqual([]);
    expect(client.signalEmissions.get('emission_1')).toMatchObject({
      delivered: 1,
      fanoutProcessedAt: '2026-05-08T20:05:00.000Z',
    });
  });

  it('keeps revoked signal subscription history while allowing a fresh subscription row', async () => {
    const client = new FakePgClient();
    const store = new PostgresWorkflowStore({ client });

    await store.saveSignalSubscription(signalSubscriptionRecord('sub_old', walletB, 'feed_1', 'revoked'));
    await store.saveSignalSubscription(signalSubscriptionRecord('sub_new', walletB, 'feed_1', 'active'));

    expect((await store.listSignalSubscriptionsForFollower(walletB)).map((sub) => sub.id).sort()).toEqual([
      'sub_new',
      'sub_old',
    ]);
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

function testSignalFanoutMetadataField(
  record: ApprovalRequestRecord,
  key: 'signalEmissionId' | 'signalSubscriptionId',
): string | undefined {
  const value = record.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

class FakePgClient implements PgClient {
  readonly nonces = new Map<string, Record<string, unknown>>();
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly plans = new Map<string, JsonRow<PlanDraftRecord>>();
  readonly approvals = new Map<string, JsonRow<ApprovalRequestRecord>>();
  readonly schedules = new Map<string, JsonRow<ReturnType<typeof scheduleRecord>>>();
  readonly occurrences = new Map<string, JsonRow<RecurringOccurrenceRecord>>();
  readonly evidence = new Map<string, JsonRow<EvidenceReceiptRecord>>();
  readonly skillManifests = new Map<string, SkillManifestStoreRecord>();
  readonly skillInstalls = new Map<string, SkillInstallStoreRecord>();
  readonly skillExecutions = new Map<string, SkillExecutionStoreRecord>();
  readonly signalFeeds = new Map<string, SignalFeedStoreRecord>();
  readonly signalSubscriptions = new Map<string, SignalSubscriptionStoreRecord>();
  readonly signalEmissions = new Map<string, SignalEmissionStoreRecord>();
  readonly aggregatorSnapshots = new Map<string, {
    key: string;
    kind: string;
    computed_at: string;
    record: unknown;
  }>();
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
      case 'BEGIN':
      case 'COMMIT':
      case 'ROLLBACK':
        return result([]);

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

      case 'evidence.upsert': {
        const record = JSON.parse(String(values[6])) as EvidenceReceiptRecord;
        this.evidence.set(record.id, {
          id: record.id,
          wallet_address: String(values[1]),
          status: String(values[3]),
          created_at: String(values[4]),
          updated_at: String(values[5]),
          record,
        });
        return result([]);
      }

      case 'evidence.get': {
        const row = this.evidence.get(String(values[1]));
        return result(row && row.wallet_address === values[0] ? [{ record: cloneTest(row.record) }] : []);
      }

      case 'skill.manifest.upsert': {
        const record = JSON.parse(String(values[5])) as SkillManifestStoreRecord;
        this.skillManifests.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'skill.manifest.get': {
        const row = this.skillManifests.get(String(values[0]));
        return result(row ? [{ record: cloneTest(row) }] : []);
      }

      case 'skill.manifest.list':
        return result([...this.skillManifests.values()].map((row) => ({ record: cloneTest(row) })));

      case 'cloudWorkspace.skillManifests.listAuthoredIds':
        return result([...this.skillManifests.values()]
          .filter((row) => row.authorWallet === values[0])
          .map((row) => ({ id: row.id })));

      case 'skill.install.upsert': {
        const record = JSON.parse(String(values[6])) as SkillInstallStoreRecord;
        this.skillInstalls.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'skill.install.get': {
        const row = this.skillInstalls.get(String(values[0]));
        return result(row ? [{ record: cloneTest(row) }] : []);
      }

      case 'skill.install.listForWallet':
        return result([...this.skillInstalls.values()]
          .filter((row) => row.walletAddress === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'skill.install.listActive':
        return result([...this.skillInstalls.values()]
          .filter((row) => row.status === 'active')
          .map((row) => ({ record: cloneTest(row) })));

      case 'skill.execution.upsert': {
        const record = JSON.parse(String(values[8])) as SkillExecutionStoreRecord;
        this.skillExecutions.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'skill.execution.listByInstall':
        return result([...this.skillExecutions.values()]
          .filter((row) => row.installId === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'skill.execution.listForSkill':
        return result([...this.skillExecutions.values()]
          .filter((row) => row.skillId === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'skill.execution.listForSkillSince': {
        const sinceMs = Date.parse(String(values[1]));
        return result([...this.skillExecutions.values()]
          .filter((row) => row.skillId === values[0])
          .filter((row) => Date.parse(row.proposedAt) >= sinceMs)
          .map((row) => ({ record: cloneTest(row) })));
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
        const signalEmissionId = testSignalFanoutMetadataField(record, 'signalEmissionId');
        const signalSubscriptionId = testSignalFanoutMetadataField(record, 'signalSubscriptionId');
        const duplicateSignalFanout = signalEmissionId && signalSubscriptionId && isActiveApprovalStatusForIndex(record.status)
          ? [...this.approvals.values()].find((entry) => {
            return entry.wallet_address === values[1] &&
              entry.id !== record.id &&
              testSignalFanoutMetadataField(entry.record, 'signalEmissionId') === signalEmissionId &&
              testSignalFanoutMetadataField(entry.record, 'signalSubscriptionId') === signalSubscriptionId &&
              isActiveApprovalStatusForIndex(entry.record.status);
          })
          : undefined;
        if (duplicateSignalFanout) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "approval_requests_active_signal_fanout_idx"'), {
            code: '23505',
            constraint: 'approval_requests_active_signal_fanout_idx',
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

      case 'signal.feed.upsert': {
        const record = JSON.parse(String(values[6])) as SignalFeedStoreRecord;
        this.signalFeeds.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'signal.feed.get': {
        const row = this.signalFeeds.get(String(values[0]));
        return result(row ? [{ record: cloneTest(row) }] : []);
      }

      case 'signal.feed.listByPublisher':
        return result([...this.signalFeeds.values()]
          .filter((row) => row.publisherWallet === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'signal.subscription.upsert': {
        const record = JSON.parse(String(values[6])) as SignalSubscriptionStoreRecord;
        this.signalSubscriptions.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'signal.subscription.listForFollower':
        return result([...this.signalSubscriptions.values()]
          .filter((row) => row.followerWallet === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'signal.subscription.listForFeed':
        return result([...this.signalSubscriptions.values()]
          .filter((row) => row.feedId === values[0])
          .map((row) => ({ record: cloneTest(row) })));

      case 'signal.emission.upsert': {
        const record = JSON.parse(String(values[7])) as SignalEmissionStoreRecord;
        this.signalEmissions.set(record.id, cloneTest(record));
        return result([]);
      }

      case 'signal.emission.listUndelivered': {
        const limit = Number(values[0]);
        return result([...this.signalEmissions.values()]
          .filter((row) => !row.fanoutProcessedAt)
          .slice(0, limit)
          .map((row) => ({ record: cloneTest(row) })));
      }

      case 'signal.emission.markFanoutProcessed': {
        const row = this.signalEmissions.get(String(values[0]));
        if (!row) return result([]);
        const delivered = Number(values[1]);
        const fanoutProcessedAt = String(values[2]);
        const emission = row.emission && typeof row.emission === 'object' && !Array.isArray(row.emission)
          ? { ...(row.emission as Record<string, unknown>), delivered, fanoutProcessedAt }
          : row.emission;
        this.signalEmissions.set(row.id, cloneTest({ ...row, delivered, fanoutProcessedAt, emission }));
        return result([]);
      }

      case 'aggregator.upsert': {
        const record = JSON.parse(String(values[3])) as unknown;
        this.aggregatorSnapshots.set(String(values[0]), {
          key: String(values[0]),
          kind: String(values[1]),
          computed_at: String(values[2]),
          record,
        });
        return result([]);
      }

      case 'aggregator.get': {
        const row = this.aggregatorSnapshots.get(String(values[0]));
        return result(row ? [cloneTest(row)] : []);
      }

      case 'aggregator.listByKind':
        return result([...this.aggregatorSnapshots.values()]
          .filter((row) => row.kind === values[0])
          .map((row) => cloneTest(row)));

      case 'cloudWorkspace.preferences.delete':
        return countResult(deleteMapEntries(this.preferences, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.recurringNotifications.delete':
      case 'cloudWorkspace.finalizations.delete':
      case 'cloudWorkspace.completed.delete':
      case 'cloudWorkspace.audit.delete':
      case 'cloudWorkspace.users.delete':
        return countResult(0);

      case 'cloudWorkspace.recurringOccurrences.delete':
        return countResult(deleteMapEntries(this.occurrences, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.recurringSchedules.delete':
        return countResult(deleteMapEntries(this.schedules, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.evidence.delete':
        return countResult(deleteMapEntries(this.evidence, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.approvals.delete':
        return countResult(deleteMapEntries(this.approvals, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.plans.delete':
        return countResult(deleteMapEntries(this.plans, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.nonces.delete':
        return countResult(deleteMapEntries(this.nonces, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.sessions.delete':
        return countResult(deleteMapEntries(this.sessions, (row) => row.wallet_address === values[0]));

      case 'cloudWorkspace.skillInstalls.delete':
        return countResult(deleteMapEntries(this.skillInstalls, (row) => row.walletAddress === values[0]));

      case 'cloudWorkspace.skillExecutions.delete':
        return countResult(deleteMapEntries(this.skillExecutions, (row) => row.walletAddress === values[0]));

      case 'cloudWorkspace.signalSubscriptions.delete':
        return countResult(deleteMapEntries(this.signalSubscriptions, (row) => row.followerWallet === values[0]));

      case 'cloudWorkspace.signalEmissions.delete':
        return countResult(deleteMapEntries(this.signalEmissions, (row) => row.publisherWallet === values[0]));

      case 'cloudWorkspace.signalFeeds.delete':
        return countResult(deleteMapEntries(this.signalFeeds, (row) => row.publisherWallet === values[0]));

      case 'cloudWorkspace.skillManifests.delete':
        return countResult(deleteMapEntries(this.skillManifests, (row) => row.authorWallet === values[0]));

      case 'cloudWorkspace.aggregatorSnapshots.delete': {
        const keys = new Set((values[0] as string[]).map(String));
        return countResult(deleteMapEntries(this.aggregatorSnapshots, (row) => keys.has(row.key)));
      }

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

function countResult<R extends QueryResultRow>(rowCount: number): QueryResult<R> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rowCount,
    rows: [],
  };
}

function deleteMapEntries<K, V>(
  map: Map<K, V>,
  predicate: (value: V, key: K) => boolean,
): number {
  let deleted = 0;
  for (const [key, value] of map) {
    if (predicate(value, key)) {
      map.delete(key);
      deleted += 1;
    }
  }
  return deleted;
}

function cloneTest<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function signalFeedRecord(id: string, publisherWallet: string): SignalFeedStoreRecord {
  const now = '2026-05-08T20:00:00.000Z';
  return {
    id,
    publisherWallet,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    feed: {
      id,
      publisherWallet,
      name: 'Signals',
      description: 'Receipt-backed calls',
      createdAt: now,
      updatedAt: now,
      status: 'active',
    },
  };
}

function signalSubscriptionRecord(
  id: string,
  followerWallet: string,
  feedId: string,
  status: SignalSubscriptionStoreRecord['status'] = 'active',
): SignalSubscriptionStoreRecord {
  const now = '2026-05-08T20:00:00.000Z';
  return {
    id,
    followerWallet,
    feedId,
    status,
    subscribedAt: now,
    updatedAt: now,
    subscription: {
      id,
      followerWallet,
      feedId,
      status,
      subscribedAt: now,
      updatedAt: now,
      caps: {
        perRunMaxAmount: '200',
        lifetimeMaxAmount: '1000',
        allowlistedTokens: ['USDC'],
      },
    },
  };
}

function signalEmissionRecord(
  id: string,
  feedId: string,
  publisherWallet: string,
): SignalEmissionStoreRecord {
  const emittedAt = '2026-05-08T20:00:00.000Z';
  return {
    id,
    feedId,
    publisherWallet,
    emittedAt,
    delivered: 0,
    emission: {
      id,
      feedId,
      publisherWallet,
      emittedAt,
      sourceTxid: '5'.repeat(64),
      actionTemplate: {
        connectorAction: 'swap',
        inputToken: 'USDC',
        outputToken: 'SOL',
        amount: '100',
      },
      delivered: 0,
    },
  };
}

function sampleSkillManifest(id: string): SkillManifestStoreRecord {
  const now = '2026-05-08T20:00:00.000Z';
  return {
    id,
    version: '1.0.0',
    authorWallet: walletA,
    createdAt: now,
    updatedAt: now,
    manifest: {
      id,
      name: 'Friday DCA',
      version: '1.0.0',
      authorWallet: walletA,
      description: 'Buy SOL every Friday.',
      category: 'dca',
      schedule: { kind: 'cron', spec: '0 14 * * 5' },
      action: { connectorAction: 'prepare_swap', paramsTemplate: {} },
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '2600',
        allowlistedTokens: ['USDC', 'SOL'],
      },
    },
  };
}

function sampleSkillInstall(
  id: string,
  walletAddress: string,
  skillId: string,
): SkillInstallStoreRecord {
  const now = '2026-05-08T20:00:00.000Z';
  return {
    id,
    walletAddress,
    skillId,
    status: 'active',
    installedAt: now,
    updatedAt: now,
    install: {
      id,
      walletAddress,
      skillId,
      manifestVersion: '1.0.0',
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '2600',
        allowlistedTokens: ['USDC', 'SOL'],
      },
      installedAt: now,
      updatedAt: now,
      status: 'active',
    },
  };
}

function sampleSkillExecution(
  id: string,
  installId: string,
  walletAddress: string,
  skillId: string,
  overrides: Partial<SkillExecutionStoreRecord> = {},
): SkillExecutionStoreRecord {
  const proposedAt = '2026-05-08T20:00:00.000Z';
  return {
    id,
    installId,
    walletAddress,
    skillId,
    proposedAt,
    result: 'success',
    approvalRequestId: `approval_${id}`,
    execution: {
      id,
      installId,
      walletAddress,
      skillId,
      proposedAt,
      result: 'success',
      approvalRequestId: `approval_${id}`,
    },
    ...overrides,
  };
}

function sampleEvidence(
  id: string,
  walletAddress: string,
  metadata: NonNullable<EvidenceReceiptRecord['metadata']>,
): EvidenceReceiptRecord {
  return {
    id,
    walletAddress,
    title: 'Skill execution receipt',
    kind: 'review_proof',
    status: 'approved',
    payload: {},
    preSignatureHash: `pre_${id}`,
    signingMessage: `msg_${id}`,
    signature: `sig_${id}`,
    verified: true,
    artifactHash: `pre_${id}`,
    createdAt: '2026-05-08T20:00:00.000Z',
    updatedAt: '2026-05-08T20:00:00.000Z',
    metadata,
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
