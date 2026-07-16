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
  { category: 'perps', keywords: /^(?:perp|perps|perpetuals?)$/i, countLabel: 'Perps' },
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
  // Keyless lend/borrow connectors — withdraw/repay take an explicit token amount (default valueField
  // 'amount'), so they prompt like the Jupiter lend/borrow manage actions.
  'kamino_withdraw',
  'save_withdraw',
  'save_repay',
  'marginfi_withdraw',
  'marginfi_repay',
  'lulo_withdraw',
]);

export function manageValueField(kind: string): string {
  return MANAGE_VALUE_FIELD_BY_KIND[kind] ?? 'amount';
}

export function chatManageNeedsPrompt(kind: string): boolean {
  return MANAGE_PROMPT_KINDS.has(kind);
}

// ---- Manage settle lifecycle (Positions cards) ----
//
// A manage action (withdraw/repay/unstake/remove/cancel) is only ever recorded against a position once
// its tx has CONFIRMED on chain — a pending tx returns before the completion funnel. So the only thing
// left to wait for is indexer lag on the connector read: seconds, not minutes.
//
// This clock is DELIBERATELY separate from main.ts's POSITION_PENDING_MS, which governs seed
// bridge-record AGE (positionIsRecentlyOpened / expireStaleSeededForSection). Coupling the two is what
// wedged the card: the post-withdraw refetch fired inside a 2-minute reconcile guard, so it was
// guaranteed to decide nothing, and nothing ever re-read afterwards.
export const POSITION_SETTLE_MS = 90_000; // hard deadline — the pill MUST be terminal by now
export const POSITION_SETTLE_POLL_MS = 6_000; // settle-watch cadence
export const POSITION_SETTLE_MIN_AGE_MS = 4_000; // indexer grace before a live read is believed
export const POSITION_COMPLETE_LINGER_MS = 8_000; // how long a finished card shows "Complete" before Done
export const POSITION_MANAGE_NOTE_MS = 5 * 60_000; // how long a reduced card keeps its "Confirmed" note

// pending  → in flight (tx confirmed, balance not yet re-read)
// reduced  → a live read PROVED the position survived: partial unwind, card stays open
// closed   → a clean live read PROVED it's gone: full unwind, card retires to Done
// unconfirmed → the deadline passed without an authoritative read. The tx landed, but we cannot prove
//               what's left, so we under-claim rather than invent a balance.
export type PositionManagePhase = 'pending' | 'reduced' | 'closed' | 'unconfirmed';

export interface PositionManageIntent {
  actionId: string; // the manage PreparedAction → its receipt in Done
  kind: string;
  requestedAt: string;
  settleDeadlineAt: string; // requestedAt + POSITION_SETTLE_MS — the never-stuck guarantee
  phase: PositionManagePhase;
  txid?: string;
  resolvedAt?: string;
  requestedAmount?: string; // PROVEN — it's the value in the signed, confirmed tx
  amountBefore?: string; // the position's size at request time, WITH its unit ("0.05 SOL")
  amountBeforeFromLive?: boolean; // false ⇒ seed-derived ⇒ stale ⇒ never render a ratio from it
  amountAfter?: string; // ONLY ever written from a live read
  assetLabel?: string; // "SOL" — the unit, when the before-amount isn't trustworthy
}

// The settle phase as of `nowMs`, WITHOUT mutating anything. This is the never-stuck guarantee: once
// the deadline passes, a still-'pending' record reports as terminal even if every live read failed
// forever, no timer ever fired, and the WebView was backgrounded the whole time.
export function positionManagePhaseAt(manage: PositionManageIntent, nowMs: number): PositionManagePhase {
  if (manage.phase !== 'pending') return manage.phase;
  const deadline = Date.parse(manage.settleDeadlineAt);
  if (!Number.isFinite(deadline)) return 'unconfirmed'; // unparseable deadline must not mean "forever"
  return nowMs >= deadline ? 'unconfirmed' : 'pending';
}

export function positionManageIsTerminal(phase: PositionManagePhase): boolean {
  return phase !== 'pending';
}

// Value fields that carry a TOKEN amount of the position's own asset — the only values that can
// honestly be rendered as "withdrew X of Y". `shares` (lend redeem) is a share-receipt count,
// `newTriggerPriceUsd` (limit edit) is a price, and collateral/borrow amounts ADD rather than unwind.
const TOKEN_AMOUNT_VALUE_FIELDS: ReadonlySet<string> = new Set(['amount', 'msolAmount', 'jitoSolAmount', 'lstAmount']);

export function manageReducesByTokenAmount(kind: string): boolean {
  return TOKEN_AMOUNT_VALUE_FIELDS.has(manageValueField(kind));
}

// Past-tense verb for what a manage action did, keyed off the kind (not the category): a borrow
// position can be both repaid and withdrawn-from, so the category alone can't tell them apart.
// Order matters — 'withdraw_collateral' contains 'withdraw'.
export function positionManageVerbKey(kind: string): string | undefined {
  if (/repay/.test(kind)) return 'Repaid';
  if (/unstake/.test(kind)) return 'Unstaked';
  if (/(remove|decrease)/.test(kind)) return 'Removed';
  if (/withdraw/.test(kind)) return 'Withdrew';
  return undefined;
}

// The "0.03 / 0.05 SOL" figure. The requested amount is provable (it's in the confirmed tx) so it is
// always shown; the `/ before` half needs a LIVE before-amount, because a seed's amount predates any
// interest accrued since it was opened and would make the ratio a lie.
export function positionManageDetailValue(manage: PositionManageIntent): string | undefined {
  if (!manage.requestedAmount || !manageReducesByTokenAmount(manage.kind)) return undefined;
  if (manage.amountBefore && manage.amountBeforeFromLive) return `${manage.requestedAmount} / ${manage.amountBefore}`;
  return manage.assetLabel ? `${manage.requestedAmount} ${manage.assetLabel}` : manage.requestedAmount;
}

// Find the live row that IS this position. Reuses the manage join key (assetMint for Jupiter lend,
// orderId for trigger/recurring, …) so two Jupiter lend positions (SOL + USDC) can't be confused for
// each other. When we have a key and nothing matches it, the position is genuinely gone — never fall
// back to "some other row of the same kind", which would clear the wrong card.
export function liveRowForPosition<
  T extends { connectorId: string; kind: string; id: string; heroMint?: string; cancel?: { orderId: string } },
>(rows: readonly T[], position: { connector?: string; category: string }, joinKey?: string): T | undefined {
  const candidates = rows.filter((r) => r.connectorId === position.connector && r.kind === position.category);
  if (!joinKey) return candidates[0]; // legacy seed with no id → best-effort, today's behaviour
  return candidates.find((r) => r.cancel?.orderId === joinKey || r.id === joinKey || r.heroMint === joinKey);
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
