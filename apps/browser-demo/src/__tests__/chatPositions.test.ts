import { describe, expect, it } from 'vitest';

import {
  POSITION_BROWSE_TYPES,
  POSITION_SETTLE_MS,
  type PositionManageIntent,
  chatManageNeedsPrompt,
  liveRowForPosition,
  manageProposalParams,
  manageReducesByTokenAmount,
  manageValueField,
  matchPositionBrowseType,
  positionManageDetailValue,
  positionManageIsTerminal,
  positionManagePhaseAt,
  positionManageVerbKey,
} from '../chatPositions.js';

describe('chat Active Positions helpers', () => {
  it('matches bare position-type words (case-insensitive), including plurals/synonyms', () => {
    expect(matchPositionBrowseType('dca')).toBe('dca');
    expect(matchPositionBrowseType('DCA')).toBe('dca');
    expect(matchPositionBrowseType('limit')).toBe('limit');
    expect(matchPositionBrowseType('limit orders')).toBe('limit');
    expect(matchPositionBrowseType('lend')).toBe('lend');
    expect(matchPositionBrowseType('lending')).toBe('lend');
    expect(matchPositionBrowseType('borrow')).toBe('borrow');
    expect(matchPositionBrowseType('  stake ')).toBe('stake');
    expect(matchPositionBrowseType('liquidity')).toBe('lp');
  });

  it('does NOT hijack ordinary chat that merely contains a type word', () => {
    expect(matchPositionBrowseType('lend me advice')).toBeNull();
    expect(matchPositionBrowseType('what is my dca doing')).toBeNull();
    expect(matchPositionBrowseType('should I borrow SOL?')).toBeNull();
    expect(matchPositionBrowseType('')).toBeNull();
  });

  it('exposes exactly the seven browsable types with count labels', () => {
    expect(POSITION_BROWSE_TYPES.map((t) => t.category)).toEqual(['limit', 'dca', 'lend', 'borrow', 'stake', 'lp', 'perps']);
    for (const t of POSITION_BROWSE_TYPES) expect(t.countLabel.length).toBeGreaterThan(0);
  });

  it('builds manage params with the kind-specific id field, carried fields, and optional amount', () => {
    // Cancel a DCA order (no amount): orderId under the id field, no amount key.
    expect(manageProposalParams('orderId', 'ord-1', {})).toEqual({ orderId: 'ord-1' });
    // Repay a borrow (amount + carried vaultId/positionId).
    expect(manageProposalParams('positionId', '7', { vaultId: '3', positionId: '7' }, '2.5')).toEqual({
      vaultId: '3',
      positionId: '7',
      amount: '2.5',
    });
    // Withdraw-all redeem (shares prefilled in fields, no amount).
    expect(manageProposalParams('assetMint', 'USDC', { shares: '10.5' })).toEqual({ assetMint: 'USDC', shares: '10.5' });
  });

  it('maps each manage action to the exact connector param field its value fills', () => {
    expect(manageValueField('jupiter_trigger_edit_order')).toBe('newTriggerPriceUsd');
    expect(manageValueField('jupiter_lend_borrow_deposit_collateral')).toBe('collateralAmount');
    expect(manageValueField('jupiter_lend_borrow_borrow')).toBe('borrowAmount');
    expect(manageValueField('jupiter_lend_borrow_repay')).toBe('amount');
    expect(manageValueField('jupiter_lend_earn_withdraw')).toBe('amount');
    expect(manageValueField('marinade_liquid_unstake')).toBe('msolAmount');
    expect(manageValueField('jito_unstake_jitosol')).toBe('jitoSolAmount');
    expect(manageValueField('sanctum_unstake_lst_to_sol')).toBe('lstAmount');
    expect(manageValueField('meteora_remove_liquidity')).toBe('amount');
    expect(manageValueField('jupiter_trigger_cancel_order')).toBe('amount'); // default; cancel never prompts
  });

  it('prompts for a value only where one is genuinely needed (edit always; closes are one-tap)', () => {
    expect(chatManageNeedsPrompt('jupiter_trigger_edit_order')).toBe(true);
    expect(chatManageNeedsPrompt('jupiter_lend_borrow_repay')).toBe(true);
    expect(chatManageNeedsPrompt('jupiter_lend_borrow_borrow')).toBe(true);
    expect(chatManageNeedsPrompt('sanctum_unstake_lst_to_sol')).toBe(true);
    expect(chatManageNeedsPrompt('meteora_remove_liquidity')).toBe(true);
    // One-tap: no value, or a prefilled "all" value.
    expect(chatManageNeedsPrompt('jupiter_trigger_cancel_order')).toBe(false);
    expect(chatManageNeedsPrompt('jupiter_recurring_cancel_order')).toBe(false);
    expect(chatManageNeedsPrompt('jupiter_lend_earn_redeem')).toBe(false);
    expect(chatManageNeedsPrompt('marinade_liquid_unstake')).toBe(false);
    expect(chatManageNeedsPrompt('meteora_claim_fees')).toBe(false);
  });

  it('writes the typed value into the action-specific field, overriding a prefilled current value', () => {
    // Edit: the typed new price overrides the prefilled current price; slippage/expiry are kept.
    expect(
      manageProposalParams('orderId', 'ord-9', { orderType: 'single', newTriggerPriceUsd: '100', newSlippageBps: '50' }, '125', 'newTriggerPriceUsd'),
    ).toEqual({ orderType: 'single', newSlippageBps: '50', orderId: 'ord-9', newTriggerPriceUsd: '125' });
    // Borrow more writes borrowAmount, not amount.
    expect(manageProposalParams('positionId', '7', { vaultId: '3', positionId: '7' }, '5', 'borrowAmount')).toEqual({
      vaultId: '3',
      positionId: '7',
      borrowAmount: '5',
    });
  });
});

