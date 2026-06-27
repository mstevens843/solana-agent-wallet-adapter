// Schema-neutral migration: wallet_preferences (migration 007) already accepts
// arbitrary TEXT namespaces. This reserves the documented 'recipient-rules'
// namespace for the per-wallet address book (saved recipients + allow/block
// policy). A no-op SELECT keeps the migration runner's idempotency contract simple.
export const migration019RecipientRulesNamespace = {
  id: '019_recipient_rules_namespace',
  sql: `
    SELECT 1;
  `,
  // Schema-neutral, so down deletes any rows tagged with the new namespace so a
  // rollback genuinely unwinds the surface (no stale wallet_preferences rows
  // referencing a namespace that's no longer documented).
  down: `
    DELETE FROM wallet_preferences WHERE namespace = 'recipient-rules';
  `,
};
