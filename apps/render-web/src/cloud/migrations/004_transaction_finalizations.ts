export const migration004TransactionFinalizations = {
  id: '004_transaction_finalizations',
  sql: `
    CREATE TABLE IF NOT EXISTS transaction_finalizations (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      approval_request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      record JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS transaction_finalizations_wallet_address_idx
      ON transaction_finalizations(wallet_address);

    CREATE INDEX IF NOT EXISTS transaction_finalizations_approval_request_id_idx
      ON transaction_finalizations(approval_request_id);

    CREATE INDEX IF NOT EXISTS transaction_finalizations_status_idx
      ON transaction_finalizations(status);

    CREATE INDEX IF NOT EXISTS transaction_finalizations_expires_at_idx
      ON transaction_finalizations(expires_at);

    CREATE INDEX IF NOT EXISTS transaction_finalizations_created_at_idx
      ON transaction_finalizations(created_at);
  `,
} as const;
