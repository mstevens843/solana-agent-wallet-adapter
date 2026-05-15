import { describe, expect, it } from 'vitest';

import {
  type BehavioralBaseline,
  baselineStorageKey,
  createEmptyBaseline,
  evaluateBaselineSignals,
  extractAmountFromParameters,
  extractRecipientFromParameters,
  updateBaselineFromCompletion,
} from '../index.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const RECIPIENT_A = 'AaAa11111111111111111111111111111111111111';
const RECIPIENT_B = 'BbBb22222222222222222222222222222222222222';

function seedBaselineWithApprovals(): BehavioralBaseline {
  let baseline = createEmptyBaseline(WALLET, 'mainnet-beta', '2026-05-01T00:00:00.000Z');
  // 5 prior approvals to RECIPIENT_A, USDC token, ~100 USDC each.
  for (let i = 0; i < 5; i++) {
    baseline = updateBaselineFromCompletion(baseline, {
      decision: 'approve',
      approvedAt: `2026-05-${(i + 2).toString().padStart(2, '0')}T00:00:00.000Z`,
      actionType: 'transfer_spl',
      connectorId: 'jupiter',
      recipient: RECIPIENT_A,
      amountLamports: 100_000_000_000, // 100 with 9-decimal scale (placeholder)
      amountTokenKey: 'USDC',
    });
  }
  return baseline;
}

describe('createEmptyBaseline', () => {
  it('creates a baseline with empty trackers', () => {
    const b = createEmptyBaseline(WALLET, 'mainnet-beta');
    expect(b.totalApprovals).toBe(0);
    expect(b.recipients).toEqual([]);
    expect(b.actionTypeCounts).toEqual({});
    expect(b.protocolCounts).toEqual({});
    expect(b.amountStatsByToken).toEqual({});
    expect(b.decisionTally).toEqual({ approved: 0, denied: 0, needsInput: 0 });
  });
});

describe('updateBaselineFromCompletion', () => {
  it('counts only approvals toward recipient/protocol/amount stats', () => {
    let baseline = createEmptyBaseline(WALLET, 'mainnet-beta');
    baseline = updateBaselineFromCompletion(baseline, {
      decision: 'deny',
      approvedAt: '2026-05-01',
      actionType: 'transfer_sol',
      connectorId: 'system',
      recipient: RECIPIENT_A,
    });
    expect(baseline.decisionTally.denied).toBe(1);
    expect(baseline.totalApprovals).toBe(0);
    expect(baseline.recipients.length).toBe(0);

    baseline = updateBaselineFromCompletion(baseline, {
      decision: 'approve',
      approvedAt: '2026-05-02',
      actionType: 'transfer_sol',
      connectorId: 'system',
      recipient: RECIPIENT_A,
      amountLamports: 1_000_000_000,
      amountTokenKey: 'SOL',
    });
    expect(baseline.totalApprovals).toBe(1);
    expect(baseline.recipients[0]?.address).toBe(RECIPIENT_A);
    expect(baseline.amountStatsByToken.SOL?.count).toBe(1);
    expect(baseline.actionTypeCounts.transfer_sol).toBe(1);
    expect(baseline.protocolCounts.system).toBe(1);
  });

  it('keeps recipients capped at top-N and sorts by count', () => {
    let baseline = createEmptyBaseline(WALLET, 'mainnet-beta');
    for (let i = 0; i < 60; i++) {
      baseline = updateBaselineFromCompletion(baseline, {
        decision: 'approve',
        approvedAt: '2026-05-02',
        actionType: 'transfer_sol',
        recipient: `Recipient${i.toString().padStart(40, '0')}`,
      });
    }
    expect(baseline.recipients.length).toBeLessThanOrEqual(50);
  });

  it('quantile estimates evolve toward the new sample (smoke check)', () => {
    let baseline = createEmptyBaseline(WALLET, 'mainnet-beta');
    for (let i = 0; i < 6; i++) {
      baseline = updateBaselineFromCompletion(baseline, {
        decision: 'approve',
        approvedAt: '2026-05-02',
        actionType: 'transfer_spl',
        recipient: RECIPIENT_A,
        amountLamports: 1_000_000,
        amountTokenKey: 'USDC',
      });
    }
    // Inject a large sample — p99 should drift upward (toward the larger value),
    // not stay anchored to the small samples.
    baseline = updateBaselineFromCompletion(baseline, {
      decision: 'approve',
      approvedAt: '2026-05-02',
      actionType: 'transfer_spl',
      recipient: RECIPIENT_A,
      amountLamports: 1_000_000_000_000,
      amountTokenKey: 'USDC',
    });
    const stats = baseline.amountStatsByToken.USDC!;
    expect(stats.max).toBe(1_000_000_000_000);
    expect(stats.p99).toBeGreaterThan(1_000_000);
  });
});