// A confirmed withdraw used to leave the card on "Updating…" forever: the flag could only be cleared
// by a successful live read, and the one refetch after it fired inside a 2-minute reconcile guard, so
// it was guaranteed to decide nothing and nothing ever re-read. These pin the replacement's contract.
describe('positions manage-settle lifecycle', () => {
  const intent = (over: Partial<PositionManageIntent> = {}): PositionManageIntent => ({
    actionId: 'act-1',
    kind: 'jupiter_lend_earn_withdraw',
    requestedAt: new Date(Date.now() - 1_000).toISOString(),
    settleDeadlineAt: new Date(Date.now() + POSITION_SETTLE_MS).toISOString(),
    phase: 'pending',
    ...over,
  });

  it('NEVER STUCK: a pending record past its deadline reports terminal with no live read at all', () => {
    const stale = intent({ settleDeadlineAt: new Date(Date.now() - 1).toISOString() });
    expect(positionManagePhaseAt(stale, Date.now())).toBe('unconfirmed');
    expect(positionManageIsTerminal(positionManagePhaseAt(stale, Date.now()))).toBe(true);
    // ...and the 13-day-old case from the bug report.
    const ancient = intent({ settleDeadlineAt: new Date(Date.now() - 13 * 86_400_000).toISOString() });
    expect(positionManagePhaseAt(ancient, Date.now())).toBe('unconfirmed');
  });

  it('stays pending inside the settle window, and an unparseable deadline still resolves', () => {
    expect(positionManagePhaseAt(intent(), Date.now())).toBe('pending');
    expect(positionManageIsTerminal('pending')).toBe(false);
    // A corrupt deadline must not mean "Updating… forever".
    expect(positionManagePhaseAt(intent({ settleDeadlineAt: 'not-a-date' }), Date.now())).toBe('unconfirmed');
  });

  it('never re-opens a phase a live read already proved', () => {
    const past = new Date(Date.now() - 10 * 86_400_000).toISOString();
    for (const phase of ['reduced', 'closed', 'unconfirmed'] as const) {
      expect(positionManagePhaseAt(intent({ phase, settleDeadlineAt: past }), Date.now())).toBe(phase);
    }
  });

  it('HONESTY: the ratio needs a LIVE before-amount; a stale seed one degrades to the bare amount', () => {
    // Proven both ends → "withdrew 0.03 of the 0.05 that was there".
    expect(positionManageDetailValue(intent({ requestedAmount: '0.03', amountBefore: '0.05 SOL', amountBeforeFromLive: true })))
      .toBe('0.03 / 0.05 SOL');
    // Seed-derived before-amount predates any accrued interest → show only what we can prove.
    expect(positionManageDetailValue(intent({ requestedAmount: '0.03', amountBefore: '0.05 SOL', amountBeforeFromLive: false, assetLabel: 'SOL' })))
      .toBe('0.03 SOL');
    // No unit known → still show the provable number rather than nothing.
    expect(positionManageDetailValue(intent({ requestedAmount: '0.03' }))).toBe('0.03');
  });

  it('only claims an unwound amount when the value IS one (not shares, not a price)', () => {
    // Redeem's value is a share-receipt count, and Edit's is a USD price — neither is an amount withdrawn.
    expect(positionManageDetailValue(intent({ kind: 'jupiter_lend_earn_redeem', requestedAmount: '10.5' }))).toBeUndefined();
    expect(positionManageDetailValue(intent({ kind: 'jupiter_trigger_edit_order', requestedAmount: '125' }))).toBeUndefined();
    // A one-tap cancel carries no value at all.
    expect(positionManageDetailValue(intent({ kind: 'jupiter_trigger_cancel_order' }))).toBeUndefined();
    expect(manageReducesByTokenAmount('jupiter_lend_earn_withdraw')).toBe(true);
    expect(manageReducesByTokenAmount('marinade_liquid_unstake')).toBe(true);
    expect(manageReducesByTokenAmount('jupiter_lend_earn_redeem')).toBe(false);
    // Borrowing more / adding collateral grows a position — it is not an unwind.
    expect(manageReducesByTokenAmount('jupiter_lend_borrow_borrow')).toBe(false);
    expect(manageReducesByTokenAmount('jupiter_lend_borrow_deposit_collateral')).toBe(false);
  });

  it('labels the verb per kind — a borrow can be both repaid and withdrawn from', () => {
    expect(positionManageVerbKey('jupiter_lend_earn_withdraw')).toBe('Withdrew');
    expect(positionManageVerbKey('jupiter_lend_borrow_repay')).toBe('Repaid');
    // 'withdraw_collateral' contains "withdraw" but is not a repay — order of checks matters.
    expect(positionManageVerbKey('jupiter_lend_borrow_withdraw_collateral')).toBe('Withdrew');
    expect(positionManageVerbKey('marinade_liquid_unstake')).toBe('Unstaked');
    expect(positionManageVerbKey('meteora_remove_liquidity')).toBe('Removed');
    expect(positionManageVerbKey('orca_decrease_liquidity')).toBe('Removed');
    expect(positionManageVerbKey('jupiter_trigger_cancel_order')).toBeUndefined();
  });
});

