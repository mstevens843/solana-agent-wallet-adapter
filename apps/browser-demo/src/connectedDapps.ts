// Protocol Connectors — client-side catalog of protocol integrations the
// planner may use before preparing wallet work. First-class adapters map to
// local/MCP actions. Blink connectors map to Solana Actions/Blinks plus read
// APIs, when available.

export const CONNECTED_DAPPS_STORAGE_KEY = 'solana-agent-wallet-connected-dapps-v1';
export const PROTOCOL_CONNECTORS_STORAGE_KEY = 'solana-agent-wallet-protocol-connectors-v2';

export type ProtocolConnectorId =
  | 'kamino'
  | 'jupiter'
  | 'raydium'
  | 'orca'
  | 'meteora'
  | 'marginfi'
  | 'drift'
  | 'lulo'
  | 'save'
  | 'jito'
  | 'marinade'
  | 'sanctum'
  | 'tensor'
  | 'magiceden'
  | 'realms'
  | 'pyth'
  | 'squads';

export type ConnectedDappId = ProtocolConnectorId;

export type ProtocolConnectorCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'localnet';
export type ConnectedDappCluster = ProtocolConnectorCluster;

export type ProtocolConnectorCapabilityId =
  | 'first_class_adapter'
  | 'read_positions'
  | 'read_rewards'
  | 'blink_actions'
  | 'read_markets';

export interface ProtocolConnectorCapability {
  id: ProtocolConnectorCapabilityId;
  label: string;
  description: string;
}

export interface ProtocolConnector {
  id: ProtocolConnectorId;
  name: string;
  aliases: string[];
  website: string;
  description: string;
  supportedClusters: ProtocolConnectorCluster[];
  capabilities: ProtocolConnectorCapabilityId[];
  /** Action labels users see in the panel chip list. */
  supportedActions: string[];
  /** Prepared-action kinds owned by this adapter — used for gating. */
  actionKinds: string[];
  /** Read tool names that belong to this adapter — also gated. */
  readTools: string[];
  /** Initial value of `enabled` when the user has not interacted yet. */
  enabledByDefault: boolean;
  /** Two-character logo placeholder. */
  initials: string;
  /** Generic read layer used by the agent, if the connector can read facts. */
  readSource?: 'dialect-markets' | 'meteora-api' | 'first-class-adapter';
  /** Generic transaction layer used by the agent, if the connector can prepare actions. */
  actionSource?: 'blink' | 'first-class-adapter';
  /** Whether read APIs need a configured client key before use. */
  requiresClientKey?: boolean;
}

export type ConnectedDappAdapter = ProtocolConnector;

