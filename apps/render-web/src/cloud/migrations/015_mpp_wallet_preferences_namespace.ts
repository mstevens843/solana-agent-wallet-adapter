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
  // Phase 5.10 — schema-neutral migration, so down is also a no-op. We DELETE
  // any rows that were tagged with the new namespace so a rollback genuinely
  // unwinds the operator-facing surface (no stale wallet_preferences rows
  // referencing a namespace that's no longer documented).
  down: `
    DELETE FROM wallet_preferences WHERE namespace = 'mpp-config';
  `,
};
