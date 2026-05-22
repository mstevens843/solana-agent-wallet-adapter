/**
 * Friendly aliases for `prepare connector <kind>`.
 *
 * Each entry maps an alias (used as `solana-agent-wallet prepare <alias> ...`) to
 * the canonical bridge `kind` accepted by /bridge/connector/prepare-transaction.
 *
 * Kept in sync with packages/mcp-server/src/actionService.ts switch — the build-time
 * generator `scripts/generate-aliases.mjs` (PR3) emits a guard test that fails the
 * build if any alias's `kind` is no longer accepted by the registry.
 */

export interface PrepareAliasEntry {
  /** CLI alias the user types: `prepare marinade-stake ...` */
  alias: string;
  /** Canonical kind sent to /bridge/connector/prepare-transaction */
  kind: string;
  /** Short blurb shown in help output. */
  description: string;
}

export const PREPARE_ALIASES: readonly PrepareAliasEntry[] = [
  // Jupiter
  { alias: 'jupiter-lend-deposit', kind: 'jupiter_lend_earn_deposit', description: 'Deposit into Jupiter Lend Earn' },
  { alias: 'jupiter-lend-withdraw', kind: 'jupiter_lend_earn_withdraw', description: 'Withdraw from Jupiter Lend Earn' },
  { alias: 'jupiter-trigger', kind: 'jupiter_trigger_single_order', description: 'Place a Jupiter limit/trigger order' },
  { alias: 'jupiter-recurring', kind: 'jupiter_recurring_create_time_order', description: 'Create a Jupiter Recurring DCA order' },
  // Drift vaults
  { alias: 'drift-vault-deposit', kind: 'drift_vault_deposit', description: 'Deposit into a Drift strategy vault' },
  { alias: 'drift-vault-withdraw', kind: 'drift_vault_request_withdraw', description: 'Request a Drift vault withdrawal' },
  // Marinade
  { alias: 'marinade-stake', kind: 'marinade_liquid_stake', description: 'Stake SOL to mSOL via Marinade' },
  { alias: 'marinade-unstake', kind: 'marinade_liquid_unstake', description: 'Instant unstake mSOL via Marinade' },
  // Jito
  { alias: 'jito-stake', kind: 'jito_stake_sol', description: 'Stake SOL to jitoSOL' },
  { alias: 'jito-unstake', kind: 'jito_unstake_jitosol', description: 'Unstake jitoSOL via Jito' },
  // Kamino
  { alias: 'kamino-deposit', kind: 'kamino_deposit', description: 'Deposit into a Kamino reserve' },
  { alias: 'kamino-withdraw', kind: 'kamino_withdraw', description: 'Withdraw from a Kamino reserve' },
  // MarginFi
  { alias: 'marginfi-deposit', kind: 'marginfi_deposit', description: 'Deposit collateral into a MarginFi bank' },
  { alias: 'marginfi-borrow', kind: 'marginfi_borrow', description: 'Borrow against MarginFi collateral' },
  // LP
  { alias: 'meteora-add-liquidity', kind: 'meteora_add_liquidity', description: 'Add liquidity to a Meteora DLMM position' },
  { alias: 'orca-add-liquidity', kind: 'orca_increase_liquidity', description: 'Increase liquidity in an Orca Whirlpool position' },
  { alias: 'raydium-add-liquidity', kind: 'raydium_add_liquidity', description: 'Add liquidity to a Raydium pool' },
  // Cross-chain & NFT & multisig
  { alias: 'wormhole-transfer', kind: 'wormhole_transfer', description: 'Bridge tokens cross-chain via Wormhole' },
  { alias: 'magiceden-buy', kind: 'magiceden_buy', description: 'Buy a Magic Eden listing' },
  { alias: 'squads-propose-transfer', kind: 'squads_create_transfer_proposal', description: 'Create a Squads multisig transfer proposal' },
];

const ALIAS_MAP = new Map<string, PrepareAliasEntry>(PREPARE_ALIASES.map((entry) => [entry.alias, entry]));

/**
 * Map an alias (`marinade-stake`) to a canonical bridge kind
 * (`marinade_liquid_stake`). Falls through unchanged if input is already a known
 * kind shape (snake_case with at least one underscore) — this lets users pass the
 * raw kind via `prepare connector <kind>` without alias registration.
 */
export function resolveAliasKind(input: string): string {
  const trimmed = input.trim();
  const alias = ALIAS_MAP.get(trimmed.toLowerCase());
  if (alias) return alias.kind;
  return trimmed;
}

export function listAliases(): ReadonlyArray<PrepareAliasEntry> {
  return PREPARE_ALIASES;
}

export function isPrepareAlias(name: string): boolean {
  return ALIAS_MAP.has(name.toLowerCase());
}
