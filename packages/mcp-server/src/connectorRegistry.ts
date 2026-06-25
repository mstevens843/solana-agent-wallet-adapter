import type { Cluster } from '@solana-agent-wallet-adapter/core';

import { getJupiterPredictionPolicy, getJupiterRecurringPolicy, getJupiterTriggerPolicy, type AgentWalletConfig } from './config.js';
import { describeDriftUnavailableReason } from './adapters/drift/client.js';
import { describeJitoUnavailableReason } from './adapters/jito/client.js';
import { getJupiterApiKey, jupiterApiHost } from './adapters/jupiter/client.js';
import { describeJupiterLendReadUnavailableReason } from './adapters/jupiter/lendClient.js';
import { describeJupiterTokenPriceUnavailableReason } from './adapters/jupiter/tokenClient.js';
import { describeKaminoUnavailableReason } from './adapters/kamino/client.js';
import { describeLuloUnavailableReason } from './adapters/lulo/client.js';
import { describeMagicedenUnavailableReason } from './adapters/magiceden/client.js';
import { describeMarinadeUnavailableReason } from './adapters/marinade/client.js';
import { describeMarginfiUnavailableReason } from './adapters/marginfi/client.js';
import { describeMeteoraUnavailableReason } from './adapters/meteora/client.js';
import { describeOrcaUnavailableReason } from './adapters/orca/client.js';
import { describeProject0SdkUnavailableReason } from './adapters/project0/client.js';
import {
  describePythReceiverUnavailableReason,
  describePythUnavailableReason,
} from './adapters/pyth/client.js';
import { describeRaydiumUnavailableReason } from './adapters/raydium/client.js';
import { describeRealmsUnavailableReason } from './adapters/realms/client.js';
import { describeSolendUnavailableReason } from './adapters/save/client.js';
import { describeSanctumUnavailableReason } from './adapters/sanctum/client.js';
import { describeSquadsUnavailableReason } from './adapters/squads/client.js';
import { describePhoenixUnavailableReason } from './adapters/phoenix/client.js';
import { describeTensorUnavailableReason } from './adapters/tensor/client.js';
import { describeWormholeUnavailableReason } from './adapters/wormhole/client.js';

export type ConnectorId =
  | 'kamino'
  | 'jupiter'
  | 'meteora'
  | 'raydium'
  | 'orca'
  | 'marginfi'
  | 'project0'
  | 'drift'
  | 'lulo'
  | 'save'
  | 'jito'
  | 'marinade'
  | 'tensor'
  | 'magiceden'
  | 'sanctum'
  | 'pyth'
  | 'realms'
  | 'squads'
  | 'wormhole'
  | 'phoenix';

export type ConnectorCapability =
  | 'positions'
  | 'rewards'
  | 'markets'
  | 'blinks'
  | 'swap'
  | 'tokens'
  | 'price'
  | 'earn'
  | 'borrow'
  | 'withdraw'
  | 'repay'
  | 'add_liquidity'
  | 'close'
  | 'marketplace'
  | 'oracle'
  | 'governance'
  | 'treasury'
  | 'bridge'
  | 'strategies'
  | 'prediction'
  | 'perps'
  | 'trigger'
  | 'recurring';

export type ConnectorExecutionMode =
  | 'first_class_prepare'
  | 'wallet_approval'
  | 'read_only'
  | 'unavailable';

export interface ConnectorRegistryEntry {
  id: ConnectorId;
  name: string;
  aliases: string[];
  supportedClusters: Cluster[];
  readCapabilities: ConnectorCapability[];
  writeCapabilities: ConnectorCapability[];
  readTools: string[];
  actionTools: string[];
  requiresClientKey: boolean;
  requiredConfig: string[];
  executionMode: ConnectorExecutionMode;
  approvalBoundary: string;
  limitations: string[];
  examples: string[];
}

export interface ConnectorReadiness {
  ready: boolean;
  reason?: string;
}

export interface ConnectorCapabilityView extends ConnectorRegistryEntry {
  readiness: {
    reads: ConnectorReadiness;
    actions: ConnectorReadiness;
  };
  productReadiness?: {
    swap: ConnectorReadiness;
    lendEarn: ConnectorReadiness;
    lendBorrow: ConnectorReadiness;
    trigger: ConnectorReadiness;
    recurring: ConnectorReadiness;
    tokens: ConnectorReadiness;
    price: ConnectorReadiness;
    prediction: ConnectorReadiness;
    perpsReadonly: ConnectorReadiness;
  };
}

export const CONNECTOR_APPROVAL_BOUNDARY =
  'This prepares a wallet approval request; it does not sign, submit, or grant delegated authority.';