export interface ProtocolConnectorEntry {
  enabled: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export type ConnectedDappEntry = ProtocolConnectorEntry;

export interface ProtocolConnectorsState {
  schemaVersion: 2;
  entries: Record<ProtocolConnectorId, ProtocolConnectorEntry>;
}

export type ConnectedDappsState = ProtocolConnectorsState;

export const PROTOCOL_CONNECTOR_CAPABILITIES: Record<
  ProtocolConnectorCapabilityId,
  ProtocolConnectorCapability
> = {
  first_class_adapter: {
    id: 'first_class_adapter',
    label: 'First-class adapter',
    description: 'Agentic owns protocol-specific reads, checks, and prepared actions.',
  },
  read_positions: {
    id: 'read_positions',
    label: 'Read positions',
    description: 'The agent can fetch wallet-specific positions from a connector API.',
  },
  read_rewards: {
    id: 'read_rewards',
    label: 'Read rewards',
    description: 'The agent can show claimable or accrued reward facts when the connector exposes them.',
  },
  blink_actions: {
    id: 'blink_actions',
    label: 'Blink actions',
    description: 'The connector can prepare ready-to-sign transactions through Solana Actions/Blinks.',
  },
  read_markets: {
    id: 'read_markets',
    label: 'Read markets',
    description: 'The agent can fetch market metadata such as APY, liquidity, and action URLs.',
  },
};

export const PROTOCOL_CONNECTORS: ProtocolConnector[] = [
  {
    id: 'kamino',
    name: 'Kamino Finance',
    aliases: ['kamino', 'kamino finance', 'klend', 'kamino lend'],
    website: 'https://app.kamino.finance',
    description:
      'Supply, withdraw, inspect positions, and prepare earnings proof checks for Kamino Lend.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Positions', 'Earnings proof', 'Claim rewards'],
    actionKinds: ['kamino_deposit', 'kamino_withdraw'],
    readTools: [
      'solana_kamino_get_positions',
      'solana_kamino_prepare_earnings_proof',
      'solana_kamino_reserve_snapshot',
    ],
    enabledByDefault: false,
    initials: 'KM',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    aliases: ['jupiter', 'jup', 'jupiter swap', 'jupiter swap api v2', 'jupiter lend'],
    website: 'https://jup.ag',
    description: 'First-class Jupiter Swap API v2 previews and wallet-approved swaps. Lend, Trigger, Recurring, Token/Price, Prediction, and Perps remain roadmap surfaces.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_markets'],
    supportedActions: ['Swap preview', 'Prepare swap', 'Execute approved swap'],
    actionKinds: ['swap'],
    readTools: ['solana_jupiter_order_preview', 'solana_get_swap_quote'],
    enabledByDefault: false,
    initials: 'JU',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'raydium',
    name: 'Raydium',
    aliases: ['raydium', 'ray'],
    website: 'https://raydium.io',
    description: 'First-class CPMM, CLMM, and farm reads with prepare-only liquidity, fee, and harvest actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Pool snapshot', 'Positions', 'Add liquidity', 'Remove liquidity', 'Collect fees', 'Farm stake', 'Farm unstake', 'Harvest'],
    actionKinds: [
      'raydium_add_liquidity',
      'raydium_remove_liquidity',
      'raydium_collect_fees',
      'raydium_farm_stake',
      'raydium_farm_unstake',
      'raydium_harvest',
    ],
    readTools: [
      'solana_raydium_pool_snapshot',
      'solana_raydium_wallet_positions',
      'solana_raydium_position_detail',
    ],
    enabledByDefault: false,
    initials: 'RY',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'orca',
    name: 'Orca',
    aliases: ['orca', 'whirlpools', 'orca whirlpools'],
    website: 'https://www.orca.so',
    description: 'First-class Whirlpool pool and position reads with prepare-only liquidity, fee, and reward actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['Pools', 'Positions', 'Increase liquidity', 'Decrease liquidity', 'Collect fees', 'Collect rewards'],
    actionKinds: ['orca_increase_liquidity', 'orca_decrease_liquidity', 'orca_collect_fees', 'orca_collect_rewards'],
    readTools: ['solana_orca_whirlpool_snapshot', 'solana_orca_wallet_positions', 'solana_orca_position_detail'],
    enabledByDefault: false,
    initials: 'OR',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'meteora',
    name: 'Meteora',
    aliases: ['meteora', 'dlmm', 'meteora dlmm'],
    website: 'https://app.meteora.ag',
    description: 'First-class DLMM pool and position reads with prepare-only fee, reward, liquidity, and close-position actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: ['DLMM pool snapshot', 'DLMM positions', 'Claim fees', 'Claim rewards', 'Add liquidity', 'Remove liquidity', 'Close position'],
    actionKinds: [
      'meteora_claim_fees',
      'meteora_claim_rewards',
      'meteora_add_liquidity',
      'meteora_remove_liquidity',
      'meteora_close_position',
    ],
    readTools: [
      'solana_meteora_dlmm_pool_snapshot',
      'solana_meteora_wallet_positions',
      'solana_meteora_position_detail',
    ],
    enabledByDefault: false,
    initials: 'MT',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'marginfi',
    name: 'MarginFi',
    aliases: ['marginfi', 'mrgn'],
    website: 'https://app.marginfi.com',
    description: 'First-class bank, account, and health reads with prepare-only deposit, withdraw, borrow, and repay actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'blink_actions', 'read_markets'],
    supportedActions: ['Bank snapshot', 'Accounts', 'Health preview', 'Deposit', 'Withdraw', 'Borrow', 'Repay'],
    actionKinds: ['marginfi_deposit', 'marginfi_withdraw', 'marginfi_borrow', 'marginfi_repay'],
    readTools: [
      'solana_marginfi_bank_snapshot',
      'solana_marginfi_wallet_accounts',
      'solana_marginfi_account_detail',
      'solana_marginfi_health_preview',
    ],
    enabledByDefault: false,
    initials: 'MF',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'drift',
    name: 'Drift Vaults',
    aliases: ['drift', 'drift vaults', 'strategy vaults'],
    website: 'https://app.drift.trade',
    description:
      'Deposit into Drift strategy vaults and manage the withdraw lifecycle (request, cancel, complete) with plain-English presign review. V1 does not expose perp trading.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Vault deposit',
      'Request withdraw',
      'Cancel withdraw',
      'Complete withdraw',
      'Vault snapshot',
      'User snapshot',
    ],
    actionKinds: [
      'drift_vault_deposit',
      'drift_vault_request_withdraw',
      'drift_vault_cancel_withdraw',
      'drift_vault_complete_withdraw',
    ],
    readTools: [
      'solana_drift_user_snapshot',
      'solana_drift_vault_snapshot',
      'solana_drift_wallet_vault_positions',
      'solana_drift_withdraw_status',
    ],
    enabledByDefault: false,
    initials: 'DV',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'squads',
    name: 'Squads Multisig',
    aliases: ['squads', 'squads multisig', 'squads protocol', 'sqds', 'multisig'],
    website: 'https://squads.so',
    description:
      'Read Squads multisigs, members, thresholds, vaults, and proposals; prepare transfer-only vault proposals and approve, reject, cancel, or execute existing proposals with plain-English presign review. V1 does not expose member/threshold admin changes, program upgrades, treasury swaps, or automated proposal execution.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Wallet authority',
      'Multisig snapshot',
      'Vault snapshot',
      'Proposal snapshot',
      'Proposal list',
      'Create transfer proposal',
      'Approve proposal',
      'Reject proposal',
      'Cancel proposal',
      'Execute proposal',
    ],
    actionKinds: [
      'squads_create_transfer_proposal',
      'squads_approve_proposal',
      'squads_reject_proposal',
      'squads_cancel_proposal',
      'squads_execute_proposal',
    ],
    readTools: [
      'solana_squads_wallet_authority',
      'solana_squads_multisig_snapshot',
      'solana_squads_vault_snapshot',
      'solana_squads_proposal_snapshot',
      'solana_squads_proposal_list',
    ],
    enabledByDefault: false,
    initials: 'SQ',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'realms',
    name: 'Realms',
    aliases: ['realms', 'spl governance', 'spl-governance', 'realms.today'],
    website: 'https://app.realms.today',
    description:
      'Read SPL Governance realms, proposals, vote records, and wallet voting power; prepare cast vote, relinquish vote, and deposit / withdraw governance token approvals. Voting is not execution.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Wallet governance',
      'Realm snapshot',
      'Governance snapshot',
      'Proposal list',
      'Proposal snapshot',
      'Vote record',
      'Cast vote',
      'Relinquish vote',
      'Deposit governance tokens',
      'Withdraw governance tokens',
    ],
    actionKinds: [
      'realms_cast_vote',
      'realms_relinquish_vote',
      'realms_deposit_governance_tokens',
      'realms_withdraw_governance_tokens',
    ],
    readTools: [
      'solana_realms_wallet_governance',
      'solana_realms_realm_snapshot',
      'solana_realms_governance_snapshot',
      'solana_realms_proposal_list',
      'solana_realms_proposal_snapshot',
      'solana_realms_vote_record',
    ],
    enabledByDefault: false,
    initials: 'RG',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'lulo',
    name: 'Lulo',
    aliases: ['lulo', 'lulo finance', 'lulo protected', 'lulo boost'],
    website: 'https://app.lulo.fi',
    description: 'Lulo Protected, Boost, and Regular lending: read live rates, pool metadata, and wallet balances, then prepare deposit/withdraw approvals for the wallet to sign.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Complete withdrawal'],
    actionKinds: ['lulo_deposit', 'lulo_withdraw', 'lulo_complete_withdraw'],
    readTools: [
      'solana_lulo_rates',
      'solana_lulo_pool_meta',
      'solana_lulo_wallet_balances',
    ],
    enabledByDefault: false,
    initials: 'LU',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'save',
    name: 'Save',
    aliases: ['save', 'save finance', 'solend'],
    website: 'https://save.finance',
    description:
      'Supply, withdraw, borrow, or repay against Save (formerly Solend) Lend reserves with health-aware presign review.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: ['Deposit', 'Withdraw', 'Borrow', 'Repay', 'Obligation', 'Health preview'],
    actionKinds: ['save_deposit', 'save_withdraw', 'save_borrow', 'save_repay'],
    readTools: [
      'solana_save_reserve_snapshot',
      'solana_save_market_snapshot',
      'solana_save_wallet_obligation',
      'solana_save_health_preview',
    ],
    enabledByDefault: false,
    initials: 'SV',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
  },
  {
    id: 'jito',
    name: 'Jito',
    aliases: ['jito', 'jitosol', 'jito sol', 'jito stake pool', 'jito liquid staking'],
    website: 'https://www.jito.network',
    description:
      'First-class JitoSOL liquid staking reads with prepare-only stake, existing stake-account deposit, unstake, and inactive stake-account SOL withdrawal actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Stake pool',
      'JitoSOL balance',
      'Stake accounts',
      'Quote',
      'Stake SOL',
      'Deposit stake account',
      'Unstake JitoSOL',
      'Withdraw SOL',
    ],
    actionKinds: [
      'jito_stake_sol',
      'jito_deposit_stake_account',
      'jito_unstake_jitosol',
      'jito_withdraw_sol',
    ],
    readTools: [
      'solana_jito_stake_pool_snapshot',
      'solana_jito_wallet_positions',
      'solana_jito_wallet_stake_accounts',
      'solana_jito_quote',
    ],
    enabledByDefault: false,
    initials: 'JT',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'marinade',
    name: 'Marinade',
    aliases: ['marinade', 'marinade finance', 'msol', 'marinade liquid staking', 'marinade native'],
    website: 'https://marinade.finance',
    description:
      'First-class Marinade mSOL liquid staking reads with prepare-only liquid stake, Jupiter instant unstake, delayed unstake, and delayed-unstake claim actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions', 'read_markets'],
    supportedActions: [
      'State',
      'Positions',
      'Native stake accounts',
      'Unstake tickets',
      'Quote',
      'Liquid stake',
      'Instant unstake',
      'Delayed unstake',
      'Claim delayed unstake',
    ],
    actionKinds: [
      'marinade_liquid_stake',
      'marinade_liquid_unstake',
      'marinade_delayed_unstake',
      'marinade_claim_delayed_unstake',
    ],
    readTools: [
      'solana_marinade_state_snapshot',
      'solana_marinade_wallet_positions',
      'solana_marinade_wallet_stake_accounts',
      'solana_marinade_unstake_tickets',
      'solana_marinade_quote',
    ],
    enabledByDefault: false,
    initials: 'MR',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'sanctum',
    name: 'Sanctum',
    aliases: ['sanctum', 'sanctum infinity', 'infinity', 'inf', 'lst', 'liquid staking'],
    website: 'https://app.sanctum.so',
    description:
      'First-class Sanctum LST, Router, and Infinity reads with prepare-only swap, stake, unstake, and INF liquidity actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'blink_actions', 'read_markets'],
    supportedActions: [
      'LST catalog',
      'LST snapshot',
      'Infinity pool',
      'Wallet positions',
      'Quote',
      'Swap LST',
      'Add Infinity liquidity',
      'Remove Infinity liquidity',
      'Stake SOL to LST',
      'Unstake LST to SOL',
    ],
    actionKinds: [
      'sanctum_swap_lst',
      'sanctum_add_infinity_liquidity',
      'sanctum_remove_infinity_liquidity',
      'sanctum_stake_sol_to_lst',
      'sanctum_unstake_lst_to_sol',
    ],
    readTools: [
      'solana_sanctum_lst_list',
      'solana_sanctum_lst_snapshot',
      'solana_sanctum_infinity_pool_snapshot',
      'solana_sanctum_wallet_positions',
      'solana_sanctum_quote',
    ],
    enabledByDefault: false,
    initials: 'ST',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'magiceden',
    name: 'Magic Eden',
    aliases: ['magiceden', 'magic eden', 'me', 'magic-eden'],
    website: 'https://magiceden.io',
    description:
      'Read Magic Eden Solana collections, listings, bids, activity, and wallet NFTs; prepare buy, list, cancel listing, bid, and cancel bid for wallet approval. Feature-flagged; gated by Magic Eden API health.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'API health',
      'Collection snapshot',
      'Listings',
      'Bids',
      'Wallet NFTs',
      'NFT detail',
      'Buy',
      'List',
      'Cancel listing',
      'Bid',
      'Cancel bid',
    ],
    actionKinds: [
      'magiceden_buy',
      'magiceden_list',
      'magiceden_cancel_listing',
      'magiceden_bid',
      'magiceden_cancel_bid',
    ],
    readTools: [
      'solana_magiceden_api_health',
      'solana_magiceden_collection_snapshot',
      'solana_magiceden_collection_listings',
      'solana_magiceden_collection_bids',
      'solana_magiceden_recent_activity',
      'solana_magiceden_wallet_nfts',
      'solana_magiceden_nft_detail',
    ],
    enabledByDefault: false,
    initials: 'ME',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: true,
  },
  {
    id: 'tensor',
    name: 'Tensor',
    aliases: ['tensor', 'tensor trade', 'tensor nft', 'tensor marketplace', 'tcomp'],
    website: 'https://www.tensor.trade',
    description:
      'Read Tensor NFT collection floor, listings, bids, recent sales, wallet NFTs, and marketplace exposure; prepare buy, list, cancel listing, bid, cancel bid, and capped sweep for wallet approval.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Collection snapshot',
      'Listings',
      'Bids',
      'Recent sales',
      'Wallet NFTs',
      'NFT detail',
      'Wallet exposure',
      'Buy',
      'List',
      'Cancel listing',
      'Bid',
      'Cancel bid',
      'Sweep',
    ],
    actionKinds: [
      'tensor_buy',
      'tensor_list',
      'tensor_cancel_listing',
      'tensor_bid',
      'tensor_cancel_bid',
      'tensor_sweep',
    ],
    readTools: [
      'solana_tensor_collection_snapshot',
      'solana_tensor_collection_listings',
      'solana_tensor_collection_bids',
      'solana_tensor_recent_sales',
      'solana_tensor_wallet_nfts',
      'solana_tensor_nft_detail',
      'solana_tensor_wallet_marketplace_exposure',
    ],
    enabledByDefault: false,
    initials: 'TE',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: true,
  },
  {
    id: 'pyth',
    name: 'Pyth',
    aliases: ['pyth', 'pyth network', 'pyth oracle'],
    website: 'https://pyth.network',
    description:
      'First-class oracle reads: price feeds, batch reads, feed search, on-chain price-update accounts, and oracle evidence. Optional prepare path posts a fresh price update via the Pyth Solana Receiver program.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_markets'],
    supportedActions: [
      'Price feed',
      'Batch prices',
      'Feed search',
      'On-chain account',
      'Oracle evidence',
      'Post price update',
    ],
    actionKinds: ['pyth_post_price_update'],
    readTools: [
      'solana_pyth_price_feed',
      'solana_pyth_price_feeds_batch',
      'solana_pyth_feed_search',
      'solana_pyth_onchain_price_account',
      'solana_pyth_oracle_evidence',
    ],
    enabledByDefault: false,
    initials: 'PY',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
];