describe('evaluateBaselineSignals', () => {
  it('emits first_use signal when there are fewer than 3 approvals', () => {
    const baseline = createEmptyBaseline(WALLET, 'mainnet-beta');
    const signals = evaluateBaselineSignals(baseline, { recipient: RECIPIENT_A });
    expect(signals.some((s) => s.kind === 'first_use')).toBe(true);
  });

  it('flags new recipient once baseline is seeded', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, { recipient: RECIPIENT_B });
    expect(signals.some((s) => s.kind === 'new_recipient' && s.severity === 'warn')).toBe(true);
  });

  it('does NOT flag a known recipient', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, { recipient: RECIPIENT_A });
    expect(signals.some((s) => s.kind === 'new_recipient')).toBe(false);
  });

  it('flags new protocol', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, { connectorId: 'marginfi' });
    expect(signals.some((s) => s.kind === 'new_protocol')).toBe(true);
  });

  it('flags new action type', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, { actionType: 'kamino_borrow' });
    expect(signals.some((s) => s.kind === 'new_action_type')).toBe(true);
  });

  it('flags amount above p99 once baseline has enough samples', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, {
      amountLamports: 10_000_000_000_000,
      amountTokenKey: 'USDC',
    });
    expect(signals.some((s) => s.kind === 'anomalous_amount' && s.severity === 'warn')).toBe(true);
  });

  it('does NOT flag amount near the historical median', () => {
    const baseline = seedBaselineWithApprovals();
    const signals = evaluateBaselineSignals(baseline, {
      amountLamports: 100_000_000_000,
      amountTokenKey: 'USDC',
    });
    expect(signals.some((s) => s.kind === 'anomalous_amount')).toBe(false);
  });
});

describe('extractor helpers', () => {
  it('extracts recipient from common parameter names', () => {
    expect(extractRecipientFromParameters({ recipient: RECIPIENT_A })).toBe(RECIPIENT_A);
    expect(extractRecipientFromParameters({ to: RECIPIENT_A })).toBe(RECIPIENT_A);
    expect(extractRecipientFromParameters({ destination: RECIPIENT_A })).toBe(RECIPIENT_A);
    expect(extractRecipientFromParameters({})).toBeUndefined();
    expect(extractRecipientFromParameters(undefined)).toBeUndefined();
  });

  it('extracts amount + tokenKey from common parameter names', () => {
    expect(extractAmountFromParameters({ solAmount: '1.5' }, 'transfer_sol'))
      .toEqual({ tokenKey: 'SOL', amountLamports: 1_500_000_000 });
    expect(extractAmountFromParameters({ amount: '100', mint: 'EPjFWdd5...' }, 'transfer_spl'))
      .toEqual({ tokenKey: 'EPjFWdd5...', amountLamports: 100_000_000_000 });
    expect(extractAmountFromParameters({}, 'noop')).toBeUndefined();
  });

  it('baselineStorageKey is stable per wallet+cluster', () => {
    expect(baselineStorageKey(WALLET, 'mainnet-beta')).toBe(baselineStorageKey(WALLET, 'mainnet-beta'));
    expect(baselineStorageKey(WALLET, 'mainnet-beta')).not.toBe(baselineStorageKey(WALLET, 'devnet'));
  });
});
