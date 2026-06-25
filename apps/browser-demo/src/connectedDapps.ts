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
  | 'project0'
  | 'drift'
  | 'phoenix'
  | 'lulo'
  | 'save'
  | 'jito'
  | 'marinade'
  | 'sanctum'
  | 'tensor'
  | 'magiceden'
  | 'realms'
  | 'mayan'
  | 'pyth'
  | 'squads'
  | 'wormhole';

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
    aliases: ['jupiter', 'jup', 'jupiter swap', 'jupiter swap api v2', 'jupiter lend', 'jupiter earn', 'jupiter borrow', 'jupiter token', 'jupiter price', 'jupiter prediction', 'jupiter perps', 'jupiter perpetuals', 'jupiter trigger', 'jupiter limit', 'jupiter recurring', 'jupiter dca'],
    website: 'https://jup.ag',
    description: 'First-class Jupiter Swap API v2 previews, wallet-approved swaps, Jupiter Lend Earn / Borrow, read-only Token API V2 / Price API V3 evidence, beta read-only Prediction markets, read-only Perps status, Jupiter Trigger limit orders, and Jupiter Recurring DCA. Trigger and Recurring are disabled by default; Perps writes remain disabled.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_markets', 'read_positions'],
    supportedActions: [
      'Swap preview',
      'Prepare swap',
      'Execute approved swap',
      'Earn deposit / withdraw / mint / redeem',
      'Borrow create / deposit collateral / borrow / repay / withdraw collateral',
      'Token search',
      'Token risk evidence',
      'Price evidence',
      'Prediction events (beta)',
      'Prediction markets / orderbook (beta)',
      'Prediction wallet orders, positions, history, vault (beta)',
      'Perps status (read-only)',
      'Trigger V2 auth challenge / verify / status',
      'Trigger V2 vault read / register',
      'Trigger V2 orders / detail / history',
      'Trigger limit / stop / TP-SL / OCO / OTOCO / edit / cancel / withdraw',
      'Recurring orders / detail / quote',
      'Recurring DCA create / cancel',
      'Deprecated Recurring price-order deposit / withdraw',
    ],
    actionKinds: [
      'swap',
      'jupiter_lend_earn_deposit',
      'jupiter_lend_earn_withdraw',
      'jupiter_lend_earn_mint',
      'jupiter_lend_earn_redeem',
      'jupiter_lend_borrow_create_position',
      'jupiter_lend_borrow_deposit_collateral',
      'jupiter_lend_borrow_borrow',
      'jupiter_lend_borrow_repay',
      'jupiter_lend_borrow_withdraw_collateral',
      'jupiter_trigger_register_vault',
      'jupiter_trigger_single_order',
      'jupiter_trigger_oco_order',
      'jupiter_trigger_otoco_order',
      'jupiter_trigger_edit_order',
      'jupiter_trigger_cancel_order',
      'jupiter_trigger_withdraw_order_funds',
      'jupiter_recurring_create_time_order',
      'jupiter_recurring_cancel_order',
      'jupiter_recurring_deposit_price_order',
      'jupiter_recurring_withdraw_price_order',
      'jupiter_prediction_create_order',
      'jupiter_prediction_close_position',
      'jupiter_prediction_claim_position',
    ],
    readTools: [
      'solana_jupiter_order_preview',
      'solana_get_swap_quote',
      'solana_jupiter_token_search',
      'solana_jupiter_token_by_tag',
      'solana_jupiter_token_category',
      'solana_jupiter_token_recent',
      'solana_jupiter_price',
      'solana_jupiter_price_batch',
      'solana_jupiter_token_risk_evidence',
      'solana_jupiter_lend_earn_tokens',
      'solana_jupiter_lend_earn_token_detail',
      'solana_jupiter_lend_earn_positions',
      'solana_jupiter_lend_earn_earnings',
      'solana_jupiter_lend_borrow_vaults',
      'solana_jupiter_lend_borrow_vault_detail',
      'solana_jupiter_lend_borrow_positions',
      'solana_jupiter_lend_borrow_health_preview',
      'solana_jupiter_prediction_events',
      'solana_jupiter_prediction_search_events',
      'solana_jupiter_prediction_event_detail',
      'solana_jupiter_prediction_event_markets',
      'solana_jupiter_prediction_market_detail',
      'solana_jupiter_prediction_orderbook',
      'solana_jupiter_prediction_orders',
      'solana_jupiter_prediction_order_status',
      'solana_jupiter_prediction_positions',
      'solana_jupiter_prediction_history',
      'solana_jupiter_prediction_vault_info',
      'solana_jupiter_perps_status',
      'solana_jupiter_perps_pool_snapshot',
      'solana_jupiter_perps_custody_snapshot',
      'solana_jupiter_perps_position_snapshot',
      'solana_jupiter_trigger_auth_challenge',
      'solana_jupiter_trigger_auth_verify',
      'solana_jupiter_trigger_auth_status',
      'solana_jupiter_trigger_vault',
      'solana_jupiter_trigger_orders',
      'solana_jupiter_trigger_order_detail',
      'solana_jupiter_trigger_order_history',
      'solana_jupiter_recurring_orders',
      'solana_jupiter_recurring_order_detail',
      'solana_jupiter_recurring_quote',
    ],
    enabledByDefault: true,
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
    capabilities: ['first_class_adapter', 'read_positions', 'read_rewards', 'read_markets'],
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
      'solana_raydium_quote_add_liquidity',
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
    id: 'project0',
    name: 'Project 0',
    aliases: ['project0', 'project 0', 'p0', '0dotxyz', '0.xyz', 'zero'],
    website: 'https://app.0.xyz',
    description:
      'First-class Project 0 bank, strategy, wallet, account, and health reads with prepare-only account creation, deposit, withdraw, borrow, and repay actions. MarginFi remains available as a separate connector.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'blink_actions', 'read_markets'],
    supportedActions: ['Banks', 'Strategies', 'Wallet holdings', 'Account health', 'Create account', 'Deposit', 'Withdraw', 'Borrow', 'Repay'],
    actionKinds: [
      'project0_create_account',
      'project0_deposit',
      'project0_withdraw',
      'project0_borrow',
      'project0_repay',
    ],
    readTools: [
      'solana_project0_banks',
      'solana_project0_strategies',
      'solana_project0_wallet',
      'solana_project0_account_detail',
      'solana_project0_health_preview',
    ],
    enabledByDefault: false,
    initials: 'P0',
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
    id: 'phoenix',
    name: 'Phoenix Perpetuals',
    aliases: ['phoenix', 'phoenix perp', 'phoenix perps', 'phoenix perpetuals', 'phoenix trade', 'ellipsis perps'],
    website: 'https://www.phoenix.trade',
    description:
      'Perp futures on Solana (Ellipsis Labs). Read markets, positions, funding, and health preview; prepare-only open / close / modify-collateral / trigger / cancel-order actions with plain-English presign review. Requires a Phoenix invite/activation code in Connector API keys.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Open',
      'Close',
      'Modify collateral',
      'Place trigger',
      'Cancel order',
      'Market snapshot',
      'Position snapshot',
      'Health preview',
      'Funding history',
    ],
    actionKinds: [
      'phoenix_open',
      'phoenix_close',
      'phoenix_modify_collateral',
      'phoenix_place_trigger',
      'phoenix_cancel_order',
    ],
    readTools: [
      'solana_phoenix_market_snapshot',
      'solana_phoenix_market_catalog',
      'solana_phoenix_position_snapshot',
      'solana_phoenix_wallet_positions',
      'solana_phoenix_funding_history',
      'solana_phoenix_health_preview',
    ],
    enabledByDefault: false,
    initials: 'PX',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: true,
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
      'First-class JitoSOL liquid staking reads with prepare-only stake, existing stake-account deposit, receipt claim, unstake, and inactive stake-account SOL withdrawal actions.',
    supportedClusters: ['mainnet-beta'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Stake pool',
      'JitoSOL balance',
      'Stake accounts',
      'Quote',
      'Stake SOL',
      'Deposit stake account',
      'Deposit receipts',
      'Claim deposit receipt',
      'Unstake JitoSOL',
      'Withdraw SOL',
    ],
    actionKinds: [
      'jito_stake_sol',
      'jito_deposit_stake_account',
      'jito_claim_deposit_receipt',
      'jito_unstake_jitosol',
      'jito_withdraw_sol',
    ],
    readTools: [
      'solana_jito_stake_pool_snapshot',
      'solana_jito_wallet_positions',
      'solana_jito_wallet_stake_accounts',
      'solana_jito_quote',
      'solana_jito_deposit_receipts',
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
    id: 'wormhole',
    name: 'Wormhole',
    aliases: ['wormhole', 'portal bridge', 'token bridge', 'wormhole token bridge', 'wtt', 'cctp bridge'],
    website: 'https://wormhole.com',
    description:
      'First-class bridge reads and prepare-only Solana-source Wormhole token transfers, Solana-compatible redeem, and recovery/resume actions.',
    supportedClusters: ['mainnet-beta', 'devnet'],
    capabilities: ['first_class_adapter', 'read_positions', 'read_markets'],
    supportedActions: [
      'Supported routes',
      'Token snapshot',
      'Quote',
      'Transfer status',
      'Wallet bridge exposure',
      'Bridge transfer',
      'Redeem on Solana',
      'Recover or resume',
    ],
    actionKinds: [
      'wormhole_transfer',
      'wormhole_redeem',
      'wormhole_recover_or_resume',
    ],
    readTools: [
      'solana_wormhole_supported_routes',
      'solana_wormhole_token_snapshot',
      'solana_wormhole_quote',
      'solana_wormhole_transfer_status',
      'solana_wormhole_wallet_bridge_exposure',
    ],
    enabledByDefault: false,
    initials: 'WH',
    readSource: 'first-class-adapter',
    actionSource: 'first-class-adapter',
    requiresClientKey: false,
  },
  {
    id: 'mayan',
    name: 'Mayan',
    aliases: ['mayan', 'mayan finance', 'mayan swap', 'mayan swift', 'cross-chain swap'],
    website: 'https://mayan.finance',
    description:
      'Planned Mayan cross-chain swap connector entry for supported route reads, quote review, swap status, pending swaps, and prepare-only resume or refund actions. Runtime tools still need to be wired before executable work is exposed.',
    supportedClusters: ['mainnet-beta'],
    capabilities: [],
    supportedActions: [
      'Supported chains',
      'Supported tokens',
      'Quote',
      'Swap status',
      'Pending swaps',
      'Cross-chain swap',
      'Resume or refund',
    ],
    actionKinds: [],
    readTools: [],
    enabledByDefault: false,
    initials: 'MY',
    requiresClientKey: false,
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
  // Jupiter needs no connection — every Jupiter action (swap/lend/limit/DCA/borrow)
  // is covered by Agentic's shared Jupiter API key, so it is ALWAYS enabled and
  // never gated on a Preferences toggle.
  if (id === 'jupiter') return true;
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
  // Jupiter is always on — covered by Agentic's shared Jupiter API key, never gated on a toggle
  // (matches isDappEnabled's Jupiter exemption).
  if (connector.id !== 'jupiter' && state.entries[connector.id]?.enabled !== true) {
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
