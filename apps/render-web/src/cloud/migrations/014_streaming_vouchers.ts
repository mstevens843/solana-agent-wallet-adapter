export const migration014StreamingVouchers = {
  id: '014_streaming_vouchers',
  sql: `
    CREATE TABLE IF NOT EXISTS streaming_vouchers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES streaming_sessions(id) ON DELETE CASCADE,
      nonce TEXT NOT NULL,
      amount TEXT NOT NULL,
      recipient TEXT NOT NULL,
      voucher_hash TEXT NOT NULL,
      signature TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      settled_at TIMESTAMPTZ,
      settlement_txid TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS streaming_vouchers_session_nonce_uidx
      ON streaming_vouchers(session_id, nonce);
    CREATE INDEX IF NOT EXISTS streaming_vouchers_session_settled_idx
      ON streaming_vouchers(session_id, settled_at);
    CREATE INDEX IF NOT EXISTS streaming_vouchers_unsettled_idx
      ON streaming_vouchers(session_id)
      WHERE settled_at IS NULL;
  `,
};
