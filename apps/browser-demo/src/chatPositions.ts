// Pure helpers for the in-chat Active Positions feature — extracted from main.ts so the
// bug-prone bits (keyword matching, manage-action param building) are unit-testable without
// importing the whole app entrypoint.
import type { ActionCategory } from './connectorDrafting.js';

export interface PositionBrowseType {
  category: ActionCategory;
  // EXACT-match regex: only a bare type word triggers the positions view, so ordinary chat
  // ("lend me advice") never hijacks into it.
  keywords: RegExp;
  countLabel: string;
}

export const POSITION_BROWSE_TYPES: ReadonlyArray<PositionBrowseType> = [
  { category: 'limit', keywords: /^(?:limit|limit orders?)$/i, countLabel: 'Limit orders' },
  { category: 'dca', keywords: /^dca$/i, countLabel: 'DCA' },
  { category: 'lend', keywords: /^(?:lend|lending)$/i, countLabel: 'Lending' },
  { category: 'borrow', keywords: /^(?:borrow|borrowing)$/i, countLabel: 'Borrowing' },
  { category: 'stake', keywords: /^(?:stake|staking)$/i, countLabel: 'Staking' },
  { category: 'lp', keywords: /^(?:lp|liquidity)$/i, countLabel: 'Liquidity' },
];

export function matchPositionBrowseType(text: string): ActionCategory | null {
  const clean = text.trim();
  for (const spec of POSITION_BROWSE_TYPES) if (spec.keywords.test(clean)) return spec.category;
  return null;
}

// The connector-prepare field a manage action's typed value fills. Kinds NOT listed take no numeric
// value (cancel / withdraw-funds / close / collect / claim). Most amounts land in `amount`; the
// exceptions here match each action's ConnectorSubAction field id exactly.
export const MANAGE_VALUE_FIELD_BY_KIND: Readonly<Record<string, string>> = {
  jupiter_trigger_edit_order: 'newTriggerPriceUsd',
  jupiter_lend_earn_withdraw: 'amount',
  jupiter_lend_earn_redeem: 'shares',
  jupiter_lend_borrow_repay: 'amount',
  jupiter_lend_borrow_withdraw_collateral: 'amount',
  jupiter_lend_borrow_deposit_collateral: 'collateralAmount',
  jupiter_lend_borrow_borrow: 'borrowAmount',
  marinade_liquid_unstake: 'msolAmount',
  marinade_delayed_unstake: 'msolAmount',
  jito_unstake_jitosol: 'jitoSolAmount',
  sanctum_unstake_lst_to_sol: 'lstAmount',
  meteora_remove_liquidity: 'amount',
  orca_decrease_liquidity: 'amount',
  raydium_remove_liquidity: 'amount',
};

// Manage kinds that must PROMPT the user for the value even when a field is prefilled — Edit's prefill
// is the CURRENT price (we want a new one); withdraw/repay/borrow/LP-remove need an explicit amount.
// The one-tap kinds either take no value, or carry a prefilled "all" value (redeem shares, marinade/
// jito unstake) that is the intended action.
export const MANAGE_PROMPT_KINDS: ReadonlySet<string> = new Set<string>([
  'jupiter_trigger_edit_order',
  'jupiter_lend_earn_withdraw',
  'jupiter_lend_borrow_repay',
  'jupiter_lend_borrow_withdraw_collateral',
  'jupiter_lend_borrow_deposit_collateral',
  'jupiter_lend_borrow_borrow',
  'sanctum_unstake_lst_to_sol',
  'meteora_remove_liquidity',
  'orca_decrease_liquidity',
  'raydium_remove_liquidity',
]);

export function manageValueField(kind: string): string {
  return MANAGE_VALUE_FIELD_BY_KIND[kind] ?? 'amount';
}

export function chatManageNeedsPrompt(kind: string): boolean {
  return MANAGE_PROMPT_KINDS.has(kind);
}

// Prepared-action params for a manage action from a chat position card: the position/order id under
// its kind-specific field, the carried fields (e.g. borrow vaultId/positionId, edit's current price),
// and an optional typed value written into `valueField` (overriding any prefilled current value).
export function manageProposalParams(
  idField: string,
  orderId: string,
  fields: Record<string, string>,
  value?: string,
  valueField = 'amount',
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...fields };
  if (orderId) params[idField] = orderId;
  if (value) params[valueField] = value;
  return params;
}
