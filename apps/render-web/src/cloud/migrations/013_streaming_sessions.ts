export const migration013StreamingSessions = {
  id: '013_streaming_sessions',
  sql: `
    CREATE TABLE IF NOT EXISTS streaming_sessions (
      id TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      cluster TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      delegate_pubkey TEXT NOT NULL,
      ephemeral_signer_pubkey TEXT NOT NULL,
      cap_amount TEXT NOT NULL,
      spent_amount TEXT NOT NULL DEFAULT '0',
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      recipient_allowlist JSONB,
      approve_txid TEXT,
      revoke_txid TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      metadata JSONB
    );

    CREATE INDEX IF NOT EXISTS streaming_sessions_wallet_status_idx
      ON streaming_sessions(wallet_address, status);
    CREATE INDEX IF NOT EXISTS streaming_sessions_expires_at_idx
      ON streaming_sessions(expires_at)
      WHERE status IN ('pending', 'active');
  `,
  // Phase 5.10 rollback. CASCADE cleans up the streaming_vouchers FK from 014.
  down: `
    DROP INDEX IF EXISTS streaming_sessions_expires_at_idx;
    DROP INDEX IF EXISTS streaming_sessions_wallet_status_idx;
    DROP TABLE IF EXISTS streaming_sessions CASCADE;
  `,
};