export const CONNECTOR_REGISTRY: ConnectorRegistryEntry[] = [
  {
    id: 'kamino',
    name: 'Kamino Finance',
    aliases: ['kamino', 'kamino finance', 'klend', 'kamino lend'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'rewards', 'markets'],
    writeCapabilities: ['earn', 'withdraw'],
    readTools: [
      'solana_connector_read_facts',
      'solana_kamino_reserve_snapshot',
      'solana_kamino_get_positions',
      'solana_kamino_prepare_earnings_proof',
    ],
    actionTools: [
      'solana_prepare_kamino_deposit',
      'solana_prepare_kamino_withdraw',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['Kamino client factory or @kamino-finance/klend-sdk integration'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Kamino client to be wired by the host process.',
      'Deposits and withdrawals become prepared approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my Kamino positions',
      'show the SOL Kamino reserve APY',
      'prepare an earnings proof for Kamino',
      'supply 0.1 SOL to Kamino',
      'withdraw 0.05 SOL from Kamino',
    ],
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    aliases: ['jupiter', 'jup', 'jupiter swap', 'jupiter swap api v2', 'jupiter ultra', 'jupiter lend', 'jupiter earn', 'jupiter borrow', 'jupiter token', 'jupiter price', 'jupiter prediction', 'jupiter perps', 'jupiter perpetuals', 'jupiter trigger', 'jupiter limit', 'jupiter recurring', 'jupiter dca'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['swap', 'tokens', 'price', 'earn', 'borrow', 'positions', 'markets', 'prediction', 'perps', 'trigger', 'recurring'],
    writeCapabilities: ['swap', 'earn', 'borrow', 'withdraw', 'repay', 'trigger', 'recurring', 'prediction'],
    readTools: [
      'solana_connector_read_facts',
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
    actionTools: [
      'solana_prepare_swap',
      'solana_swap',
      'solana_prepare_jupiter_lend_earn_deposit',
      'solana_prepare_jupiter_lend_earn_withdraw',
      'solana_prepare_jupiter_lend_earn_mint',
      'solana_prepare_jupiter_lend_earn_redeem',
      'solana_prepare_jupiter_lend_borrow_create_position',
      'solana_prepare_jupiter_lend_borrow_deposit_collateral',
      'solana_prepare_jupiter_lend_borrow_borrow',
      'solana_prepare_jupiter_lend_borrow_repay',
      'solana_prepare_jupiter_lend_borrow_withdraw_collateral',
      'solana_prepare_jupiter_trigger_register_vault',
      'solana_prepare_jupiter_trigger_single_order',
      'solana_prepare_jupiter_trigger_oco_order',
      'solana_prepare_jupiter_trigger_otoco_order',
      'solana_prepare_jupiter_trigger_edit_order',
      'solana_prepare_jupiter_trigger_cancel_order',
      'solana_prepare_jupiter_trigger_withdraw_order_funds',
      'solana_prepare_jupiter_recurring_create_time_order',
      'solana_prepare_jupiter_recurring_cancel_order',
      'solana_prepare_jupiter_recurring_deposit_price_order',
      'solana_prepare_jupiter_recurring_withdraw_price_order',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: ['JUPITER_API_KEY or JUP_API_KEY'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Uses the configured Jupiter Swap API v2 endpoint and Lend API/SDK endpoints.',
      'Order previews require a Jupiter API key.',
      'Prepared swaps can be staged without an API key, but quote preview, direct execution, and approval-time quote refresh require a Jupiter API key.',
      'Jupiter Lend Borrow writes require the optional @jup-ag/lend SDK. Without it, Borrow read facts and Borrow prepares are blocked while Swap and Earn REST reads continue to work.',
      'Borrow and withdraw-collateral prepares require a fresh health preview and are blocked below the configured minimum borrow health ratio (default 1.25).',
      'Token and Price API reads are evidence only; they do not approve actions and are not oracle guarantees.',
      'Flashloans, multiply, unwind, liquidation, vault swap, and leverage loops are not exposed in v1.',
      'Jupiter Prediction is beta and read-only in v1 (no order create/close/claim). Disabled by default until connectors.jupiter.prediction.enabled is set.',
      'Jupiter Perps is exposed as a read-only research surface; solana_jupiter_perps_status reports readiness while pool, custody, and position snapshots return unsupported_method until the official Jupiter Perps API stabilizes. All Perps writes, leverage recommendations, and JLP writes are denied.',
      'Jupiter Trigger V2 (limit/OCO/OTOCO/edit/cancel/withdraw + auth + vault + order reads) is implemented; disabled by default until connectors.jupiter.trigger.enabled (or CONNECTORS_JUPITER_TRIGGER_ENABLED) is set. Trigger orders deposit into a Jupiter-managed Privy custody vault; future fills execute through Jupiter automation outside the Agentic approval inbox. JWTs live only in volatile process memory.',
      'Jupiter Recurring can create/cancel time-based native DCA orders and manage deprecated price orders only after explicit acceptance. Future fills execute through Jupiter automation outside the Agentic approval inbox.',
    ],
    examples: [
      'quote swapping 0.1 SOL to USDC',
      'prepare a swap from SOL to USDC',
      'swap 0.25 SOL to USDC with wallet approval',
      'show Jupiter Earn markets and rates',
      'show my Jupiter Earn positions',
      'prepare depositing 5 USDC into Jupiter Earn',
      'show Jupiter Borrow vaults for SOL/USDC',
      'prepare borrowing 2 USDC only if health stays above 1.5',
      'prepare repaying all of my Jupiter Borrow USDC debt',
      'show Jupiter token risk evidence for this mint',
      'get Jupiter prices for SOL, USDC, and JUP',
      'show live Jupiter prediction markets for crypto',
      'is Jupiter Perps supported here?',
      'show Jupiter Perps API status',
      'show my Jupiter native DCA orders',
      'prepare a Jupiter Recurring order from 100 USDC into SOL over 10 orders',
    ],
  },
  {
    id: 'meteora',
    name: 'Meteora',
    aliases: ['meteora', 'dlmm', 'meteora dlmm'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'rewards', 'markets'],
    writeCapabilities: ['add_liquidity', 'withdraw', 'rewards', 'close'],
    readTools: [
      'solana_connector_read_facts',
      'solana_meteora_dlmm_pool_snapshot',
      'solana_meteora_wallet_positions',
      'solana_meteora_position_detail',
    ],
    actionTools: [
      'solana_prepare_meteora_claim_fees',
      'solana_prepare_meteora_claim_rewards',
      'solana_prepare_meteora_add_liquidity',
      'solana_prepare_meteora_remove_liquidity',
      'solana_prepare_meteora_close_position',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@meteora-ag/dlmm and @coral-xyz/anchor optional dependencies'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta DLMM only.',
      'Reads and prepared actions auto-load the optional Meteora DLMM SDK when installed, or use an injected client factory in tests/hosts.',
      'Some claim and remove-liquidity approvals can require multiple sequential wallet signatures because the Meteora SDK may return multiple transactions.',
      'DAMM, DBC, Alpha Vault, presale, Zap, Dynamic Fee Sharing, delegated/operator positions, and new position creation are not exposed in v1.',
      'Prepared actions refresh DLMM state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'check my Meteora position',
      'show my Meteora DLMM pool',
      'claim Meteora fees',
      'add liquidity to an existing Meteora DLMM position',
      'remove 25 percent of my Meteora liquidity',
    ],
  },
  {
    id: 'raydium',
    name: 'Raydium',
    aliases: ['raydium', 'ray'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'rewards', 'markets'],
    writeCapabilities: ['add_liquidity', 'withdraw', 'rewards', 'earn'],
    readTools: [
      'solana_connector_read_facts',
      'solana_raydium_pool_snapshot',
      'solana_raydium_wallet_positions',
      'solana_raydium_position_detail',
      'solana_raydium_quote_add_liquidity',
    ],
    actionTools: [
      'solana_prepare_raydium_add_liquidity',
      'solana_prepare_raydium_remove_liquidity',
      'solana_prepare_raydium_collect_fees',
      'solana_prepare_raydium_farm_stake',
      'solana_prepare_raydium_farm_unstake',
      'solana_prepare_raydium_harvest',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@raydium-io/raydium-sdk-v2 optional dependency or injected Raydium client factory'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Raydium SDK optional dependency or an injected client factory.',
      'V1 covers pool snapshots, wallet positions, CLMM fee collection, CPMM/CLMM liquidity, and farm stake/unstake/harvest.',
      'Swaps, routing, limit orders, launchpad, permissioned pool administration, and Stake RAY governance flows are not exposed in v1.',
      'Prepared actions refresh Raydium state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'check a Raydium pool',
      'show my Raydium positions',
      'prepare adding liquidity to this Raydium CPMM pool',
      'prepare removing 25 percent of my Raydium CLMM position',
      'harvest rewards from this Raydium farm',
    ],
  },
  {
    id: 'orca',
    name: 'Orca',
    aliases: ['orca', 'whirlpools', 'orca whirlpools'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'rewards', 'markets'],
    writeCapabilities: ['add_liquidity', 'withdraw', 'rewards'],
    readTools: [
      'solana_connector_read_facts',
      'solana_orca_whirlpool_snapshot',
      'solana_orca_wallet_positions',
      'solana_orca_position_detail',
    ],
    actionTools: [
      'solana_prepare_orca_increase_liquidity',
      'solana_prepare_orca_decrease_liquidity',
      'solana_prepare_orca_collect_fees',
      'solana_prepare_orca_collect_rewards',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@orca-so/whirlpools and @solana/kit optional dependencies'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta Whirlpools only.',
      'Reads and prepared actions auto-load the optional Orca Whirlpools SDK when installed, or use an injected client factory in tests/hosts.',
      'Legacy pools, vaults, swaps, delegated managers, and automated LP strategy management are not exposed in v1.',
      'Prepared actions refresh Whirlpool state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'check an Orca Whirlpool',
      'show my Orca Whirlpool positions',
      'prepare increasing liquidity on this Orca position',
      'prepare removing 25 percent of this Orca position',
      'claim Orca fees for this position',
    ],
  },
  {
    id: 'marginfi',
    name: 'MarginFi',
    aliases: ['marginfi', 'mrgn'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets', 'borrow', 'withdraw', 'repay'],
    writeCapabilities: ['earn', 'withdraw', 'borrow', 'repay'],
    readTools: [
      'solana_connector_read_facts',
      'solana_marginfi_bank_snapshot',
      'solana_marginfi_wallet_accounts',
      'solana_marginfi_account_detail',
      'solana_marginfi_health_preview',
    ],
    actionTools: [
      'solana_prepare_marginfi_deposit',
      'solana_prepare_marginfi_withdraw',
      'solana_prepare_marginfi_borrow',
      'solana_prepare_marginfi_repay',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@mrgnlabs/marginfi-client-v2 and @mrgnlabs/mrgn-common optional dependencies'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Borrow and withdraw require a fresh health preview and are blocked below the configured minimum health ratio.',
      'Account delegation, liquidation, flash loans, repay-with-collateral, and authority transfers are not exposed in v1.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my MarginFi positions',
      'show the SOL MarginFi bank',
      'check the health impact of borrowing 5 USDC on MarginFi',
      'prepare depositing 0.01 SOL to MarginFi',
      'prepare repaying all USDC debt on MarginFi',
    ],
  },
  {
    id: 'project0',
    name: 'Project 0',
    aliases: ['project0', 'project 0', 'p0', '0dotxyz', '0.xyz', 'zero'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets', 'strategies', 'borrow', 'withdraw', 'repay'],
    writeCapabilities: ['earn', 'withdraw', 'borrow', 'repay'],
    readTools: [
      'solana_connector_read_facts',
      'solana_project0_banks',
      'solana_project0_strategies',
      'solana_project0_wallet',
      'solana_project0_account_detail',
      'solana_project0_health_preview',
    ],
    actionTools: [
      'solana_prepare_project0_create_account',
      'solana_prepare_project0_deposit',
      'solana_prepare_project0_withdraw',
      'solana_prepare_project0_borrow',
      'solana_prepare_project0_repay',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@0dotxyz/p0-ts-sdk optional dependency for account and prepared action paths'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Public bank, strategy, and wallet reads use https://ai.0.xyz and do not require the SDK.',
      'Account reads and prepared actions require @0dotxyz/p0-ts-sdk.',
      'Borrow and withdraw require a fresh health preview and are blocked below the configured minimum health ratio.',
      'One-click strategy bundles, liquidation, flash loans, delegated authority, and Project 0 Pay automation are not exposed in v1.',
      'MarginFi remains available as a separate connector; Project 0 is added for the new P0 app and migration path.',
    ],
    examples: [
      'show Project 0 banks',
      'show Project 0 strategies',
      'show my Project 0 account health',
      'prepare a Project 0 account',
      'prepare depositing 0.01 SOL to Project 0',
      'prepare borrowing 5 USDC on Project 0',
    ],
  },
  {
    id: 'drift',
    name: 'Drift Vaults',
    aliases: ['drift', 'drift vaults', 'strategy vaults'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets'],
    writeCapabilities: [],
    readTools: [
      'solana_connector_read_facts',
      'solana_drift_user_snapshot',
      'solana_drift_vault_snapshot',
      'solana_drift_wallet_vault_positions',
      'solana_drift_withdraw_status',
    ],
    actionTools: [
      'solana_prepare_drift_vault_deposit',
      'solana_prepare_drift_vault_request_withdraw',
      'solana_prepare_drift_vault_cancel_withdraw',
      'solana_prepare_drift_vault_complete_withdraw',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['Drift client factory or @drift-labs/sdk + @drift-labs/vaults-sdk integration'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'DEPRECATED: Drift Protocol was exploited for ~$285M on 2026-04-01 (DPRK-linked durable-nonce social-engineering + fake-collateral oracle abuse). New write actions are blocked at the policy layer; reads remain so existing-position holders can monitor and unwind. Use Phoenix Perpetuals for new perp positions.',
      'Mainnet-beta only.',
      'V1 covered Drift strategy vault deposit and withdraw lifecycle only. Perp trading, spot margin, leverage, Swift orders, and delegated accounts were never exposed.',
      'Reads require the Drift vault client to be wired by the host process.',
      'Complete-withdraw is blocked until the vault redeem period elapses.',
      'Request-withdraw and complete-withdraw are never batched into one prepared action.',
    ],
    examples: [
      'show my Drift vault positions',
      'check this Drift vault and explain fees and withdraw timing',
      'prepare a Drift vault deposit of 25 USDC',
      'request a Drift vault withdraw for 50 percent of my shares',
      'complete my Drift vault withdrawal if it is ready',
    ],
  },
  {
    id: 'realms',
    name: 'Realms',
    aliases: ['realms', 'spl governance', 'spl-governance', 'realms.today'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets'],
    writeCapabilities: ['earn', 'withdraw'],
    readTools: [
      'solana_connector_read_facts',
      'solana_realms_wallet_governance',
      'solana_realms_realm_snapshot',
      'solana_realms_governance_snapshot',
      'solana_realms_proposal_list',
      'solana_realms_proposal_snapshot',
      'solana_realms_vote_record',
    ],
    actionTools: [
      'solana_prepare_realms_cast_vote',
      'solana_prepare_realms_relinquish_vote',
      'solana_prepare_realms_deposit_governance_tokens',
      'solana_prepare_realms_withdraw_governance_tokens',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@solana/spl-governance integration via setRealmsClientFactory()'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'V1 covers Realms / SPL Governance read facts plus cast vote, relinquish vote, and deposit / withdraw governance tokens. Treasury, program-upgrade, and config proposals are not constructed.',
      'Cast vote is refused when the realm uses a voting power plugin (e.g., VSR), because raw token-owner-record balance is not authoritative there.',
      'Voting is not execution. A vote tipping a threshold does not guarantee proposal execution.',
      'Withdraw is refused when the wallet has outstanding proposals, unrelinquished votes, or a third-party governance delegate set.',
      'No autonomous voting from AI recommendation.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my Realms voting power',
      'summarize this Realms proposal and current vote breakdown',
      'show proposals currently open for voting in this realm',
      'prepare voting approve on this proposal',
      'prepare depositing governance tokens into this realm',
      'prepare relinquishing my vote if it is safe',
    ],
  },
  {
    id: 'squads',
    name: 'Squads Multisig',
    aliases: ['squads', 'squads multisig', 'squads protocol', 'sqds', 'multisig'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['governance', 'treasury', 'positions'],
    writeCapabilities: ['governance', 'treasury'],
    readTools: [
      'solana_connector_read_facts',
      'solana_squads_wallet_authority',
      'solana_squads_multisig_snapshot',
      'solana_squads_vault_snapshot',
      'solana_squads_proposal_snapshot',
      'solana_squads_proposal_list',
    ],
    actionTools: [
      'solana_prepare_squads_create_transfer_proposal',
      'solana_prepare_squads_approve_proposal',
      'solana_prepare_squads_reject_proposal',
      'solana_prepare_squads_cancel_proposal',
      'solana_prepare_squads_execute_proposal',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['@sqds/multisig optional dependency or injected Squads client factory'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Squads SDK optional dependency or an injected client factory.',
      'V1 prepare paths cover proposal creation for SOL/SPL transfers only and approve/reject/cancel/execute for existing proposals.',
      'Member, threshold, time-lock, and config-authority changes are not exposed in V1 prepare paths.',
      'Approve, reject, cancel, and execute are permission-gated by Squads member roles read live from chain.',
      'Execute is blocked until the proposal status is approved, the threshold is met, and the time-lock has elapsed; the adapter never auto-executes after approval.',
      'Instruction decoding is conservative: undecodable proposal instructions surface a warning to the wallet review.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my Squads multisigs and roles',
      'show this Squads vault balance',
      'summarize this Squads proposal and threshold progress',
      'prepare a Squads transfer proposal for 100 USDC',
      'prepare approving this Squads proposal',
      'prepare executing this approved Squads proposal',
    ],
  },
  {
    id: 'lulo',
    name: 'Lulo',
    aliases: ['lulo', 'lulo finance', 'lulo protected', 'lulo boost'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['markets', 'positions'],
    writeCapabilities: ['earn', 'withdraw'],
    readTools: [
      'solana_connector_read_facts',
      'solana_lulo_rates',
      'solana_lulo_pool_meta',
      'solana_lulo_wallet_balances',
    ],
    actionTools: [
      'solana_prepare_lulo_deposit',
      'solana_prepare_lulo_withdraw',
      'solana_prepare_lulo_complete_withdraw',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: ['LULO_API_KEY environment variable'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Live reads and prepared actions require LULO_API_KEY in the host environment.',
      'Protected, Boost, and Regular yield are not risk-free; product warnings are surfaced before approval.',
      'Regular withdrawals are two-step: initiate, wait for cooldown, then run complete withdraw.',
      'Deposits and withdrawals become prepared approval inbox items until the wallet signs.',
    ],
    examples: [
      'show Lulo Protected and Boost rates',
      'show my Lulo balances',
      'deposit 10 USDC into Lulo Protected',
      'withdraw 50 percent from Lulo Protected',
      'complete my Lulo regular withdrawal',
    ],
  },
  {
    id: 'save',
    name: 'Save',
    aliases: ['save', 'save finance', 'solend'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets', 'borrow', 'withdraw', 'repay'],
    writeCapabilities: ['earn', 'withdraw', 'borrow', 'repay'],
    readTools: [
      'solana_connector_read_facts',
      'solana_save_reserve_snapshot',
      'solana_save_market_snapshot',
      'solana_save_wallet_obligation',
      'solana_save_health_preview',
    ],
    actionTools: [
      'solana_prepare_save_deposit',
      'solana_prepare_save_withdraw',
      'solana_prepare_save_borrow',
      'solana_prepare_save_repay',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['Save client factory or @solendprotocol/solend-sdk integration'],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Save client to be wired by the host process.',
      'Borrow and withdraw require a fresh obligation health preview and are blocked below the configured minimum health factor (default 1.10).',
      'Liquidations, flash loans, leverage loops, mint/redeem cToken, and pool administration are not exposed in v1.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show the USDC Save reserve APY',
      'show my Save obligation and liquidation risk',
      'supply 10 USDC to Save',
      'borrow 5 USDC from Save only if health stays safe',
      'repay all my Save USDC debt',
    ],
  },
  {
    id: 'jito',
    name: 'Jito',
    aliases: ['jito', 'jitosol', 'jito sol', 'jito stake pool', 'jito liquid staking'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets', 'earn', 'withdraw'],
    writeCapabilities: ['earn', 'withdraw'],
    readTools: [
      'solana_connector_read_facts',
      'solana_jito_stake_pool_snapshot',
      'solana_jito_wallet_positions',
      'solana_jito_wallet_stake_accounts',
      'solana_jito_quote',
      'solana_jito_deposit_receipts',
    ],
    actionTools: [
      'solana_prepare_jito_stake_sol',
      'solana_prepare_jito_deposit_stake_account',
      'solana_prepare_jito_unstake_jitosol',
      'solana_prepare_jito_withdraw_sol',
      'solana_prepare_jito_claim_deposit_receipt',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: [
      '@solana/spl-stake-pool optional dependency',
      '@jito-foundation/stake-deposit-interceptor-sdk optional dependency for existing stake-account deposits',
      'Optional JITO_CONNECTOR_ENABLED=false feature flag disables the connector',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta JitoSOL liquid staking only.',
      'V1 covers stake SOL, deposit an existing eligible stake account, claim stake-deposit receipts, unstake JitoSOL to SOL or a stake account, and withdraw SOL from an inactive stake account.',
      'Existing stake-account deposits use the Jito stake-deposit interceptor and create a claimable receipt; JitoSOL may not be immediately delivered and early receipt claims can have interceptor fees.',
      'Restaking, MEV/searcher/bundle flows, validator set management, governance, and JTO token operations are not exposed.',
      'Prepared actions refresh pool and wallet state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my JitoSOL position',
      'show the Jito stake pool exchange rate',
      'quote staking 1 SOL into JitoSOL',
      'stake 0.5 SOL for JitoSOL',
      'deposit this delegated stake account into Jito',
      'show my Jito deposit receipts',
      'claim this Jito deposit receipt',
      'unstake 0.1 JitoSOL to a stake account',
      'withdraw SOL from this deactivated Jito stake account',
    ],
  },
  {
    id: 'marinade',
    name: 'Marinade',
    aliases: ['marinade', 'marinade finance', 'msol', 'marinade liquid staking', 'marinade native'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['positions', 'markets', 'earn', 'withdraw'],
    writeCapabilities: ['earn', 'withdraw', 'swap'],
    readTools: [
      'solana_connector_read_facts',
      'solana_marinade_state_snapshot',
      'solana_marinade_wallet_positions',
      'solana_marinade_wallet_stake_accounts',
      'solana_marinade_unstake_tickets',
      'solana_marinade_quote',
    ],
    actionTools: [
      'solana_prepare_marinade_liquid_stake',
      'solana_prepare_marinade_liquid_unstake',
      'solana_prepare_marinade_delayed_unstake',
      'solana_prepare_marinade_claim_delayed_unstake',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: [
      '@marinade.finance/marinade-ts-sdk optional dependency or Marinade client factory injection',
      'JUPITER_API_KEY or JUP_API_KEY for instant mSOL to SOL unstake through Jupiter',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta Marinade mSOL liquid staking only.',
      'V1 covers SOL to mSOL liquid stake, mSOL instant unstake through Jupiter, delayed unstake order creation, delayed-unstake claim, state reads, wallet mSOL positions, native stake-account reads, and unstake-ticket reads.',
      'Instant unstake refreshes the Jupiter route at approval time and enforces the prepared minimum SOL output.',
      'Native stake accounts are read-only; validator delegation editing, liquidating native stake accounts, Marinade governance, and validator-manager operations are not exposed.',
      'Delayed-unstake claims are rejected unless the ticket is claimable when prepared and again when executed.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show my Marinade mSOL position',
      'show Marinade state and mSOL price',
      'quote staking 1 SOL into mSOL',
      'stake 0.25 SOL into mSOL on Marinade',
      'instant unstake 0.1 mSOL to SOL with a minimum output',
      'request delayed unstake for 0.1 mSOL',
      'claim this Marinade delayed unstake ticket',
    ],
  },
  {
    id: 'magiceden',
    name: 'Magic Eden',
    aliases: ['magiceden', 'magic eden', 'me', 'magic-eden'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['markets', 'positions', 'marketplace'],
    writeCapabilities: ['marketplace'],
    readTools: [
      'solana_connector_read_facts',
      'solana_magiceden_api_health',
      'solana_magiceden_collection_snapshot',
      'solana_magiceden_collection_listings',
      'solana_magiceden_collection_bids',
      'solana_magiceden_recent_activity',
      'solana_magiceden_wallet_nfts',
      'solana_magiceden_nft_detail',
    ],
    actionTools: [
      'solana_prepare_magiceden_buy',
      'solana_prepare_magiceden_list',
      'solana_prepare_magiceden_cancel_listing',
      'solana_prepare_magiceden_bid',
      'solana_prepare_magiceden_cancel_bid',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: [
      'MAGICEDEN_API_KEY environment variable',
      'MAGICEDEN_CONNECTOR_ENABLED=true feature flag',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only; Solana NFTs only (no Bitcoin, EVM, or Runes).',
      'Trading endpoints are gated on Magic Eden API health and remain feature-flagged because of the 2026-02-27 API infrastructure notice.',
      'Royalty and marketplace-fee data may be missing from API responses; missing data surfaces as warnings, not silent zeros.',
      'Launchpad admin, royalty-policy overrides, and cross-chain flows are not exposed in v1.',
      'Prepared actions remain approval inbox items until the wallet signs; execution refreshes listing/bid state.',
    ],
    examples: [
      'check Magic Eden API health',
      'show Magic Eden listings for this collection',
      'show my Magic Eden listed NFTs',
      'prepare buying this NFT on Magic Eden for no more than 1 SOL, do not sign',
      'prepare listing this NFT on Magic Eden for 1.5 SOL',
      'prepare canceling my Magic Eden listing for this mint',
    ],
  },
  {
    id: 'sanctum',
    name: 'Sanctum',
    aliases: ['sanctum', 'infinity', 'inf', 'sanctum infinity', 'lst', 'liquid staking'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['markets', 'positions', 'swap'],
    writeCapabilities: ['swap', 'add_liquidity', 'withdraw', 'earn'],
    readTools: [
      'solana_connector_read_facts',
      'solana_sanctum_lst_list',
      'solana_sanctum_lst_snapshot',
      'solana_sanctum_infinity_pool_snapshot',
      'solana_sanctum_wallet_positions',
      'solana_sanctum_quote',
    ],
    actionTools: [
      'solana_prepare_sanctum_swap_lst',
      'solana_prepare_sanctum_add_infinity_liquidity',
      'solana_prepare_sanctum_remove_infinity_liquidity',
      'solana_prepare_sanctum_stake_sol_to_lst',
      'solana_prepare_sanctum_unstake_lst_to_sol',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: [
      'SANCTUM_API_KEY environment variable',
      'SANCTUM_API_BASE_URL optional override',
      'SANCTUM_CONNECTOR_ENABLED optional feature flag',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Live reads and prepared actions require SANCTUM_API_KEY in the host environment.',
      'V1 covers LST catalog reads, wallet LST/INF positions, quotes, LST swaps, Infinity add/remove liquidity, and SOL/LST stake or unstake through Sanctum sources.',
      'Sanctum connector routes are constrained to Infinity and Sanctum Router; it does not silently use Jupiter fallback.',
      'Validator management, LST issuer admin actions, custom pools, delegated staking automation, and recurring LST rebalancing are not exposed in v1.',
      'Prepared actions remain approval inbox items until the wallet signs; execution refreshes Sanctum order state.',
    ],
    examples: [
      'show Sanctum Infinity pool composition',
      'show my Sanctum LST and INF positions',
      'quote swapping this LST to JitoSOL through Sanctum',
      'prepare adding 1 SOL worth of JitoSOL to Sanctum Infinity',
      'prepare removing 10 INF to SOL with a minimum output',
      'stake 1 SOL to this Sanctum LST',
      'unstake this LST to SOL through Sanctum',
    ],
  },
  {
    id: 'tensor',
    name: 'Tensor',
    aliases: ['tensor', 'tensor trade', 'tensor nft', 'tensor marketplace', 'tcomp'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['markets', 'positions', 'marketplace'],
    writeCapabilities: ['marketplace'],
    readTools: [
      'solana_connector_read_facts',
      'solana_tensor_collection_snapshot',
      'solana_tensor_collection_listings',
      'solana_tensor_collection_bids',
      'solana_tensor_recent_sales',
      'solana_tensor_wallet_nfts',
      'solana_tensor_nft_detail',
      'solana_tensor_wallet_marketplace_exposure',
    ],
    actionTools: [
      'solana_prepare_tensor_buy',
      'solana_prepare_tensor_list',
      'solana_prepare_tensor_cancel_listing',
      'solana_prepare_tensor_bid',
      'solana_prepare_tensor_cancel_bid',
      'solana_prepare_tensor_sweep',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: [
      'TENSOR_API_KEY environment variable',
      '@tensor-oss/tensorswap-sdk and @tensor-oss/tcomp-sdk optional dependencies (host-wired via setTensorClientFactory)',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Reads and prepared actions require the Tensor client to be wired by the host process with TENSOR_API_KEY and optional SDKs.',
      'Sweep is capped to 10 itemized listings per prepared action and refuses mixed legacy/compressed batches.',
      'Autonomous trading, unlimited bid escrows, leverage, loans, token launches, and price-lock derivatives are not exposed in v1.',
      'Prepared actions refresh listing and bid state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show the Tensor floor and top bids for this collection',
      'show my Tensor-listed NFTs',
      'prepare buying this NFT on Tensor for no more than 1.2 SOL, do not sign',
      'prepare listing this NFT on Tensor for 2 SOL',
      'prepare a Tensor collection bid capped at 5 SOL escrow',
      'prepare sweeping the three cheapest listed items under 0.3 SOL each',
    ],
  },
  {
    id: 'phoenix',
    name: 'Phoenix Perpetuals',
    aliases: ['phoenix', 'phoenix perp', 'phoenix perps', 'phoenix perpetuals', 'phoenix trade', 'ellipsis perps'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['perps', 'positions', 'markets'],
    writeCapabilities: ['perps'],
    readTools: [
      'solana_connector_read_facts',
      'solana_phoenix_market_snapshot',
      'solana_phoenix_market_catalog',
      'solana_phoenix_position_snapshot',
      'solana_phoenix_wallet_positions',
      'solana_phoenix_funding_history',
      'solana_phoenix_health_preview',
    ],
    actionTools: [
      'solana_prepare_phoenix_open',
      'solana_prepare_phoenix_close',
      'solana_prepare_phoenix_modify_collateral',
      'solana_prepare_phoenix_place_trigger',
      'solana_prepare_phoenix_cancel_order',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: true,
    requiredConfig: [
      'Phoenix invite/activation code (paste in Preferences → Agents & Connectors) or PHOENIX_ACCESS_CODE env',
      'config.connectors.phoenix.perps.enabled=true once a paper-mode soak passes',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only. Phoenix Perpetuals (Ellipsis Labs) is in private beta; there is no devnet — use paper mode for rehearsal.',
      'Native prepare actions use the pinned Rise SDK when a Phoenix access code is configured. The PHOENIX_USE_LEGACY_HTTP fallback is read-only and write attempts throw unsupported_method.',
      'Trade execution is available today via the Vulcan upstream bridge (github.com/Ellipsis-Labs/vulcan-cli). When config.connectors.phoenix.vulcan.enabled is true and the vulcan binary is on PATH, the MCP server exposes solana_vulcan_* tools; dangerous calls are wrapped in the prepared-action inbox and signed only after explicit user approval in the Spend tab.',
      'Leverage is capped at policy maxLeverage (default 5x); minimum liquidation buffer enforced at policy minLiquidationBufferPct (default 15%).',
      'Stop-loss triggers use Phoenix tick-based prices, not USD — adapter converts via PHOENIX_TICKS_PER_USD.',
      'Hosted phoenix.trade UI is region-restricted; on-chain program is open. Self-hosted Agentic client is unaffected.',
      'Trader activation (POST /v1/invite/activate) is one-time per access code; expired codes require re-issuance.',
    ],
    examples: [
      'show my Phoenix positions',
      'show the SOL-PERP funding rate on Phoenix',
      'preview opening 0.5 SOL long at 3x on Phoenix',
      'prepare opening 0.3 SOL Phoenix perp long at 3x in paper mode',
      'prepare opening 0.3 SOL Phoenix perp long at 3x with a -8% stop loss, do not sign',
      'prepare closing my SOL-PERP position on Phoenix',
      'cancel my Phoenix limit order',
    ],
  },
  {
    id: 'wormhole',
    name: 'Wormhole',
    aliases: ['wormhole', 'portal bridge', 'token bridge', 'wormhole token bridge', 'wtt', 'cctp bridge'],
    supportedClusters: ['mainnet-beta', 'devnet'],
    readCapabilities: ['bridge', 'markets', 'positions'],
    writeCapabilities: ['bridge'],
    readTools: [
      'solana_connector_read_facts',
      'solana_wormhole_supported_routes',
      'solana_wormhole_token_snapshot',
      'solana_wormhole_quote',
      'solana_wormhole_transfer_status',
      'solana_wormhole_wallet_bridge_exposure',
    ],
    actionTools: [
      'solana_prepare_wormhole_transfer',
      'solana_prepare_wormhole_redeem',
      'solana_prepare_wormhole_recover_or_resume',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: [
      '@wormhole-foundation/sdk optional dependency plus route-specific platform packages',
      'Host-wired Wormhole client factory via setWormholeClientFactory()',
      'Optional WORMHOLE_CONNECTOR_ENABLED=false feature flag disables the connector',
      'Optional WORMHOLE_NETWORK override (Mainnet or Testnet)',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'V1 prepares Solana-source bridge transfers only.',
      'Destination-chain signing is never performed by this Solana connector.',
      'V1 covers supported-route reads, token snapshots, quotes, transfer status, wallet bridge exposure, Solana-source transfer prepare, and Solana-compatible redeem/recover paths.',
      'NFT bridge, governance VAAs, arbitrary EVM signing, NTT admin actions, custom bridge deployment, and relayer operator actions are not exposed.',
      'Prepared transfer actions refresh quotes and route state at execution time and remain approval inbox items until the wallet signs.',
    ],
    examples: [
      'show Wormhole routes for USDC from Solana to Ethereum',
      'quote bridging 10 USDC from Solana to Base through Wormhole',
      'prepare a Wormhole transfer of 5 USDC to this destination address',
      'check the status of this Wormhole transfer',
      'prepare redeeming this Wormhole transfer on Solana',
    ],
  },
  {
    id: 'pyth',
    name: 'Pyth',
    aliases: ['pyth', 'pyth network', 'pyth oracle'],
    supportedClusters: ['mainnet-beta'],
    readCapabilities: ['oracle', 'markets'],
    writeCapabilities: [],
    readTools: [
      'solana_connector_read_facts',
      'solana_pyth_price_feed',
      'solana_pyth_price_feeds_batch',
      'solana_pyth_feed_search',
      'solana_pyth_onchain_price_account',
      'solana_pyth_oracle_evidence',
    ],
    actionTools: [
      'solana_prepare_pyth_post_price_update',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: [
      'Optional PYTH_HERMES_URL environment variable (defaults to https://hermes.pyth.network)',
      '@pythnetwork/pyth-solana-receiver optional dependency (required only for the post price update prepare/execute path)',
    ],
    executionMode: 'first_class_prepare',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'Mainnet-beta only.',
      'Read tools fetch from the public Hermes API. Posting price updates requires the @pythnetwork/pyth-solana-receiver optional dependency.',
      'Multi-feed posts that exceed a single Solana transaction are not supported in v1; the prepare tool refuses requests with more than two feed ids.',
      'Pyth data is evidence, not a trade recommendation; the agent does not generate trading signals from oracle facts.',
      'Publisher/admin actions and custom oracle configuration are not exposed.',
    ],
    examples: [
      'show the current Pyth SOL/USD price with confidence and publish time',
      'check whether this Pyth feed is fresh enough for a lending action',
      'compare Pyth prices for SOL, JitoSOL, and mSOL',
      'prepare posting a fresh Pyth price update for this feed',
      'give oracle evidence for this protocol plan',
    ],
  },
];

export function listConnectorCapabilities(
  config?: AgentWalletConfig,
): ConnectorCapabilityView[] {
  return CONNECTOR_REGISTRY.map((connector) => connectorCapabilityView(connector, config));
}

export function getConnector(idOrAlias: string): ConnectorRegistryEntry | undefined {
  const normalized = normalizeConnectorSearch(idOrAlias);
  if (!normalized) return undefined;
  return CONNECTOR_REGISTRY.find((connector) =>
    connector.id === normalized ||
    connector.aliases.some((alias) => normalizeConnectorSearch(alias) === normalized) ||
    normalizeConnectorSearch(connector.name) === normalized,
  );
}

export function requireConnector(idOrAlias: string): ConnectorRegistryEntry {
  const connector = getConnector(idOrAlias);
  if (!connector) {
    throw new Error(`Unknown connector: ${idOrAlias}`);
  }
  return connector;
}

export function connectorRegistryPromptContext(
  config?: AgentWalletConfig,
): Array<Record<string, unknown>> {
  return listConnectorCapabilities(config).map((connector) => ({
    id: connector.id,
    name: connector.name,
    aliases: connector.aliases,
    readCapabilities: connector.readCapabilities,
    writeCapabilities: connector.writeCapabilities,
    readTools: connector.readTools,
    actionTools: connector.actionTools,
    requiresClientKey: connector.requiresClientKey,
    requiredConfig: connector.requiredConfig,
    executionMode: connector.executionMode,
    readiness: connector.readiness,
    productReadiness: connector.productReadiness,
    limitations: connector.limitations,
    examples: connector.examples,
    approvalBoundary: connector.approvalBoundary,
    agentUse:
      'Use reads as facts. Use write capabilities only as prepare-only wallet approval work. If a capability is unavailable, say what is missing instead of inventing support.',
  }));
}

export function connectorCapabilityView(
  connector: ConnectorRegistryEntry,
  config?: AgentWalletConfig,
): ConnectorCapabilityView {
  const clusterAllowed = !config || connector.supportedClusters.includes(config.cluster);
  const clusterReason = config && !clusterAllowed
    ? `${connector.name} is only available on ${connector.supportedClusters.join(', ')}; current cluster is ${config.cluster}.`
    : undefined;
  const readConfigReason = clusterReason ? undefined : runtimeConfigBlockReason(connector, config, 'reads');
  const actionConfigReason = clusterReason ? undefined : runtimeConfigBlockReason(connector, config, 'actions');
  const readsReady = clusterAllowed && !readConfigReason && connector.readCapabilities.length > 0 && connector.readTools.length > 0;
  const actionsReady = clusterAllowed && !actionConfigReason && connector.writeCapabilities.length > 0 && connector.actionTools.length > 0;
  return {
    ...connector,
    readiness: {
      reads: {
        ready: readsReady,
        ...(clusterReason
          ? { reason: clusterReason }
          : readConfigReason
            ? { reason: readConfigReason }
          : !readsReady
            ? { reason: `${connector.name} does not expose MCP fact reads yet.` }
            : {}),
      },
      actions: {
        ready: actionsReady,
        ...(clusterReason
          ? { reason: clusterReason }
          : actionConfigReason
            ? { reason: actionConfigReason }
          : !actionsReady
            ? { reason: `${connector.name} does not expose MCP prepared actions yet.` }
            : {}),
      },
    },
    ...(connector.id === 'jupiter' ? { productReadiness: jupiterProductReadiness(config, clusterReason) } : {}),
  };
}

function runtimeConfigBlockReason(
  connector: ConnectorRegistryEntry,
  config?: AgentWalletConfig,
  target: 'reads' | 'actions' = 'reads',
): string | undefined {
  if (connector.id === 'jupiter' && config && target === 'reads') {
    const { apiKey, envName } = getJupiterApiKey(config);
    return apiKey ? undefined : `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.`;
  }
  if (connector.id === 'kamino') {
    const reason = describeKaminoUnavailableReason();
    return reason ? `Kamino client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'meteora') {
    const reason = describeMeteoraUnavailableReason();
    return reason ? `Meteora client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'orca') {
    const reason = describeOrcaUnavailableReason();
    return reason ? `Orca client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'raydium') {
    const reason = describeRaydiumUnavailableReason();
    return reason ? `Raydium SDK is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'marginfi') {
    const reason = describeMarginfiUnavailableReason();
    return reason ? `MarginFi SDK is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'project0') {
    if (target === 'reads') return undefined;
    const reason = describeProject0SdkUnavailableReason();
    return reason ? `Project 0 SDK is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'drift') {
    const reason = describeDriftUnavailableReason();
    return reason ? `Drift vault client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'realms') {
    const reason = describeRealmsUnavailableReason();
    return reason ? `Realms / SPL Governance client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'lulo') {
    const reason = describeLuloUnavailableReason();
    return reason ? `Lulo API client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'save') {
    const reason = describeSolendUnavailableReason();
    return reason ? `Save client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'jito') {
    const reason = describeJitoUnavailableReason();
    return reason ? `Jito stake-pool SDK is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'marinade') {
    const reason = describeMarinadeUnavailableReason();
    return reason ? `Marinade SDK client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'magiceden') {
    const reason = describeMagicedenUnavailableReason();
    return reason ? `Magic Eden API client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'sanctum') {
    const reason = describeSanctumUnavailableReason();
    return reason ? `Sanctum API client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'tensor') {
    const reason = describeTensorUnavailableReason();
    return reason ? `Tensor client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'phoenix') {
    const reason = describePhoenixUnavailableReason();
    return reason ? `Phoenix Perpetuals client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'pyth') {
    if (target === 'actions') {
      const reason = describePythReceiverUnavailableReason();
      return reason ? `Pyth post price update is unavailable: ${reason}` : undefined;
    }
    const reason = describePythUnavailableReason();
    return reason ? `Pyth Hermes client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'squads') {
    const reason = describeSquadsUnavailableReason();
    return reason ? `Squads multisig client is not configured: ${reason}` : undefined;
  }
  if (connector.id === 'wormhole') {
    const reason = describeWormholeUnavailableReason();
    return reason ? `Wormhole SDK client is not configured: ${reason}` : undefined;
  }
  return undefined;
}

function jupiterProductReadiness(
  config: AgentWalletConfig | undefined,
  clusterReason: string | undefined,
): ConnectorCapabilityView['productReadiness'] {
  const unavailable = (reason: string): ConnectorReadiness => ({ ready: false, reason });
  if (!config) {
    return {
      swap: { ready: true },
      lendEarn: { ready: true },
      lendBorrow: { ready: true, reason: 'Earn REST plus optional @jup-ag/lend SDK for Borrow writes.' },
      trigger: unavailable('Jupiter Trigger V2 is disabled by default; enable connectors.jupiter.trigger.enabled.'),
      recurring: unavailable('Jupiter Recurring is disabled by default; enable connectors.jupiter.recurring.enabled.'),
      tokens: { ready: true },
      price: { ready: true },
      prediction: unavailable('Jupiter Prediction beta is disabled by default; enable connectors.jupiter.prediction.enabled.'),
      perpsReadonly: {
        ready: true,
        reason: 'Jupiter Perps read-only research surface is exposed via solana_jupiter_perps_status. Account decoding for pools, custodies, and positions remains gated behind official API stability; writes are denied.',
      },
    };
  }
  const { apiKey, envName } = getJupiterApiKey(config);
  const swapReason = clusterReason
    ?? (!apiKey ? `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.` : undefined);
  const predictionPolicy = getJupiterPredictionPolicy(config);
  let predictionReadiness: ConnectorReadiness;
  if (clusterReason) {
    predictionReadiness = { ready: false, reason: clusterReason };
  } else if (!predictionPolicy.enabled) {
    predictionReadiness = {
      ready: false,
      reason: 'Jupiter Prediction beta is disabled by default. Set connectors.jupiter.prediction.enabled=true to opt in.',
    };
  } else if (!apiKey) {
    predictionReadiness = {
      ready: false,
      reason: `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.`,
    };
  } else {
    predictionReadiness = {
      ready: true,
      reason: `Configured for ${jupiterApiHost(config, 'prediction')} (beta).`,
    };
  }
  const lendSdkReason = describeJupiterLendReadUnavailableReason();
  const lendEarnReadiness: ConnectorReadiness = clusterReason
    ? { ready: false, reason: clusterReason }
    : !apiKey
      ? { ready: false, reason: `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.` }
      : { ready: true, reason: `Configured for ${jupiterApiHost(config, 'lend')}.` };
  const lendBorrowReadiness: ConnectorReadiness = clusterReason
    ? { ready: false, reason: clusterReason }
    : lendSdkReason
      ? {
          ready: false,
          reason: `Jupiter Lend Borrow writes need the optional @jup-ag/lend SDK: ${lendSdkReason}`,
        }
      : !apiKey
      ? { ready: false, reason: `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.` }
      : { ready: true, reason: `Configured for ${jupiterApiHost(config, 'lend')} with SDK.` };
  const triggerPolicy = getJupiterTriggerPolicy(config);
  const triggerReadiness: ConnectorReadiness = clusterReason
    ? { ready: false, reason: clusterReason }
    : !triggerPolicy.enabled
      ? {
          ready: false,
          reason:
            'Jupiter Trigger V2 is disabled by default. Set connectors.jupiter.trigger.enabled=true or CONNECTORS_JUPITER_TRIGGER_ENABLED=true to opt in.',
        }
      : !apiKey
        ? { ready: false, reason: `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.` }
        : {
            ready: true,
            reason: `Configured for ${jupiterApiHost(config, 'trigger')}. Vault is Privy-managed custody; JWTs stay in volatile process memory only.`,
          };
  const recurringPolicy = getJupiterRecurringPolicy(config);
  const recurringReadiness: ConnectorReadiness = clusterReason
    ? { ready: false, reason: clusterReason }
    : !recurringPolicy.enabled
      ? {
          ready: false,
          reason:
            'Jupiter Recurring is disabled by default. Set connectors.jupiter.recurring.enabled=true or CONNECTORS_JUPITER_RECURRING_ENABLED=true to opt in.',
        }
      : !apiKey
        ? { ready: false, reason: `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.` }
        : {
            ready: true,
            reason: `Configured for ${jupiterApiHost(config, 'recurring')}. Future fills execute through Jupiter automation outside Agentic approvals.`,
          };
  const tokenPriceReason = clusterReason ?? describeJupiterTokenPriceUnavailableReason(config);
  const tokenReadiness: ConnectorReadiness = tokenPriceReason
    ? { ready: false, reason: tokenPriceReason }
    : { ready: true, reason: `Configured for ${jupiterApiHost(config, 'tokens')}.` };
  const priceReadiness: ConnectorReadiness = tokenPriceReason
    ? { ready: false, reason: tokenPriceReason }
    : { ready: true, reason: `Configured for ${jupiterApiHost(config, 'price')}.` };
  return {
    swap: swapReason
      ? { ready: false, reason: swapReason }
      : { ready: true, reason: `Configured for ${jupiterApiHost(config, 'swap')}.` },
    lendEarn: lendEarnReadiness,
    lendBorrow: lendBorrowReadiness,
    trigger: triggerReadiness,
    recurring: recurringReadiness,
    tokens: tokenReadiness,
    price: priceReadiness,
    prediction: predictionReadiness,
    perpsReadonly: clusterReason
      ? { ready: false, reason: clusterReason }
      : {
          ready: true,
          reason: 'Jupiter Perps read-only research surface is exposed via solana_jupiter_perps_status. Account-decode reads remain gated behind official API stability; writes are denied.',
        },
  };
}

function blinkBackedConnector(input: {
  id: ConnectorId;
  name: string;
  aliases: string[];
  examples: string[];
}): ConnectorRegistryEntry {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases,
    supportedClusters: ['mainnet-beta'],
    readCapabilities: [],
    writeCapabilities: ['blinks'],
    readTools: [],
    actionTools: [
      'solana_prepare_blink_action',
      'solana_execute_prepared_action',
    ],
    requiresClientKey: false,
    requiredConfig: ['User-supplied Blink/Solana Action URL'],
    executionMode: 'wallet_approval',
    approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
    limitations: [
      'URL-backed Blink/Solana Action preparation only.',
      'This MCP runtime does not expose first-class reads for this connector yet.',
      'Prepared actions remain approval inbox items until the wallet signs.',
    ],
    examples: input.examples,
  };
}

function normalizeConnectorSearch(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
