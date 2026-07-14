import { describe, expect, it } from 'vitest';

import {
  POSITION_BROWSE_TYPES,
  chatManageNeedsPrompt,
  manageProposalParams,
  manageValueField,
  matchPositionBrowseType,
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
