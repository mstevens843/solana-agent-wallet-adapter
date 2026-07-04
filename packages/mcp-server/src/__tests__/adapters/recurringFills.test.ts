import { describe, expect, it } from 'vitest';

import { normalizeRecurringFills, normalizeRecurringOrder } from '../../adapters/jupiter/recurringOrders.js';

const WALLET = 'DcaWa11etAdd ress11111111111111111111111111'.replace(/\s/g, '');

describe('normalizeRecurringFills', () => {
  it('extracts per-cycle fills (txId + amounts + confirmedAt) from a trades array', () => {
    const fills = normalizeRecurringFills({
      trades: [
        { txId: 'Sig1111111111111111111111111111111111111111', inputAmount: '25', outputAmount: '0.12', confirmedAt: '2026-07-04T10:00:00Z' },
        { txId: 'Sig2222222222222222222222222222222222222222', inputAmount: '25', outputAmount: '0.11', confirmedAt: 1_751_622_000 },
      ],
    });
    expect(fills).toHaveLength(2);
    expect(fills[0]).toMatchObject({ txId: 'Sig1111111111111111111111111111111111111111', inputAmount: '25', outputAmount: '0.12' });
    expect(fills[0]!.confirmedAt).toBe('2026-07-04T10:00:00.000Z');
    // numeric epoch seconds are normalized to ISO too
    expect(typeof fills[1]!.confirmedAt).toBe('string');
  });

  it('reads alias field names and drops entries with no tx signature', () => {
    const fills = normalizeRecurringFills({
      trades: [
        { txSignature: 'AliasSig111111111111111111111111111111111111', inAmount: '10', outAmount: '5' },
        { inputAmount: '10' }, // no signature → dropped (can't back a receipt)
      ],
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ txId: 'AliasSig111111111111111111111111111111111111', inputAmount: '10', outputAmount: '5' });
  });

  it('returns an empty list when the order carries no trades', () => {
    expect(normalizeRecurringFills({ orderKey: 'x', numberOfOrders: 4 })).toEqual([]);
  });

  it('normalizeRecurringOrder attaches fills to the snapshot only when present', () => {
    const withFills = normalizeRecurringOrder(WALLET, {
      orderKey: 'Order111111111111111111111111111111111111111',
      numberOfOrders: 4,
      executedOrders: 2,
      trades: [{ txId: 'Sig1111111111111111111111111111111111111111', inputAmount: '25' }],
    });
    expect(withFills.fills).toHaveLength(1);
    expect(withFills.executedOrders).toBe(2);

    const withoutFills = normalizeRecurringOrder(WALLET, {
      orderKey: 'Order222222222222222222222222222222222222222',
      numberOfOrders: 4,
    });
    expect(withoutFills.fills).toBeUndefined();
  });
});