export const KNOWN_CONNECTED_DAPPS = PROTOCOL_CONNECTORS;

export function emptyConnectedDapps(): ConnectedDappsState {
  const entries = {} as Record<ProtocolConnectorId, ProtocolConnectorEntry>;
  for (const connector of PROTOCOL_CONNECTORS) {
    entries[connector.id] = {
      enabled: connector.enabledByDefault,
      ...(connector.enabledByDefault ? { enabledAt: new Date().toISOString() } : {}),
    };
  }
  return { schemaVersion: 2, entries };
}

export function loadConnectedDapps(): ConnectedDappsState {
  if (typeof window === 'undefined') return emptyConnectedDapps();
  try {
    const raw = window.localStorage.getItem(PROTOCOL_CONNECTORS_STORAGE_KEY);
    if (raw) return normalizeConnectedDapps(JSON.parse(raw));
    const legacyRaw = window.localStorage.getItem(CONNECTED_DAPPS_STORAGE_KEY);
    if (legacyRaw) return normalizeConnectedDapps(JSON.parse(legacyRaw));
    return emptyConnectedDapps();
  } catch {
    return emptyConnectedDapps();
  }
}

export function saveConnectedDapps(state: ConnectedDappsState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROTOCOL_CONNECTORS_STORAGE_KEY, JSON.stringify(normalizeConnectedDapps(state)));
  } catch {
    // Best-effort browser persistence.
  }
}

