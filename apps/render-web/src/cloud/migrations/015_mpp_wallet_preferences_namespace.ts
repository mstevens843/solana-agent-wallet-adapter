// Phase 0 scaffolding migration. No schema change — the wallet_preferences
// table (migration 007) already accepts arbitrary TEXT namespaces. This file
// documents the new 'mpp-config' namespace value reserved for per-wallet MPP
// endpoint, accepted rails, and challenge cap. A no-op SELECT keeps the
// migration runner's idempotency contract simple.
export const migration015MppWalletPreferencesNamespace = {
  id: '015_mpp_wallet_preferences_namespace',
  sql: `
    SELECT 1;
  `,
};
