export const migration018ChatSessions = {
  id: '018_chat_sessions',
  sql: `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      title TEXT NOT NULL,
      cluster TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT 1,
      -- Opaque client-compressed (LZString UTF16) blob of the session messages.
      -- The server never decompresses or inspects it: keeps message content
      -- out of the DB in plaintext and lets the metadata list query skip it.
      messages_lz TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (wallet_address, session_id)
    );

    -- Newest-first session list per wallet (metadata only) is an index scan.
    CREATE INDEX IF NOT EXISTS chat_sessions_wallet_updated_idx
      ON chat_sessions(wallet_address, updated_at DESC);
  `,
  // Phase 5.10 rollback.
  down: `
    DROP INDEX IF EXISTS chat_sessions_wallet_updated_idx;
    DROP TABLE IF EXISTS chat_sessions CASCADE;
  `,
};