export function normalizeConnectedDapps(raw: unknown): ConnectedDappsState {
  if (!raw || typeof raw !== 'object') return emptyConnectedDapps();
  const rawEntries = (raw as { entries?: unknown }).entries;
  const result: Record<ProtocolConnectorId, ProtocolConnectorEntry> = {} as Record<
    ProtocolConnectorId,
    ProtocolConnectorEntry
  >;
  for (const connector of PROTOCOL_CONNECTORS) {
    const candidate =
      rawEntries && typeof rawEntries === 'object'
        ? (rawEntries as Record<string, unknown>)[connector.id]
        : undefined;
    const enabled =
      candidate && typeof candidate === 'object' && 'enabled' in candidate
        ? Boolean((candidate as { enabled?: unknown }).enabled)
        : connector.enabledByDefault;
    const enabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { enabledAt?: unknown }).enabledAt === 'string'
        ? ((candidate as { enabledAt: string }).enabledAt)
        : undefined;
    const disabledAt =
      candidate && typeof candidate === 'object' && typeof (candidate as { disabledAt?: unknown }).disabledAt === 'string'
        ? ((candidate as { disabledAt: string }).disabledAt)
        : undefined;
    result[connector.id] = {
      enabled,
      ...(enabledAt && { enabledAt }),
      ...(disabledAt && { disabledAt }),
    };
  }
  return { schemaVersion: 2, entries: result };
}

