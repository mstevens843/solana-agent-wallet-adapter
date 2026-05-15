import pg from 'pg';
import type { PoolConfig, QueryConfig, QueryResult, QueryResultRow } from 'pg';

import type {
  EvidenceAuditEvent,
  EvidenceReceiptRecord,
  EvidenceStore,
} from './evidenceService.js';
import { postgresMigrations } from './migrations/index.js';
import type {
  RecurringNotificationDeliveryRecord,
  RecurringNotificationStore,
} from './notificationService.js';
import type {
  RecurringAuditEvent,
  RecurringOccurrenceClaim,
  RecurringOccurrenceRecord,
  RecurringScheduleRecord,
  RecurringStore,
} from './recurringService.js';
import type {
  AggregatorSnapshotStoreRecord,
  AggregatorStore,
  CloudPreferenceNamespace,
  CloudPreferenceRecord,
  CloudPreferencesStore,
  CloudWorkspaceDeleteCounts,
  CloudWorkspaceDeleteStore,
  AuditEventRecord,
  AuthNonceRecord,
  SignalEmissionStoreRecord,
  SignalFeedStoreRecord,
  SignalSubscriptionStoreRecord,
  SignalsStore,
  SkillExecutionStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
  SkillsStore,
  WalletScopedWorkflowStore,
  WalletSessionRecord,
  WorkflowStore as SessionWorkflowStore,
} from './store.js';
import { emptyCloudWorkspaceDeleteCounts } from './store.js';
import type { WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';
import type {
  ApprovalRequestRecord,
  AuditEventRecord as WorkflowAuditEventRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
  TransactionFinalizationRecord,
} from './workflowValidation.js';

const { Pool } = pg;
const ACTIVE_APPROVAL_PLAN_DRAFT_INDEX = 'approval_requests_active_plan_draft_idx';
const ACTIVE_APPROVAL_RECURRING_OCCURRENCE_INDEX = 'approval_requests_active_recurring_occurrence_idx';
const ACTIVE_APPROVAL_SIGNAL_FANOUT_INDEX = 'approval_requests_active_signal_fanout_idx';

export interface PgClient {
  query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>>;
  end?(): Promise<void>;
  release?(): void;
}

export interface PgConnection extends PgClient {
  release(): void;
}

interface PgConnectableClient extends PgClient {
  connect(): Promise<PgConnection>;
}

export interface PostgresWorkflowStoreOptions {
  connectionString?: string;
  client?: PgClient;
  maxConnections?: number;
}

interface JsonRecordRow<T> extends QueryResultRow {
  record: T | string;
}

interface AuthNonceRow extends QueryResultRow {
  nonce: string;
  wallet_address: string;
  domain: string;
  issued_at: Date | string;
  expires_at: Date | string;
  message: string;
  created_at: Date | string;
  consumed_at: Date | string | null;
}

interface SessionRow extends QueryResultRow {
  token_hash: string;
  wallet_address: string;
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
}

interface AuditEventRow extends QueryResultRow {
  id: string;
  wallet_address: string;
  type: string;
  created_at: Date | string;
  metadata: Record<string, unknown> | string | null;
}

interface WalletRow extends QueryResultRow {
  wallet_address: string;
}

interface PreferenceRow extends QueryResultRow {
  namespace: string;
  payload: unknown | string;
  updated_at: Date | string;
  version: number | string;
}

interface AggregatorSnapshotRow extends QueryResultRow {
  key: string;
  kind: string;
  computed_at: Date | string;
  record: AggregatorSnapshotStoreRecord | string;
}

interface SignalFeedRecordRow extends QueryResultRow {
  record: SignalFeedStoreRecord | string;
}

interface SignalSubscriptionRecordRow extends QueryResultRow {
  record: SignalSubscriptionStoreRecord | string;
}

interface SignalEmissionRecordRow extends QueryResultRow {
  record: SignalEmissionStoreRecord | string;
}

interface SkillIdRow extends QueryResultRow {
  id: string;
}

export class PostgresWorkflowStore implements
  SessionWorkflowStore,
  OneTimeWorkflowStore,
  EvidenceStore,
  RecurringStore,
  RecurringNotificationStore,
  CloudWorkspaceDeleteStore,
  CloudPreferencesStore,
  SkillsStore,
  SignalsStore,
  AggregatorStore {
  private readonly client: PgClient;
  private readonly ownsClient: boolean;

  constructor(options: PostgresWorkflowStoreOptions = {}) {
    if (options.client) {
      this.client = options.client;
      this.ownsClient = false;
      return;
    }

    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for PostgresWorkflowStore.');
    }

    this.client = new Pool({
      connectionString,
      max: options.maxConnections ?? envInteger('DATABASE_POOL_SIZE', 5),
      ...postgresSslConfig(connectionString),
    } satisfies PoolConfig);
    this.ownsClient = true;
  }

  async migrate(): Promise<void> {
    const client = await this.checkoutClient();
    await client.query({ text: 'BEGIN' });
    try {
      await client.query({ text: 'SELECT pg_advisory_xact_lock(1788732421, 424242)' });
      await client.query({
        text: `
          CREATE TABLE IF NOT EXISTS agentic_migrations (
            id TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `,
      });

      for (const migration of postgresMigrations) {
        const existing = await client.query({
          name: 'migration.get',
          text: 'SELECT id FROM agentic_migrations WHERE id = $1',
          values: [migration.id],
        });
        if (existing.rowCount === 0) {
          await client.query({ text: migration.sql });
          await client.query({
            name: 'migration.insert',
            text: 'INSERT INTO agentic_migrations (id) VALUES ($1)',
            values: [migration.id],
          });
        }
      }
      await client.query({ text: 'COMMIT' });
    } catch (err) {
      await client.query({ text: 'ROLLBACK' });
      throw err;
    } finally {
      client.release?.();
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.end) {
      await this.client.end();
    }
  }

  async cleanupExpired(nowIso = new Date().toISOString()): Promise<void> {
    await this.query({
      name: 'sessions.cleanup',
      text: 'DELETE FROM wallet_sessions WHERE revoked_at IS NOT NULL OR expires_at <= $1',
      values: [nowIso],
    });
    await this.query({
      name: 'nonces.cleanup',
      text: 'DELETE FROM nonces WHERE consumed_at IS NOT NULL OR expires_at <= $1',
      values: [nowIso],
    });
  }

  async createAuthNonce(record: AuthNonceRecord): Promise<void> {
    await this.cleanupExpired(record.createdAt);
    await this.query({
      name: 'nonce.upsert',
      text: `
        INSERT INTO nonces (
          nonce, wallet_address, domain, issued_at, expires_at, message, created_at, consumed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (nonce) DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          domain = EXCLUDED.domain,
          issued_at = EXCLUDED.issued_at,
          expires_at = EXCLUDED.expires_at,
          message = EXCLUDED.message,
          created_at = EXCLUDED.created_at,
          consumed_at = EXCLUDED.consumed_at
      `,
      values: [
        record.nonce,
        record.walletAddress,
        record.domain,
        record.issuedAt,
        record.expiresAt,
        record.message,
        record.createdAt,
        record.consumedAt ?? null,
      ],
    });
  }

  async getAuthNonce(nonce: string): Promise<AuthNonceRecord | undefined> {
    const result = await this.query<AuthNonceRow>({
      name: 'nonce.get',
      text: 'SELECT * FROM nonces WHERE nonce = $1',
      values: [nonce],
    });
    return result.rows[0] ? nonceFromRow(result.rows[0]) : undefined;
  }

  async consumeAuthNonce(nonce: string, consumedAt: string): Promise<AuthNonceRecord | undefined> {
    const result = await this.query<AuthNonceRow>({
      name: 'nonce.consume',
      text: `
        UPDATE nonces
        SET consumed_at = $2
        WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > $2
        RETURNING *
      `,
      values: [nonce, consumedAt],
    });
    return result.rows[0] ? nonceFromRow(result.rows[0]) : undefined;
  }

  async createSession(record: WalletSessionRecord): Promise<void> {
    await this.cleanupExpired(record.createdAt);
    await this.ensureUser(record.walletAddress, record.createdAt, record.lastSeenAt);
    await this.query({
      name: 'session.upsert',
      text: `
        INSERT INTO wallet_sessions (
          token_hash, wallet_address, created_at, expires_at, last_seen_at, revoked_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (token_hash) DO UPDATE SET
          wallet_address = EXCLUDED.wallet_address,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          last_seen_at = EXCLUDED.last_seen_at,
          revoked_at = EXCLUDED.revoked_at
      `,
      values: [
        record.tokenHash,
        record.walletAddress,
        record.createdAt,
        record.expiresAt,
        record.lastSeenAt,
        record.revokedAt ?? null,
      ],
    });
  }

  async getSession(tokenHash: string): Promise<WalletSessionRecord | undefined> {
    const result = await this.query<SessionRow>({
      name: 'session.get',
      text: 'SELECT * FROM wallet_sessions WHERE token_hash = $1',
      values: [tokenHash],
    });
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    const result = await this.query<SessionRow>({
      name: 'session.touch',
      text: `
        UPDATE wallet_sessions
        SET last_seen_at = $2
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING *
      `,
      values: [tokenHash, lastSeenAt],
    });
    const session = result.rows[0];
    if (session) {
      await this.ensureUser(session.wallet_address, session.created_at, lastSeenAt);
    }
  }

  async deleteSession(tokenHash: string, revokedAt: string): Promise<void> {
    await this.query({
      name: 'session.revoke',
      text: 'UPDATE wallet_sessions SET revoked_at = $2 WHERE token_hash = $1',
      values: [tokenHash, revokedAt],
    });
  }

  forWallet(walletAddress: string): WalletScopedWorkflowStore {
    return {
      walletAddress,
      insertAuditEvent: async (event) => {
        const record = { ...event, walletAddress };
        await this.insertAuditEvent(record);
        return clone(record);
      },
      listAuditEvents: async () => this.listAuditEvents(walletAddress),
    };
  }

  async listPlans(walletAddress: string): Promise<PlanDraftRecord[]> {
    return this.listJsonRecords<PlanDraftRecord>('plan.list', 'plans', walletAddress, 'updated_at DESC, created_at DESC');
  }

  async getPlan(walletAddress: string, id: string): Promise<PlanDraftRecord | undefined> {
    return this.getJsonRecord<PlanDraftRecord>('plan.get', 'plans', walletAddress, id);
  }

  async savePlan(walletAddress: string, record: PlanDraftRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'plan.upsert',
      text: `
        INSERT INTO plans (id, wallet_address, status, created_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE plans.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.status,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async deletePlan(walletAddress: string, id: string): Promise<boolean> {
    return this.deleteByOwner('plan.delete', 'plans', walletAddress, id);
  }

  async listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]> {
    return this.listJsonRecords<ApprovalRequestRecord>('approval.list', 'approval_requests', walletAddress, 'updated_at DESC, created_at DESC');
  }

  async listApprovalsByIds(walletAddress: string, ids: string[]): Promise<ApprovalRequestRecord[]> {
    if (ids.length === 0) return [];
    const result = await this.query<JsonRecordRow<ApprovalRequestRecord>>({
      name: 'approval.listByIds',
      text: `
        SELECT record
        FROM approval_requests
        WHERE wallet_address = $1 AND id = ANY($2::text[])
        ORDER BY updated_at DESC, created_at DESC
      `,
      values: [walletAddress, ids],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listApprovalsByRecurringOccurrenceIds(
    walletAddress: string,
    occurrenceIds: string[],
  ): Promise<ApprovalRequestRecord[]> {
    if (occurrenceIds.length === 0) return [];
    const result = await this.query<JsonRecordRow<ApprovalRequestRecord>>({
      name: 'approval.listByRecurringOccurrenceIds',
      text: `
        SELECT record
        FROM approval_requests
        WHERE wallet_address = $1
          AND record->>'recurringOccurrenceId' = ANY($2::text[])
        ORDER BY updated_at DESC, created_at DESC
      `,
      values: [walletAddress, occurrenceIds],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined> {
    return this.getJsonRecord<ApprovalRequestRecord>('approval.get', 'approval_requests', walletAddress, id);
  }

  async saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    try {
      await this.query({
        name: 'approval.upsert',
        text: `
          INSERT INTO approval_requests (id, wallet_address, status, due_at, created_at, updated_at, record)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            due_at = EXCLUDED.due_at,
            updated_at = EXCLUDED.updated_at,
            record = EXCLUDED.record
          WHERE approval_requests.wallet_address = EXCLUDED.wallet_address
        `,
        values: [
          normalized.id,
          walletAddress,
          normalized.status,
          normalized.dueAt,
          normalized.createdAt,
          normalized.updatedAt,
          jsonParam(normalized),
        ],
      });
    } catch (err) {
      if (
        isPgUniqueViolation(err, ACTIVE_APPROVAL_PLAN_DRAFT_INDEX) ||
        isPgUniqueViolation(err, ACTIVE_APPROVAL_RECURRING_OCCURRENCE_INDEX) ||
        isPgUniqueViolation(err, ACTIVE_APPROVAL_SIGNAL_FANOUT_INDEX)
      ) {
        throw approvalExistsError();
      }
      throw err;
    }
  }

  async listCompleted(walletAddress: string): Promise<CompletedRecord[]> {
    return this.listJsonRecords<CompletedRecord>('completed.list', 'completed_records', walletAddress, 'completed_at DESC, created_at DESC');
  }

  async listCompletedByIds(walletAddress: string, ids: string[]): Promise<CompletedRecord[]> {
    if (ids.length === 0) return [];
    const result = await this.query<JsonRecordRow<CompletedRecord>>({
      name: 'completed.listByIds',
      text: `
        SELECT record
        FROM completed_records
        WHERE wallet_address = $1 AND id = ANY($2::text[])
        ORDER BY completed_at DESC, created_at DESC
      `,
      values: [walletAddress, ids],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listCompletedByRecurringOccurrenceIds(
    walletAddress: string,
    occurrenceIds: string[],
  ): Promise<CompletedRecord[]> {
    if (occurrenceIds.length === 0) return [];
    const result = await this.query<JsonRecordRow<CompletedRecord>>({
      name: 'completed.listByRecurringOccurrenceIds',
      text: `
        SELECT record
        FROM completed_records
        WHERE wallet_address = $1
          AND record->>'recurringOccurrenceId' = ANY($2::text[])
        ORDER BY completed_at DESC, created_at DESC
      `,
      values: [walletAddress, occurrenceIds],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async getCompleted(walletAddress: string, id: string): Promise<CompletedRecord | undefined> {
    return this.getJsonRecord<CompletedRecord>('completed.get', 'completed_records', walletAddress, id);
  }

  async saveCompleted(walletAddress: string, record: CompletedRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'completed.upsert',
      text: `
        INSERT INTO completed_records (id, wallet_address, kind, status, created_at, completed_at, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          completed_at = EXCLUDED.completed_at,
          record = EXCLUDED.record
        WHERE completed_records.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.kind,
        normalized.status,
        normalized.createdAt,
        normalized.completedAt,
        jsonParam(normalized),
      ],
    });
  }

  async deleteCompleted(walletAddress: string, id: string): Promise<boolean> {
    return this.deleteByOwner('completed.delete', 'completed_records', walletAddress, id);
  }

  async listFinalizations(walletAddress: string, approvalRequestId?: string): Promise<TransactionFinalizationRecord[]> {
    if (!approvalRequestId) {
      return this.listJsonRecords<TransactionFinalizationRecord>(
        'finalization.list',
        'transaction_finalizations',
        walletAddress,
        'updated_at DESC, created_at DESC',
      );
    }
    const result = await this.query<JsonRecordRow<TransactionFinalizationRecord>>({
      name: 'finalization.listForApproval',
      text: `
        SELECT record
        FROM transaction_finalizations
        WHERE wallet_address = $1 AND approval_request_id = $2
        ORDER BY updated_at DESC, created_at DESC
      `,
      values: [walletAddress, approvalRequestId],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async getFinalization(walletAddress: string, id: string): Promise<TransactionFinalizationRecord | undefined> {
    return this.getJsonRecord<TransactionFinalizationRecord>('finalization.get', 'transaction_finalizations', walletAddress, id);
  }

  async saveFinalization(walletAddress: string, record: TransactionFinalizationRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'finalization.upsert',
      text: `
        INSERT INTO transaction_finalizations (
          id, wallet_address, approval_request_id, status, expires_at, created_at, updated_at, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          approval_request_id = EXCLUDED.approval_request_id,
          status = EXCLUDED.status,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE transaction_finalizations.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.approvalRequestId,
        normalized.status,
        normalized.expiresAt,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async appendAuditEvent(walletAddress: string, record: WorkflowAuditEventRecord | RecurringAuditEvent): Promise<void> {
    if ('scheduleId' in record) {
      await this.insertAuditEvent({
        id: record.id,
        walletAddress,
        type: record.type,
        createdAt: record.createdAt,
        metadata: recurringAuditMetadata(record),
      });
      return;
    }

    await this.insertAuditEvent({
      id: record.id,
      walletAddress,
      type: record.eventType ?? record.type,
      createdAt: record.createdAt,
      metadata: {
        ...record.metadata,
        ...(record.actor ? { actor: record.actor } : {}),
        ...(record.eventType ? { eventType: record.eventType } : {}),
        ...(record.recordType ? { recordType: record.recordType } : {}),
        ...(record.recordId ? { recordId: record.recordId } : {}),
        ...(record.subjectType ? { subjectType: record.subjectType } : {}),
        ...(record.subjectId ? { subjectId: record.subjectId } : {}),
        ...(record.outcome ? { outcome: record.outcome } : {}),
      },
    });
  }

  async listEvidence(walletAddress: string): Promise<EvidenceReceiptRecord[]> {
    return this.listJsonRecords<EvidenceReceiptRecord>('evidence.list', 'evidence_receipts', walletAddress, 'updated_at DESC, created_at DESC');
  }

  async getEvidence(walletAddress: string, id: string): Promise<EvidenceReceiptRecord | undefined> {
    return this.getJsonRecord<EvidenceReceiptRecord>('evidence.get', 'evidence_receipts', walletAddress, id);
  }

  async saveEvidence(walletAddress: string, record: EvidenceReceiptRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'evidence.upsert',
      text: `
        INSERT INTO evidence_receipts (id, wallet_address, kind, status, created_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE evidence_receipts.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.kind,
        normalized.status,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async deleteEvidence(walletAddress: string, id: string): Promise<boolean> {
    return this.deleteByOwner('evidence.delete', 'evidence_receipts', walletAddress, id);
  }

  async deleteAllEvidence(walletAddress: string): Promise<number> {
    return this.deleteByWallet('evidence.deleteAll', 'evidence_receipts', walletAddress);
  }

  async appendEvidenceAuditEvent(walletAddress: string, event: EvidenceAuditEvent): Promise<void> {
    await this.insertAuditEvent({
      id: event.id,
      walletAddress,
      type: event.type,
      createdAt: event.createdAt,
      metadata: {
        ...event.metadata,
        recordType: event.recordType,
        recordId: event.recordId,
      },
    });
  }

  // ── SkillsStore ──
  async saveSkillManifest(record: SkillManifestStoreRecord): Promise<SkillManifestStoreRecord> {
    await this.query({
      name: 'skill.manifest.upsert',
      text: `
        INSERT INTO skill_manifests (id, version, author_wallet, created_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          version = EXCLUDED.version,
          author_wallet = EXCLUDED.author_wallet,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
      `,
      values: [
        record.id,
        record.version,
        record.authorWallet,
        record.createdAt,
        record.updatedAt,
        jsonParam(record),
      ],
    });
    return record;
  }

  async getSkillManifest(skillId: string): Promise<SkillManifestStoreRecord | undefined> {
    const result = await this.query<JsonRecordRow<SkillManifestStoreRecord>>({
      name: 'skill.manifest.get',
      text: 'SELECT record FROM skill_manifests WHERE id = $1',
      values: [skillId],
    });
    const row = result.rows[0];
    return row ? jsonRecord(row.record) : undefined;
  }

  async listSkillManifests(): Promise<SkillManifestStoreRecord[]> {
    const result = await this.query<JsonRecordRow<SkillManifestStoreRecord>>({
      name: 'skill.manifest.list',
      text: 'SELECT record FROM skill_manifests ORDER BY updated_at DESC, id ASC',
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async saveSkillInstall(record: SkillInstallStoreRecord): Promise<SkillInstallStoreRecord> {
    await this.ensureUser(record.walletAddress, record.installedAt);
    await this.query({
      name: 'skill.install.upsert',
      text: `
        INSERT INTO skill_installs (id, wallet_address, skill_id, status, installed_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE skill_installs.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        record.id,
        record.walletAddress,
        record.skillId,
        record.status,
        record.installedAt,
        record.updatedAt,
        jsonParam(record),
      ],
    });
    return record;
  }

  async getSkillInstall(installId: string): Promise<SkillInstallStoreRecord | undefined> {
    const result = await this.query<JsonRecordRow<SkillInstallStoreRecord>>({
      name: 'skill.install.get',
      text: 'SELECT record FROM skill_installs WHERE id = $1',
      values: [installId],
    });
    const row = result.rows[0];
    return row ? jsonRecord(row.record) : undefined;
  }

  async listSkillInstallsForWallet(walletAddress: string): Promise<SkillInstallStoreRecord[]> {
    const result = await this.query<JsonRecordRow<SkillInstallStoreRecord>>({
      name: 'skill.install.listForWallet',
      text: 'SELECT record FROM skill_installs WHERE wallet_address = $1 ORDER BY installed_at DESC, updated_at DESC',
      values: [walletAddress],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listActiveSkillInstalls(): Promise<SkillInstallStoreRecord[]> {
    const result = await this.query<JsonRecordRow<SkillInstallStoreRecord>>({
      name: 'skill.install.listActive',
      text: "SELECT record FROM skill_installs WHERE status = 'active' ORDER BY installed_at DESC, updated_at DESC",
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async saveSkillExecution(record: SkillExecutionStoreRecord): Promise<SkillExecutionStoreRecord> {
    await this.ensureUser(record.walletAddress, record.proposedAt);
    await this.query({
      name: 'skill.execution.upsert',
      text: `
        INSERT INTO skill_executions (
          id, install_id, wallet_address, skill_id, proposed_at, result,
          approval_request_id, evidence_receipt_id, record
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          result = EXCLUDED.result,
          approval_request_id = EXCLUDED.approval_request_id,
          evidence_receipt_id = EXCLUDED.evidence_receipt_id,
          record = EXCLUDED.record
        WHERE skill_executions.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        record.id,
        record.installId,
        record.walletAddress,
        record.skillId,
        record.proposedAt,
        record.result ?? null,
        record.approvalRequestId ?? null,
        record.evidenceReceiptId ?? null,
        jsonParam(record),
      ],
    });
    return record;
  }

  async getSkillExecutionByApprovalRequestId(
    walletAddress: string,
    approvalRequestId: string,
  ): Promise<SkillExecutionStoreRecord | undefined> {
    const result = await this.query<JsonRecordRow<SkillExecutionStoreRecord>>({
      name: 'skill.execution.getByApproval',
      text: `
        SELECT record
        FROM skill_executions
        WHERE wallet_address = $1 AND approval_request_id = $2
        ORDER BY proposed_at DESC, id DESC
        LIMIT 1
      `,
      values: [walletAddress, approvalRequestId],
    });
    const row = result.rows[0];
    return row ? jsonRecord(row.record) : undefined;
  }

  async listSkillExecutionsByInstall(installId: string): Promise<SkillExecutionStoreRecord[]> {
    const result = await this.query<JsonRecordRow<SkillExecutionStoreRecord>>({
      name: 'skill.execution.listByInstall',
      text: 'SELECT record FROM skill_executions WHERE install_id = $1 ORDER BY proposed_at ASC, id ASC',
      values: [installId],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listSkillExecutionsForSkill(
    skillId: string,
    sinceIso?: string,
  ): Promise<SkillExecutionStoreRecord[]> {
    const result = await this.query<JsonRecordRow<SkillExecutionStoreRecord>>({
      name: sinceIso ? 'skill.execution.listForSkillSince' : 'skill.execution.listForSkill',
      text: sinceIso
        ? 'SELECT record FROM skill_executions WHERE skill_id = $1 AND proposed_at >= $2 ORDER BY proposed_at ASC, id ASC'
        : 'SELECT record FROM skill_executions WHERE skill_id = $1 ORDER BY proposed_at ASC, id ASC',
      values: sinceIso ? [skillId, sinceIso] : [skillId],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  // ── SignalsStore ──
  async saveSignalFeed(record: SignalFeedStoreRecord): Promise<SignalFeedStoreRecord> {
    await this.ensureUser(record.publisherWallet, record.createdAt);
    await this.query({
      name: 'signal.feed.upsert',
      text: `
        INSERT INTO signal_feeds (id, publisher_wallet, name, created_at, updated_at, status, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          publisher_wallet = EXCLUDED.publisher_wallet,
          name = EXCLUDED.name,
          updated_at = EXCLUDED.updated_at,
          status = EXCLUDED.status,
          record = EXCLUDED.record
      `,
      values: [
        record.id,
        record.publisherWallet,
        signalFeedName(record),
        record.createdAt,
        record.updatedAt,
        record.status,
        jsonParam(record),
      ],
    });
    return record;
  }

  async getSignalFeed(feedId: string): Promise<SignalFeedStoreRecord | undefined> {
    const result = await this.query<SignalFeedRecordRow>({
      name: 'signal.feed.get',
      text: 'SELECT record FROM signal_feeds WHERE id = $1',
      values: [feedId],
    });
    const row = result.rows[0];
    return row ? jsonRecord(row.record) : undefined;
  }

  async listSignalFeedsByPublisher(publisherWallet: string): Promise<SignalFeedStoreRecord[]> {
    const result = await this.query<SignalFeedRecordRow>({
      name: 'signal.feed.listByPublisher',
      text: 'SELECT record FROM signal_feeds WHERE publisher_wallet = $1 ORDER BY updated_at DESC, created_at DESC, id ASC',
      values: [publisherWallet],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async saveSignalSubscription(
    record: SignalSubscriptionStoreRecord,
  ): Promise<SignalSubscriptionStoreRecord> {
    await this.ensureUser(record.followerWallet, record.subscribedAt);
    await this.query({
      name: 'signal.subscription.upsert',
      text: `
        INSERT INTO signal_subscriptions (
          id, follower_wallet, feed_id, status, subscribed_at, updated_at, record
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE signal_subscriptions.follower_wallet = EXCLUDED.follower_wallet
      `,
      values: [
        record.id,
        record.followerWallet,
        record.feedId,
        record.status,
        record.subscribedAt,
        record.updatedAt,
        jsonParam(record),
      ],
    });
    return record;
  }

  async listSignalSubscriptionsForFollower(
    followerWallet: string,
  ): Promise<SignalSubscriptionStoreRecord[]> {
    const result = await this.query<SignalSubscriptionRecordRow>({
      name: 'signal.subscription.listForFollower',
      text: 'SELECT record FROM signal_subscriptions WHERE follower_wallet = $1 ORDER BY updated_at DESC, subscribed_at DESC, id ASC',
      values: [followerWallet],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listSignalSubscriptionsForFeed(feedId: string): Promise<SignalSubscriptionStoreRecord[]> {
    const result = await this.query<SignalSubscriptionRecordRow>({
      name: 'signal.subscription.listForFeed',
      text: 'SELECT record FROM signal_subscriptions WHERE feed_id = $1 ORDER BY updated_at DESC, subscribed_at DESC, id ASC',
      values: [feedId],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async saveSignalEmission(record: SignalEmissionStoreRecord): Promise<SignalEmissionStoreRecord> {
    const normalized = normalizeSignalEmissionRecord(record);
    await this.ensureUser(record.publisherWallet, record.emittedAt);
    await this.query({
      name: 'signal.emission.upsert',
      text: `
        INSERT INTO signal_emissions (
          id, feed_id, publisher_wallet, emitted_at, source_txid, delivered, fanout_processed_at, record
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          delivered = EXCLUDED.delivered,
          fanout_processed_at = EXCLUDED.fanout_processed_at,
          record = EXCLUDED.record
      `,
      values: [
        normalized.id,
        normalized.feedId,
        normalized.publisherWallet,
        normalized.emittedAt,
        signalEmissionSourceTxid(normalized),
        normalized.delivered,
        normalized.fanoutProcessedAt ?? null,
        jsonParam(normalized),
      ],
    });
    return normalized;
  }

  async listUndeliveredSignalEmissions(limit = 200): Promise<SignalEmissionStoreRecord[]> {
    const result = await this.query<SignalEmissionRecordRow>({
      name: 'signal.emission.listUndelivered',
      text: `
        SELECT record
        FROM signal_emissions
        WHERE fanout_processed_at IS NULL
        ORDER BY emitted_at ASC, id ASC
        LIMIT $1
      `,
      values: [limit],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async markSignalEmissionFanoutProcessed(
    emissionId: string,
    delivered: number,
    fanoutProcessedAt: string,
  ): Promise<void> {
    await this.query({
      name: 'signal.emission.markFanoutProcessed',
      text: `
        UPDATE signal_emissions
        SET
          delivered = $2,
          fanout_processed_at = $3,
          record = jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(record, '{delivered}', to_jsonb($2::int), true),
                '{fanoutProcessedAt}', to_jsonb($3::text), true
              ),
              '{emission,delivered}', to_jsonb($2::int), true
            ),
            '{emission,fanoutProcessedAt}', to_jsonb($3::text), true
          )
        WHERE id = $1
      `,
      values: [emissionId, delivered, fanoutProcessedAt],
    });
  }

  async listSchedules(walletAddress: string): Promise<RecurringScheduleRecord[]> {
    return this.listJsonRecords<RecurringScheduleRecord>('recurring.schedule.list', 'recurring_schedules', walletAddress, 'created_at DESC');
  }

  async getSchedule(walletAddress: string, id: string): Promise<RecurringScheduleRecord | undefined> {
    return this.getJsonRecord<RecurringScheduleRecord>('recurring.schedule.get', 'recurring_schedules', walletAddress, id);
  }

  async saveSchedule(walletAddress: string, record: RecurringScheduleRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'recurring.schedule.upsert',
      text: `
        INSERT INTO recurring_schedules (id, wallet_address, status, next_due_at, expires_at, created_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          next_due_at = EXCLUDED.next_due_at,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE recurring_schedules.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.status,
        normalized.nextDueAt ?? null,
        normalized.expiresAt ?? null,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async deleteSchedule(walletAddress: string, id: string): Promise<boolean> {
    return this.deleteByOwner('recurring.schedule.delete', 'recurring_schedules', walletAddress, id);
  }

  async deleteAllRecurringData(walletAddress: string): Promise<{
    recurringSchedules: number;
    recurringOccurrences: number;
    recurringNotificationDeliveries: number;
  }> {
    const recurringNotificationDeliveries = await this.deleteByWallet(
      'recurring.notification.deleteAllForWallet',
      'recurring_notification_deliveries',
      walletAddress,
    );
    const recurringOccurrences = await this.deleteByWallet(
      'recurring.occurrence.deleteAllForWallet',
      'recurring_occurrences',
      walletAddress,
    );
    const recurringSchedules = await this.deleteByWallet(
      'recurring.schedule.deleteAllForWallet',
      'recurring_schedules',
      walletAddress,
    );
    return {
      recurringSchedules,
      recurringOccurrences,
      recurringNotificationDeliveries,
    };
  }

  async listOccurrences(walletAddress: string, scheduleId?: string): Promise<RecurringOccurrenceRecord[]> {
    const result = await this.query<JsonRecordRow<RecurringOccurrenceRecord>>({
      name: scheduleId ? 'recurring.occurrence.listForSchedule' : 'recurring.occurrence.list',
      text: `
        SELECT record
        FROM recurring_occurrences
        WHERE wallet_address = $1
          AND ($2::text IS NULL OR recurring_schedule_id = $2)
        ORDER BY due_at ASC, created_at ASC
      `,
      values: [walletAddress, scheduleId ?? null],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async getOccurrence(walletAddress: string, id: string): Promise<RecurringOccurrenceRecord | undefined> {
    return this.getJsonRecord<RecurringOccurrenceRecord>('recurring.occurrence.get', 'recurring_occurrences', walletAddress, id);
  }

  async saveOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    await this.query({
      name: 'recurring.occurrence.upsert',
      text: `
        INSERT INTO recurring_occurrences (
          id, recurring_schedule_id, wallet_address, status, occurrence_key, due_at, created_at, updated_at, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          due_at = EXCLUDED.due_at,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE recurring_occurrences.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        normalized.recurringScheduleId,
        walletAddress,
        normalized.status,
        normalized.occurrenceKey,
        normalized.dueAt,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async claimOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<RecurringOccurrenceClaim> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
    const result = await this.query<JsonRecordRow<RecurringOccurrenceRecord>>({
      name: 'recurring.occurrence.claim',
      text: `
        INSERT INTO recurring_occurrences (
          id, recurring_schedule_id, wallet_address, status, occurrence_key, due_at, created_at, updated_at, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT ON CONSTRAINT recurring_occurrences_unique_window DO UPDATE SET
          record = recurring_occurrences.record
        RETURNING record
      `,
      values: [
        normalized.id,
        normalized.recurringScheduleId,
        walletAddress,
        normalized.status,
        normalized.occurrenceKey,
        normalized.dueAt,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
    const claimed = result.rows[0] ? jsonRecord(result.rows[0].record) : undefined;
    if (!claimed) {
      throw new Error('Recurring occurrence claim did not return a record.');
    }
    return { created: claimed.id === normalized.id, occurrence: claimed };
  }

  async findOccurrenceByKey(
    walletAddress: string,
    scheduleId: string,
    occurrenceKey: string,
  ): Promise<RecurringOccurrenceRecord | undefined> {
    const result = await this.query<JsonRecordRow<RecurringOccurrenceRecord>>({
      name: 'recurring.occurrence.findByKey',
      text: `
        SELECT record
        FROM recurring_occurrences
        WHERE wallet_address = $1 AND recurring_schedule_id = $2 AND occurrence_key = $3
      `,
      values: [walletAddress, scheduleId, occurrenceKey],
    });
    return result.rows[0] ? jsonRecord(result.rows[0].record) : undefined;
  }

  async listKnownWallets(): Promise<string[]> {
    const result = await this.query<WalletRow>({
      name: 'recurring.wallets',
      text: `
        SELECT DISTINCT wallet_address
        FROM recurring_schedules
        WHERE status = 'active'
        ORDER BY wallet_address ASC
      `,
    });
    return result.rows.map((row) => row.wallet_address);
  }

  async saveNotificationDelivery(record: RecurringNotificationDeliveryRecord): Promise<void> {
    await this.ensureUser(record.walletAddress, record.createdAt);
    await this.query({
      name: 'recurring.notification.upsert',
      text: `
        INSERT INTO recurring_notification_deliveries (
          id, wallet_address, type, schedule_id, occurrence_id, status,
          attempts, next_attempt_at, created_at, updated_at, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (occurrence_id, type) DO UPDATE SET
          status = EXCLUDED.status,
          attempts = EXCLUDED.attempts,
          next_attempt_at = EXCLUDED.next_attempt_at,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE recurring_notification_deliveries.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        record.id,
        record.walletAddress,
        record.type,
        record.scheduleId,
        record.occurrenceId,
        record.status,
        record.attempts,
        record.nextAttemptAt,
        record.createdAt,
        record.updatedAt,
        jsonParam(record),
      ],
    });
  }

  async findNotificationDelivery(
    walletAddress: string,
    occurrenceId: string,
    type: RecurringNotificationDeliveryRecord['type'],
  ): Promise<RecurringNotificationDeliveryRecord | undefined> {
    const result = await this.query<JsonRecordRow<RecurringNotificationDeliveryRecord>>({
      name: 'recurring.notification.findByOccurrence',
      text: `
        SELECT record
        FROM recurring_notification_deliveries
        WHERE wallet_address = $1 AND occurrence_id = $2 AND type = $3
        LIMIT 1
      `,
      values: [walletAddress, occurrenceId, type],
    });
    return result.rows[0] ? jsonRecord(result.rows[0].record) : undefined;
  }

  async listNotificationDeliveries(
    walletAddress: string,
    scheduleId: string,
    limit: number,
  ): Promise<RecurringNotificationDeliveryRecord[]> {
    const result = await this.query<JsonRecordRow<RecurringNotificationDeliveryRecord>>({
      name: 'recurring.notification.listForSchedule',
      text: `
        SELECT record
        FROM recurring_notification_deliveries
        WHERE wallet_address = $1 AND schedule_id = $2
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $3
      `,
      values: [walletAddress, scheduleId, limit],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listDueNotificationDeliveries(nowIso: string, limit: number): Promise<RecurringNotificationDeliveryRecord[]> {
    const result = await this.query<JsonRecordRow<RecurringNotificationDeliveryRecord>>({
      name: 'recurring.notification.listDue',
      text: `
        SELECT record
        FROM recurring_notification_deliveries
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= $1
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $2
      `,
      values: [nowIso, limit],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  async listPreferences(
    walletAddress: string,
    namespaces?: CloudPreferenceNamespace[],
  ): Promise<CloudPreferenceRecord[]> {
    const result = await this.query<PreferenceRow>({
      name: 'preference.list',
      text: `
        SELECT namespace, payload, updated_at, version
        FROM wallet_preferences
        WHERE wallet_address = $1
          AND ($2::text[] IS NULL OR namespace = ANY($2::text[]))
        ORDER BY namespace ASC
      `,
      values: [walletAddress, namespaces ?? null],
    });
    return result.rows.map(preferenceFromRow);
  }

  async getPreference(
    walletAddress: string,
    namespace: CloudPreferenceNamespace,
  ): Promise<CloudPreferenceRecord | undefined> {
    const result = await this.query<PreferenceRow>({
      name: 'preference.get',
      text: `
        SELECT namespace, payload, updated_at, version
        FROM wallet_preferences
        WHERE wallet_address = $1 AND namespace = $2
      `,
      values: [walletAddress, namespace],
    });
    return result.rows[0] ? preferenceFromRow(result.rows[0]) : undefined;
  }

  async savePreference(walletAddress: string, record: CloudPreferenceRecord): Promise<CloudPreferenceRecord> {
    await this.ensureUser(walletAddress, record.updatedAt);
    const result = await this.query<PreferenceRow>({
      name: 'preference.upsert',
      text: `
        INSERT INTO wallet_preferences (wallet_address, namespace, version, updated_at, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (wallet_address, namespace) DO UPDATE SET
          version = EXCLUDED.version,
          updated_at = EXCLUDED.updated_at,
          payload = EXCLUDED.payload
        RETURNING namespace, payload, updated_at, version
      `,
      values: [
        walletAddress,
        record.namespace,
        record.version,
        record.updatedAt,
        jsonParam(record.payload),
      ],
    });
    return result.rows[0] ? preferenceFromRow(result.rows[0]) : record;
  }

  async getAgentPolicies(walletAddress: string): Promise<{ policies: unknown[]; updatedAt: string; version: number } | undefined> {
    const record = await this.getPreference(walletAddress, 'agent-policies');
    if (!record) return undefined;
    return {
      policies: Array.isArray(record.payload) ? record.payload : [],
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  async saveAgentPolicies(
    walletAddress: string,
    state: { policies: unknown[]; updatedAt: string; version: number },
  ): Promise<{ policies: unknown[]; updatedAt: string; version: number }> {
    const saved = await this.savePreference(walletAddress, {
      namespace: 'agent-policies',
      payload: state.policies,
      updatedAt: state.updatedAt,
      version: state.version,
    });
    return {
      policies: Array.isArray(saved.payload) ? saved.payload : [],
      updatedAt: saved.updatedAt,
      version: saved.version,
    };
  }

  async deleteCloudWorkspace(walletAddress: string): Promise<CloudWorkspaceDeleteCounts> {
    const client = await this.checkoutClient();
    await client.query({ text: 'BEGIN' });
    try {
      const counts = emptyCloudWorkspaceDeleteCounts();
      const authoredSkillIds = await listAuthoredSkillIdsWithClient(client, walletAddress);
      counts.preferences = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.preferences.delete',
        'wallet_preferences',
        walletAddress,
      );
      counts.recurringNotificationDeliveries = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.recurringNotifications.delete',
        'recurring_notification_deliveries',
        walletAddress,
      );
      counts.transactionFinalizations = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.finalizations.delete',
        'transaction_finalizations',
        walletAddress,
      );
      counts.recurringOccurrences = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.recurringOccurrences.delete',
        'recurring_occurrences',
        walletAddress,
      );
      counts.recurringSchedules = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.recurringSchedules.delete',
        'recurring_schedules',
        walletAddress,
      );
      counts.evidenceReceipts = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.evidence.delete',
        'evidence_receipts',
        walletAddress,
      );
      counts.skillInstalls = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.skillInstalls.delete',
        'skill_installs',
        'wallet_address',
        walletAddress,
      );
      counts.skillExecutions = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.skillExecutions.delete',
        'skill_executions',
        'wallet_address',
        walletAddress,
      );
      counts.signalSubscriptions = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.signalSubscriptions.delete',
        'signal_subscriptions',
        'follower_wallet',
        walletAddress,
      );
      counts.signalEmissions = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.signalEmissions.delete',
        'signal_emissions',
        'publisher_wallet',
        walletAddress,
      );
      counts.signalFeeds = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.signalFeeds.delete',
        'signal_feeds',
        'publisher_wallet',
        walletAddress,
      );
      counts.skillManifests = await deleteByColumnWithClient(
        client,
        'cloudWorkspace.skillManifests.delete',
        'skill_manifests',
        'author_wallet',
        walletAddress,
      );
      counts.aggregatorSnapshots = await deleteAggregatorSnapshotsWithClient(
        client,
        walletAddress,
        authoredSkillIds,
      );
      counts.completedRecords = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.completed.delete',
        'completed_records',
        walletAddress,
      );
      counts.approvals = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.approvals.delete',
        'approval_requests',
        walletAddress,
      );
      counts.plans = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.plans.delete',
        'plans',
        walletAddress,
      );
      counts.auditEvents = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.audit.delete',
        'audit_events',
        walletAddress,
      );
      counts.nonces = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.nonces.delete',
        'nonces',
        walletAddress,
      );
      counts.sessions = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.sessions.delete',
        'wallet_sessions',
        walletAddress,
      );
      counts.users = await deleteByWalletWithClient(
        client,
        'cloudWorkspace.users.delete',
        'users',
        walletAddress,
      );
      await client.query({ text: 'COMMIT' });
      return counts;
    } catch (err) {
      await client.query({ text: 'ROLLBACK' });
      throw err;
    } finally {
      client.release?.();
    }
  }

  private async insertAuditEvent(record: AuditEventRecord): Promise<void> {
    await this.ensureUser(record.walletAddress, record.createdAt);
    await this.query({
      name: 'audit.insert',
      text: `
        INSERT INTO audit_events (id, wallet_address, type, created_at, metadata)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      values: [
        record.id,
        record.walletAddress,
        record.type,
        record.createdAt,
        jsonParam(record.metadata ?? {}),
      ],
    });
  }

  private async listAuditEvents(walletAddress: string): Promise<AuditEventRecord[]> {
    const result = await this.query<AuditEventRow>({
      name: 'audit.list',
      text: `
        SELECT id, wallet_address, type, created_at, metadata
        FROM audit_events
        WHERE wallet_address = $1
        ORDER BY created_at ASC
      `,
      values: [walletAddress],
    });
    return result.rows.map(auditEventFromRow);
  }

  private async ensureUser(walletAddress: string, createdAt: string | Date, lastSeenAt?: string | Date): Promise<void> {
    const now = iso(createdAt);
    await this.query({
      name: 'user.upsert',
      text: `
        INSERT INTO users (wallet_address, created_at, updated_at, last_seen_at)
        VALUES ($1, $2, $2, $3)
        ON CONFLICT (wallet_address) DO UPDATE SET
          updated_at = EXCLUDED.updated_at,
          last_seen_at = COALESCE(EXCLUDED.last_seen_at, users.last_seen_at)
      `,
      values: [walletAddress, now, lastSeenAt ? iso(lastSeenAt) : null],
    });
  }

  private async listJsonRecords<T>(
    name: string,
    table: string,
    walletAddress: string,
    orderBy: string,
  ): Promise<T[]> {
    const result = await this.query<JsonRecordRow<T>>({
      name,
      text: `SELECT record FROM ${table} WHERE wallet_address = $1 ORDER BY ${orderBy}`,
      values: [walletAddress],
    });
    return result.rows.map((row) => jsonRecord(row.record));
  }

  private async getJsonRecord<T>(
    name: string,
    table: string,
    walletAddress: string,
    id: string,
  ): Promise<T | undefined> {
    const result = await this.query<JsonRecordRow<T>>({
      name,
      text: `SELECT record FROM ${table} WHERE wallet_address = $1 AND id = $2`,
      values: [walletAddress, id],
    });
    return result.rows[0] ? jsonRecord(result.rows[0].record) : undefined;
  }

  private async deleteByOwner(name: string, table: string, walletAddress: string, id: string): Promise<boolean> {
    const result = await this.query({
      name,
      text: `DELETE FROM ${table} WHERE wallet_address = $1 AND id = $2`,
      values: [walletAddress, id],
    });
    return (result.rowCount ?? 0) > 0;
  }

  private async deleteByWallet(name: string, table: string, walletAddress: string): Promise<number> {
    return deleteByWalletWithClient(this.client, name, table, walletAddress);
  }

  private query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    return this.client.query<R>(query);
  }

  private async checkoutClient(): Promise<PgClient> {
    const connect = (this.client as Partial<PgConnectableClient>).connect;
    if (connect) {
      return connect.call(this.client);
    }
    return this.client;
  }

  // ── AggregatorStore ──
  async saveAggregatorSnapshot(
    record: AggregatorSnapshotStoreRecord,
  ): Promise<AggregatorSnapshotStoreRecord> {
    await this.query({
      name: 'aggregator.upsert',
      text: `
        INSERT INTO aggregator_snapshots (key, kind, computed_at, record)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (key) DO UPDATE SET
          kind = EXCLUDED.kind,
          computed_at = EXCLUDED.computed_at,
          record = EXCLUDED.record
      `,
      values: [record.key, record.kind, record.computedAt, jsonParam(record)],
    });
    return record;
  }

  async getAggregatorSnapshot(key: string): Promise<AggregatorSnapshotStoreRecord | undefined> {
    const result = await this.query<AggregatorSnapshotRow>({
      name: 'aggregator.get',
      text: 'SELECT key, kind, computed_at, record FROM aggregator_snapshots WHERE key = $1',
      values: [key],
    });
    const row = result.rows[0];
    return row ? aggregatorRecordFromRow(row) : undefined;
  }

  async listAggregatorSnapshotsByKind(
    kind: 'skill' | 'wallet',
  ): Promise<AggregatorSnapshotStoreRecord[]> {
    const result = await this.query<AggregatorSnapshotRow>({
      name: 'aggregator.listByKind',
      text: 'SELECT key, kind, computed_at, record FROM aggregator_snapshots WHERE kind = $1 ORDER BY computed_at DESC',
      values: [kind],
    });
    return result.rows.map(aggregatorRecordFromRow);
  }
}

function aggregatorRecordFromRow(row: AggregatorSnapshotRow): AggregatorSnapshotStoreRecord {
  const parsed = typeof row.record === 'string'
    ? (JSON.parse(row.record) as AggregatorSnapshotStoreRecord)
    : row.record;
  return parsed;
}

function signalFeedName(record: SignalFeedStoreRecord): string {
  const feed = record.feed;
  if (feed && typeof feed === 'object' && !Array.isArray(feed)) {
    const value = (feed as Record<string, unknown>).name;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return record.id;
}

function signalEmissionSourceTxid(record: SignalEmissionStoreRecord): string {
  const emission = record.emission;
  if (emission && typeof emission === 'object' && !Array.isArray(emission)) {
    const value = (emission as Record<string, unknown>).sourceTxid;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return record.id;
}

function normalizeSignalEmissionRecord(record: SignalEmissionStoreRecord): SignalEmissionStoreRecord {
  const emission = record.emission && typeof record.emission === 'object' && !Array.isArray(record.emission)
    ? {
        ...(record.emission as Record<string, unknown>),
        delivered: record.delivered,
        ...(record.fanoutProcessedAt ? { fanoutProcessedAt: record.fanoutProcessedAt } : {}),
      }
    : record.emission;
  return { ...record, emission };
}

function isPgUniqueViolation(err: unknown, name: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const pgError = err as { code?: unknown; constraint?: unknown; message?: unknown; detail?: unknown };
  return pgError.code === '23505' &&
    (pgError.constraint === name || String(pgError.message ?? '').includes(name) || String(pgError.detail ?? '').includes(name));
}

async function deleteByWalletWithClient(
  client: PgClient,
  name: string,
  table: string,
  walletAddress: string,
): Promise<number> {
  return deleteByColumnWithClient(client, name, table, 'wallet_address', walletAddress);
}

async function deleteByColumnWithClient(
  client: PgClient,
  name: string,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  const result = await client.query({
    name,
    text: `DELETE FROM ${table} WHERE ${column} = $1`,
    values: [value],
  });
  return result.rowCount ?? 0;
}

async function listAuthoredSkillIdsWithClient(
  client: PgClient,
  walletAddress: string,
): Promise<string[]> {
  const result = await client.query<SkillIdRow>({
    name: 'cloudWorkspace.skillManifests.listAuthoredIds',
    text: 'SELECT id FROM skill_manifests WHERE author_wallet = $1 ORDER BY id ASC',
    values: [walletAddress],
  });
  return result.rows.map((row) => row.id);
}

async function deleteAggregatorSnapshotsWithClient(
  client: PgClient,
  walletAddress: string,
  authoredSkillIds: readonly string[],
): Promise<number> {
  const keys = [
    `wallet:${walletAddress}`,
    ...authoredSkillIds.map((skillId) => `skill:${skillId}`),
  ];
  const result = await client.query({
    name: 'cloudWorkspace.aggregatorSnapshots.delete',
    text: 'DELETE FROM aggregator_snapshots WHERE key = ANY($1::text[])',
    values: [keys],
  });
  return result.rowCount ?? 0;
}

function approvalExistsError(): Error {
  const err = new Error('This item already has an active approval request.');
  (err as { code?: string }).code = 'approval_exists';
  return err;
}

function nonceFromRow(row: AuthNonceRow): AuthNonceRecord {
  return {
    nonce: row.nonce,
    walletAddress: row.wallet_address,
    domain: row.domain,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    message: row.message,
    createdAt: iso(row.created_at),
    ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
  };
}

function sessionFromRow(row: SessionRow): WalletSessionRecord {
  return {
    tokenHash: row.token_hash,
    walletAddress: row.wallet_address,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    lastSeenAt: iso(row.last_seen_at),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
  };
}

function auditEventFromRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    type: row.type,
    createdAt: iso(row.created_at),
    metadata: row.metadata ? jsonRecord<Record<string, unknown>>(row.metadata) : {},
  };
}

function preferenceFromRow(row: PreferenceRow): CloudPreferenceRecord {
  return {
    namespace: row.namespace as CloudPreferenceNamespace,
    payload: jsonRecord(row.payload),
    updatedAt: iso(row.updated_at),
    version: typeof row.version === 'number' ? row.version : Number(row.version) || 0,
  };
}

function recurringAuditMetadata(record: RecurringAuditEvent): JsonObject {
  return {
    ...(record.metadata ?? {}),
    scheduleId: record.scheduleId,
    ...(record.occurrenceId ? { occurrenceId: record.occurrenceId } : {}),
    ...(record.occurrenceKey ? { occurrenceKey: record.occurrenceKey } : {}),
  };
}

function jsonRecord<T>(value: T | string): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return clone(value);
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function envInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function postgresSslConfig(connectionString: string): Partial<PoolConfig> {
  const sslMode = new URL(connectionString).searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '';
  if (sslMode === 'require' || sslMode === 'no-verify') {
    return { ssl: { rejectUnauthorized: false } };
  }
  return {};
}
