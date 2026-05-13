export const migration007WalletPreferences = {
  id: '007_wallet_preferences',
  sql: `
    CREATE TABLE IF NOT EXISTS wallet_preferences (
      wallet_address TEXT NOT NULL REFERENCES users(wallet_address) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (wallet_address, namespace)
    );

    CREATE INDEX IF NOT EXISTS wallet_preferences_wallet_address_idx ON wallet_preferences(wallet_address);
    CREATE INDEX IF NOT EXISTS wallet_preferences_updated_at_idx ON wallet_preferences(updated_at);
  `,
};