export function getAdapterMeta(id: ConnectedDappId): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.id === id);
}

export function findAdapterByActionKind(kind: string): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.actionKinds.includes(kind));
}

export function findAdapterByReadTool(tool: string): ConnectedDappAdapter | undefined {
  return PROTOCOL_CONNECTORS.find((connector) => connector.readTools.includes(tool));
}

export function findAdapterForActionOrTool(actionKindOrTool: string): ConnectedDappAdapter | undefined {
  return findAdapterByActionKind(actionKindOrTool) ?? findAdapterByReadTool(actionKindOrTool);
}

export function findProtocolConnectorByInput(value: string | undefined): ProtocolConnector | undefined {
  const normalized = normalizeConnectorSearch(value);
  if (!normalized) return undefined;
  return PROTOCOL_CONNECTORS.find((connector) =>
    connector.id === normalized ||
    connector.aliases.some((alias) => {
      const aliasKey = normalizeConnectorSearch(alias);
      return aliasKey === normalized || normalized.includes(aliasKey);
    }) ||
    normalizeConnectorSearch(connector.name) === normalized ||
    normalized.includes(normalizeConnectorSearch(connector.name)),
  );
}

export function isClusterSupported(adapter: ConnectedDappAdapter, cluster: string): boolean {
  return adapter.supportedClusters.includes(cluster as ConnectedDappCluster);
}

