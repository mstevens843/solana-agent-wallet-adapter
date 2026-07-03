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

// Prepared-action params for a manage action from a chat position card: the position/order id under
// its kind-specific field, the carried fields (e.g. borrow vaultId/positionId), and an optional amount.
export function manageProposalParams(
  idField: string,
  orderId: string,
  fields: Record<string, string>,
  amount?: string,
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...fields };
  if (orderId) params[idField] = orderId;
  if (amount) params.amount = amount;
  return params;
}
