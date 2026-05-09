import pg from 'pg';
import type { PoolConfig, QueryConfig, QueryResult, QueryResultRow } from 'pg';

import type {
  EvidenceAuditEvent,
  EvidenceReceiptRecord,
  EvidenceStore,
} from './evidenceService.js';
import { postgresMigrations } from './migrations/index.js';
import type {
  RecurringAuditEvent,
  RecurringOccurrenceClaim,
  RecurringOccurrenceRecord,
  RecurringScheduleRecord,
  RecurringStore,
} from './recurringService.js';
import type {
  AuditEventRecord,
  AuthNonceRecord,
  WalletScopedWorkflowStore,
  WalletSessionRecord,
  WorkflowStore as SessionWorkflowStore,
} from './store.js';
import type { WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';
import type {
  ApprovalRequestRecord,
  AuditEventRecord as WorkflowAuditEventRecord,
  CompletedRecord,
  JsonObject,
  PlanDraftRecord,
} from './workflowValidation.js';

const { Pool } = pg;

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

export class PostgresWorkflowStore implements
  SessionWorkflowStore,
  OneTimeWorkflowStore,
  EvidenceStore,
  RecurringStore {
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
    await this.query({
      text: `
        CREATE TABLE IF NOT EXISTS agentic_migrations (
          id TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
    });

    for (const migration of postgresMigrations) {
      const client = await this.checkoutClient();
      await client.query({ text: 'BEGIN' });
      try {
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
        await client.query({ text: 'COMMIT' });
      } catch (err) {
        await client.query({ text: 'ROLLBACK' });
        throw err;
      } finally {
        client.release?.();
      }
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

  async getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined> {
    return this.getJsonRecord<ApprovalRequestRecord>('approval.get', 'approval_requests', walletAddress, id);
  }

  async saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void> {
    const normalized = { ...record, walletAddress };
    await this.ensureUser(walletAddress, normalized.createdAt);
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
  }

  async listCompleted(walletAddress: string): Promise<CompletedRecord[]> {
    return this.listJsonRecords<CompletedRecord>('completed.list', 'completed_records', walletAddress, 'completed_at DESC, created_at DESC');
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
        INSERT INTO recurring_schedules (id, wallet_address, status, next_due_at, created_at, updated_at, record)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          next_due_at = EXCLUDED.next_due_at,
          updated_at = EXCLUDED.updated_at,
          record = EXCLUDED.record
        WHERE recurring_schedules.wallet_address = EXCLUDED.wallet_address
      `,
      values: [
        normalized.id,
        walletAddress,
        normalized.status,
        normalized.nextDueAt ?? null,
        normalized.createdAt,
        normalized.updatedAt,
        jsonParam(normalized),
      ],
    });
  }

  async deleteSchedule(walletAddress: string, id: string): Promise<boolean> {
    return this.deleteByOwner('recurring.schedule.delete', 'recurring_schedules', walletAddress, id);
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