export function connectorHasCapability(
  connector: ConnectedDappAdapter,
  capability: ProtocolConnectorCapabilityId,
): boolean {
  return connector.capabilities.includes(capability);
}

export function isDappEnabled(
  id: ConnectedDappId,
  state: ConnectedDappsState,
  cluster: string,
): boolean {
  const connector = getAdapterMeta(id);
  if (!connector) return false;
  if (!isClusterSupported(connector, cluster)) return false;
  return state.entries[id]?.enabled === true;
}

export interface ConnectedDappCheckOk {
  ok: true;
  adapter: ConnectedDappAdapter;
}

export interface ConnectedDappCheckBlocked {
  ok: false;
  reason: 'disabled' | 'unsupported_cluster' | 'unknown_adapter' | 'missing_capability';
  adapter?: ConnectedDappAdapter;
  message: string;
}

export type ConnectedDappCheck = ConnectedDappCheckOk | ConnectedDappCheckBlocked;

export function checkDappForKind(
  actionKindOrTool: string,
  state: ConnectedDappsState,
  cluster: string,
): ConnectedDappCheck {
  const connector = findAdapterForActionOrTool(actionKindOrTool);
  if (!connector) {
    return {
      ok: false,
      reason: 'unknown_adapter',
      message: `No Protocol Connector is registered for ${actionKindOrTool}.`,
    };
  }
  return checkProtocolConnector(connector.id, state, cluster);
}

export function checkProtocolConnector(
  id: ProtocolConnectorId,
  state: ConnectedDappsState,
  cluster: string,
  capability?: ProtocolConnectorCapabilityId,
): ConnectedDappCheck {
  const connector = getAdapterMeta(id);
  if (!connector) {
    return {
      ok: false,
      reason: 'unknown_adapter',
      message: `No Protocol Connector is registered for ${id}.`,
    };
  }
  if (!isClusterSupported(connector, cluster)) {
    return {
      ok: false,
      reason: 'unsupported_cluster',
      adapter: connector,
      message: `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${cluster}.`,
    };
  }
  if (state.entries[connector.id]?.enabled !== true) {
    return {
      ok: false,
      reason: 'disabled',
      adapter: connector,
      message: `${connector.name} is not enabled. Enable it in Protocol Connectors before continuing.`,
    };
  }
  if (capability && !connectorHasCapability(connector, capability)) {
    return {
      ok: false,
      reason: 'missing_capability',
      adapter: connector,
      message: `${connector.name} does not expose ${PROTOCOL_CONNECTOR_CAPABILITIES[capability].label}.`,
    };
  }
  return { ok: true, adapter: connector };
}

