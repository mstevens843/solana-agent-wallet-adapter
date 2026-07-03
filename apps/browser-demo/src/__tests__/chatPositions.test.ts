import { describe, expect, it } from 'vitest';

import { POSITION_BROWSE_TYPES, manageProposalParams, matchPositionBrowseType } from '../chatPositions.js';

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

  it('exposes exactly the six browsable types with count labels', () => {
    expect(POSITION_BROWSE_TYPES.map((t) => t.category)).toEqual(['limit', 'dca', 'lend', 'borrow', 'stake', 'lp']);
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
});
