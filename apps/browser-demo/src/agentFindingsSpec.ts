export type DeterministicFactKey =
  | 'research'
  | 'route'
  | 'quote'
  | 'protocol'
  | 'protocolConnector'
  | 'blinkAction'
  | 'blinkClassification'
  | 'simulation'
  | 'tokenMint'
  | 'recipient'
  | 'policy'
  | 'limits'
  | 'schedule';

export interface FindingsSpec {
  slots: DeterministicFactKey[];
  labels?: Partial<Record<DeterministicFactKey, string>>;
  singleTokenRole?: boolean;
}

export const DEFAULT_SPEC: FindingsSpec = {
  slots: ['protocolConnector', 'tokenMint', 'simulation'],
  singleTokenRole: true,
};

const connectorSupplySpec = (label: string): FindingsSpec => ({
  slots: ['protocolConnector', 'tokenMint', 'simulation'],
  labels: { tokenMint: label },
  singleTokenRole: true,
});

const connectorVaultSpec: FindingsSpec = {
  slots: ['protocolConnector', 'tokenMint', 'simulation'],
  singleTokenRole: true,
};

const connectorAdminSpec: FindingsSpec = {
  slots: ['protocolConnector', 'simulation'],
};

export const FINDINGS_SPEC: Record<string, FindingsSpec> = {
  swap: {
    slots: ['protocol', 'route', 'quote', 'tokenMint', 'limits', 'simulation'],
  },
  recurring_payment: {
    slots: ['recipient', 'tokenMint', 'schedule', 'simulation'],
    singleTokenRole: true,
  },
  transfer_sol: {
    slots: ['recipient', 'tokenMint', 'simulation'],
    singleTokenRole: true,
  },
  transfer_spl: {
    slots: ['recipient', 'tokenMint', 'simulation'],
    singleTokenRole: true,
  },

  kamino_deposit: connectorSupplySpec('Supply token'),
  kamino_withdraw: connectorSupplySpec('Redeem token'),

  drift_vault_deposit: connectorVaultSpec,
  drift_vault_request_withdraw: connectorVaultSpec,
  drift_vault_cancel_withdraw: connectorAdminSpec,
  drift_vault_complete_withdraw: connectorAdminSpec,

  marginfi_deposit: connectorSupplySpec('Supply token'),
  marginfi_withdraw: connectorSupplySpec('Redeem token'),
  marginfi_borrow: connectorSupplySpec('Borrow token'),
  marginfi_repay: connectorSupplySpec('Repay token'),

  project0_create_account: connectorAdminSpec,
  project0_deposit: connectorSupplySpec('Supply token'),
  project0_withdraw: connectorSupplySpec('Redeem token'),
  project0_borrow: connectorSupplySpec('Borrow token'),
  project0_repay: connectorSupplySpec('Repay token'),

  save_deposit: connectorSupplySpec('Supply token'),
  save_withdraw: connectorSupplySpec('Redeem token'),
  save_borrow: connectorSupplySpec('Borrow token'),
  save_repay: connectorSupplySpec('Repay token'),

  marinade_liquid_stake: connectorSupplySpec('Stake token'),
  marinade_liquid_unstake: connectorSupplySpec('Unstake token'),
  marinade_delayed_unstake: connectorSupplySpec('Unstake token'),
  marinade_claim_delayed_unstake: connectorAdminSpec,

  jito_stake_sol: connectorSupplySpec('Stake token'),
  jito_unstake_jitosol: connectorSupplySpec('Unstake token'),
  jito_withdraw_sol: connectorSupplySpec('Withdraw token'),
  jito_deposit_stake_account: connectorVaultSpec,
  jito_claim_deposit_receipt: connectorAdminSpec,

  jupiter_lend_earn_deposit: connectorSupplySpec('Supply token'),
  jupiter_lend_earn_withdraw: connectorSupplySpec('Redeem token'),
  jupiter_lend_earn_mint: connectorSupplySpec('Supply token'),
  jupiter_lend_earn_redeem: connectorSupplySpec('Redeem token'),
  jupiter_lend_borrow_borrow: connectorSupplySpec('Borrow token'),
  jupiter_lend_borrow_repay: connectorSupplySpec('Repay token'),
  jupiter_lend_borrow_deposit_collateral: connectorSupplySpec('Collateral token'),
  jupiter_lend_borrow_withdraw_collateral: connectorSupplySpec('Collateral token'),
  jupiter_lend_borrow_create_position: connectorAdminSpec,

  meteora_add_liquidity: connectorVaultSpec,
  meteora_remove_liquidity: connectorVaultSpec,
  meteora_claim_fees: connectorAdminSpec,
  meteora_claim_rewards: connectorAdminSpec,
  meteora_close_position: connectorAdminSpec,

  orca_increase_liquidity: connectorVaultSpec,
  orca_decrease_liquidity: connectorVaultSpec,
  orca_collect_fees: connectorAdminSpec,
  orca_collect_rewards: connectorAdminSpec,

  raydium_add_liquidity: connectorVaultSpec,
  raydium_remove_liquidity: connectorVaultSpec,
  raydium_collect_fees: connectorAdminSpec,
  raydium_farm_stake: connectorVaultSpec,
  raydium_farm_unstake: connectorVaultSpec,
  raydium_harvest: connectorAdminSpec,

  sanctum_stake_sol_to_lst: connectorSupplySpec('Stake token'),
  sanctum_unstake_lst_to_sol: connectorSupplySpec('Unstake token'),
  sanctum_swap_lst: connectorSupplySpec('Token'),
  sanctum_add_infinity_liquidity: connectorVaultSpec,
  sanctum_remove_infinity_liquidity: connectorVaultSpec,

  blink_action: { slots: ['blinkClassification', 'protocolConnector', 'blinkAction', 'simulation'] },

  read_only: { slots: ['research'] },
  manual_review: { slots: ['research'] },
};

export function findingsSpecFor(actionType: string | undefined): FindingsSpec {
  if (!actionType) return DEFAULT_SPEC;
  return FINDINGS_SPEC[actionType] ?? DEFAULT_SPEC;
}