export function enabledProtocolConnectors(
  state: ConnectedDappsState,
  cluster: string,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS.filter((connector) => isDappEnabled(connector.id, state, cluster));
}

export function disabledProtocolConnectors(
  state: ConnectedDappsState,
  cluster: string,
): ProtocolConnector[] {
  return PROTOCOL_CONNECTORS.filter((connector) => !isDappEnabled(connector.id, state, cluster));
}

export function connectedDappsSummary(state: ConnectedDappsState, cluster: string): string {
  const enabled = enabledProtocolConnectors(state, cluster);
  if (enabled.length === 0) {
    return `No protocol connectors enabled · ${PROTOCOL_CONNECTORS.length} available`;
  }
  if (enabled.length === 1) return `${enabled[0]!.name} connector enabled`;
  return `${enabled.length} of ${PROTOCOL_CONNECTORS.length} protocol connectors enabled`;
}

export function protocolConnectorPlannerContext(
  state: ConnectedDappsState,
  cluster: string,
  opts: { dialectClientKeyConfigured?: boolean; includeDisabled?: boolean } = {},
): Array<Record<string, unknown>> {
  const connectors = opts.includeDisabled
    ? PROTOCOL_CONNECTORS.filter((connector) => isClusterSupported(connector, cluster))
    : enabledProtocolConnectors(state, cluster);
  return connectors.map((connector) => {
    const enabled = isDappEnabled(connector.id, state, cluster);
    const readReady = enabled && (connector.requiresClientKey ? Boolean(opts.dialectClientKeyConfigured) : true);
    return {
      id: connector.id,
      name: connector.name,
      enabled,
      aliases: connector.aliases,
      capabilities: connector.capabilities,
      supportedActions: connector.supportedActions,
      readActions: connector.readTools.map((tool) => ({
        tool,
        requiresClientKey: Boolean(connector.requiresClientKey),
        ready: readReady,
      })),
      writeActions: connector.actionKinds.map((kind) => ({
        kind,
        executionMode: connector.actionSource ?? 'none',
        ready: enabled && Boolean(connector.actionSource),
        approvalBoundary: 'prepare_only_wallet_approval_required',
      })),
      readSource: connector.readSource ?? 'none',
      actionSource: connector.actionSource ?? 'none',
      agentUse:
        'Use read actions as facts for answers/reviews. Use write actions only to prepare approval-bound wallet work; never claim the connector can sign or submit without the wallet.',
      readApiReady: readReady,
      readiness: enabled
        ? readReady
          ? 'ready'
          : 'needs_client_key'
        : 'disabled',
      limitation: !enabled
        ? `${connector.name} is not enabled in Protocol Connectors.`
        : connector.requiresClientKey && !opts.dialectClientKeyConfigured
          ? 'Read APIs need a Dialect client key; Blink/action URLs can still be reviewed if supplied.'
          : undefined,
    };
  });
}

export function setConnectedDappEnabled(
  state: ConnectedDappsState,
  id: ConnectedDappId,
  enabled: boolean,
  now: Date = new Date(),
): ConnectedDappsState {
  const connector = getAdapterMeta(id);
  if (!connector) return state;
  const normalized = normalizeConnectedDapps(state);
  const previous = normalized.entries[id] ?? { enabled: connector.enabledByDefault };
  const nextEntry: ConnectedDappEntry = enabled
    ? { enabled: true, enabledAt: now.toISOString(), ...(previous.disabledAt ? { disabledAt: previous.disabledAt } : {}) }
    : { enabled: false, disabledAt: now.toISOString(), ...(previous.enabledAt ? { enabledAt: previous.enabledAt } : {}) };
  return {
    schemaVersion: 2,
    entries: {
      ...normalized.entries,
      [id]: nextEntry,
    },
  };
}

function normalizeConnectorSearch(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
