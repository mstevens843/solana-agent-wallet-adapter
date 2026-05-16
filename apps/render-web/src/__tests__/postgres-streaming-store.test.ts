// Phase 5.14 — mock-based integration tests for PostgresStreamingStore's new
// settlement-retry-safety methods (P5.4 + P5.6 + P5.10). The render-web dev
// machine doesn't have Docker available, so a full testcontainers run is
// deferred; these tests instead use the same TrackingPoolClient pattern as
// `postgres-store.test.ts` to verify the SQL queries we send are well-formed.
//
// Run a real testcontainers integration when Docker is available:
//   docker run -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:16
//   DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
//     pnpm -F render-web vitest run -- --reporter=verbose postgres-streaming-store

import { describe, expect, it } from 'vitest';
import type { QueryConfig, QueryResult, QueryResultRow } from 'pg';

import type { PgClient, PgConnection } from '../cloud/postgresStore.js';
import {
  LAST_SETTLEMENT_ATTEMPT_METADATA_KEY,
  PostgresStreamingStore,
} from '../cloud/streamingService.js';

describe('PostgresStreamingStore — settlement-retry safety SQL (P5.4 + P5.6)', () => {
  it('setLastSettlementAttempt writes the attempt under lastSettlementAttempt key', async () => {
    const client = new RecordingPgClient();
    const store = new PostgresStreamingStore({ client });
    await store.setLastSettlementAttempt(
      'stream_abc',
      { txid: 'tx_first', voucherHashes: ['hash_1', 'hash_2'], submittedAt: '2026-05-16T12:00:00.000Z' },
      '2026-05-16T12:00:01.000Z',
    );
    const sent = client.poolQueries.at(-1);
    expect(sent?.text).toContain(`'{${LAST_SETTLEMENT_ATTEMPT_METADATA_KEY}}'`);
    expect(sent?.text).toContain('jsonb_set');
    expect(sent?.values?.[0]).toBe('stream_abc');
    expect(sent?.values?.[1]).toBe('2026-05-16T12:00:01.000Z');
    const payload = JSON.parse(String(sent?.values?.[2] ?? '{}'));
    expect(payload).toMatchObject({ txid: 'tx_first', submittedAt: '2026-05-16T12:00:00.000Z' });
  });

  it('setLastSettlementAttempt with null deletes the metadata key', async () => {
    const client = new RecordingPgClient();
    const store = new PostgresStreamingStore({ client });
    await store.setLastSettlementAttempt('stream_abc', null, '2026-05-16T12:00:02.000Z');
    const sent = client.poolQueries.at(-1);
    expect(sent?.text).toContain(`- '${LAST_SETTLEMENT_ATTEMPT_METADATA_KEY}'`);
    expect(sent?.values).toEqual(['stream_abc', '2026-05-16T12:00:02.000Z']);
  });

  it('getLastSettlementAttempt extracts a valid attempt from the metadata column', async () => {
    const validAttempt = {
      txid: 'tx_recovered',
      voucherHashes: ['hash_a'],
      submittedAt: '2026-05-16T11:55:00.000Z',
    };
    const client = new RecordingPgClient({
      'streaming.settlement.getLastAttempt': [
        { metadata: { [LAST_SETTLEMENT_ATTEMPT_METADATA_KEY]: validAttempt } },
      ],
    });
    const store = new PostgresStreamingStore({ client });
    const result = await store.getLastSettlementAttempt('stream_abc');
    expect(result).toEqual(validAttempt);
  });

  it('getLastSettlementAttempt returns undefined for malformed metadata payloads', async () => {
    const client = new RecordingPgClient({
      'streaming.settlement.getLastAttempt': [
        { metadata: { [LAST_SETTLEMENT_ATTEMPT_METADATA_KEY]: { txid: 'bad', missingFields: true } } },
      ],
    });
    const store = new PostgresStreamingStore({ client });
    const result = await store.getLastSettlementAttempt('stream_abc');
    expect(result).toBeUndefined();
  });

  it('heartbeatSettlementLock conditionally extends only an actively-held lock', async () => {
    const client = new RecordingPgClient();
    const store = new PostgresStreamingStore({ client });
    await store.heartbeatSettlementLock(
      'stream_abc',
      '2026-05-16T12:00:30.000Z',
      '2026-05-16T12:01:30.000Z',
    );
    const sent = client.poolQueries.at(-1);
    expect(sent?.text).toContain('jsonb_set');
    expect(sent?.text).toContain("metadata ? 'streamingSettlementLock'");
    expect(sent?.text).toContain("expiresAt')::timestamptz, 'epoch'::timestamptz) > $2");
    expect(sent?.values?.[0]).toBe('stream_abc');
    expect(sent?.values?.[1]).toBe('2026-05-16T12:00:30.000Z');
    // The new expiresAt value is JSON-encoded — heartbeat writes a string into
    // the existing lock's expiresAt slot.
    expect(JSON.parse(String(sent?.values?.[2]))).toBe('2026-05-16T12:01:30.000Z');
  });

  it('claimSettlementCandidate refuses to extend if no live lock exists (acquires fresh one instead)', async () => {
    const client = new RecordingPgClient();
    const store = new PostgresStreamingStore({ client });
    await store.claimSettlementCandidate(
      'stream_abc',
      '2026-05-16T12:00:00.000Z',
      '2026-05-16T12:00:55.000Z',
    );
    const sent = client.poolQueries.at(-1);
    expect(sent?.text).toContain('UPDATE streaming_sessions');
    expect(sent?.text).toContain("'{streamingSettlementLock}'");
    // The conditional WHERE clause filters out sessions whose lock is still
    // live, so two concurrent workers can't both claim.
    expect(sent?.text).toContain("expiresAt')::timestamptz, 'epoch'::timestamptz) <= $2");
  });
});

// Lightweight test double that records every SQL query sent and lets each
// test pre-stage rows for specific named queries. Mirrors the pattern used by
// the existing `postgres-store.test.ts` so contributors can find it easily.
class RecordingPgClient implements PgClient {
  readonly poolQueries: QueryConfig[] = [];
  readonly connections: RecordingConnection[] = [];
  private readonly stubs: Record<string, Array<Record<string, unknown>>>;

  constructor(stubs: Record<string, Array<Record<string, unknown>>> = {}) {
    this.stubs = stubs;
  }

  async query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    this.poolQueries.push(query);
    return makeResult<R>(this.stubs[query.name ?? ''] ?? []);
  }

  async connect(): Promise<PgConnection> {
    const connection = new RecordingConnection(this.stubs);
    this.connections.push(connection);
    return connection;
  }
}

class RecordingConnection implements PgConnection {
  readonly queries: QueryConfig[] = [];
  released = false;
  constructor(private readonly stubs: Record<string, Array<Record<string, unknown>>>) {}
  async query<R extends QueryResultRow = QueryResultRow>(query: QueryConfig): Promise<QueryResult<R>> {
    this.queries.push(query);
    return makeResult<R>(this.stubs[query.name ?? ''] ?? []);
  }
  release(): void {
    this.released = true;
  }
}

function makeResult<R extends QueryResultRow>(rows: Array<Record<string, unknown>>): QueryResult<R> {
  return {
    command: '',
    oid: 0,
    fields: [],
    rowCount: rows.length,
    rows: rows as R[],
  };
}