describe('positions live-row matching (asset discrimination)', () => {
  const sol = { connectorId: 'jupiter', kind: 'lend', id: 'share-sol', heroMint: 'So111', cancel: { orderId: 'So111' } };
  const usdc = { connectorId: 'jupiter', kind: 'lend', id: 'share-usdc', heroMint: 'EPjF', cancel: { orderId: 'EPjF' } };
  const rows = [sol, usdc];
  const lend = { connector: 'jupiter', category: 'lend' };

  it('resolves the position that matches the join key, not just any row of the same kind', () => {
    expect(liveRowForPosition(rows, lend, 'EPjF')).toBe(usdc);
    expect(liveRowForPosition(rows, lend, 'So111')).toBe(sol);
  });

  it('reports GONE when a keyed position has no matching row — never falls back to a sibling', () => {
    // Withdrawing all the USDC must retire the USDC card, not clear the flag off the surviving SOL one.
    expect(liveRowForPosition([sol], lend, 'EPjF')).toBeUndefined();
    expect(liveRowForPosition([], lend, 'EPjF')).toBeUndefined();
  });

  it('scopes to the position’s own connector + category', () => {
    expect(liveRowForPosition(rows, { connector: 'kamino', category: 'lend' }, 'EPjF')).toBeUndefined();
    expect(liveRowForPosition(rows, { connector: 'jupiter', category: 'borrow' }, 'EPjF')).toBeUndefined();
  });

  it('falls back to the first same-kind row only for a legacy seed carrying no id', () => {
    expect(liveRowForPosition(rows, lend, undefined)).toBe(sol);
    expect(liveRowForPosition([], lend, undefined)).toBeUndefined();
  });
});
