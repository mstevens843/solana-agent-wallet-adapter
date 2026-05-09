export const migration001Initial = {
  id: '001_initial',
  sql: `
    CREATE TABLE IF NOT EXISTS agentic_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      wallet_address TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS nonces_wallet_address_idx ON nonces(wallet_address);
    CREATE INDEX IF NOT EXISTS nonces_expires_at_idx ON nonces(expires_at);
    CREATE INDEX IF NOT EXISTS nonces_created_at_idx ON nonces(created_at);

    CREATE TABLE IF NOT EXISTS wallet_sessions (
      token_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS wallet_sessions_wallet_address_idx ON wallet_sessions(wallet_address);
    CREATE INDEX IF NOT EXISTS wallet_sessions_expires_at_idx ON wallet_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS wallet_sessions_created_at_idx ON wallet_sessions(created_at);

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS plans_wallet_address_idx ON plans(wallet_address);
    CREATE INDEX IF NOT EXISTS plans_status_idx ON plans(status);
    CREATE INDEX IF NOT EXISTS plans_created_at_idx ON plans(created_at);
    CREATE INDEX IF NOT EXISTS plans_updated_at_idx ON plans(updated_at);

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      status TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS approval_requests_wallet_address_idx ON approval_requests(wallet_address);
    CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests(status);
    CREATE INDEX IF NOT EXISTS approval_requests_due_at_idx ON approval_requests(due_at);
    CREATE INDEX IF NOT EXISTS approval_requests_created_at_idx ON approval_requests(created_at);

    CREATE TABLE IF NOT EXISTS recurring_schedules (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      status TEXT NOT NULL,
      next_due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS recurring_schedules_wallet_address_idx ON recurring_schedules(wallet_address);
    CREATE INDEX IF NOT EXISTS recurring_schedules_status_idx ON recurring_schedules(status);
    CREATE INDEX IF NOT EXISTS recurring_schedules_next_due_at_idx ON recurring_schedules(next_due_at);
    CREATE INDEX IF NOT EXISTS recurring_schedules_created_at_idx ON recurring_schedules(created_at);

    CREATE TABLE IF NOT EXISTS recurring_occurrences (
      id TEXT PRIMARY KEY,
      recurring_schedule_id TEXT NOT NULL REFERENCES recurring_schedules(id) ON DELETE CASCADE,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      status TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL,
      CONSTRAINT recurring_occurrences_unique_window UNIQUE (wallet_address, recurring_schedule_id, occurrence_key)
    );

    CREATE INDEX IF NOT EXISTS recurring_occurrences_wallet_address_idx ON recurring_occurrences(wallet_address);
    CREATE INDEX IF NOT EXISTS recurring_occurrences_status_idx ON recurring_occurrences(status);
    CREATE INDEX IF NOT EXISTS recurring_occurrences_due_at_idx ON recurring_occurrences(due_at);
    CREATE INDEX IF NOT EXISTS recurring_occurrences_created_at_idx ON recurring_occurrences(created_at);

    CREATE TABLE IF NOT EXISTS completed_records (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS completed_records_wallet_address_idx ON completed_records(wallet_address);
    CREATE INDEX IF NOT EXISTS completed_records_status_idx ON completed_records(status);
    CREATE INDEX IF NOT EXISTS completed_records_created_at_idx ON completed_records(created_at);
    CREATE INDEX IF NOT EXISTS completed_records_completed_at_idx ON completed_records(completed_at);

    CREATE TABLE IF NOT EXISTS evidence_receipts (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS evidence_receipts_wallet_address_idx ON evidence_receipts(wallet_address);
    CREATE INDEX IF NOT EXISTS evidence_receipts_status_idx ON evidence_receipts(status);
    CREATE INDEX IF NOT EXISTS evidence_receipts_created_at_idx ON evidence_receipts(created_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS audit_events_wallet_address_idx ON audit_events(wallet_address);
    CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events(type);
    CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at);
  `,
} as const;
