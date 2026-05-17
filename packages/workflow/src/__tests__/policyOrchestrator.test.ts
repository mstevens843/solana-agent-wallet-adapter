import { describe, expect, it } from 'vitest';

import type { AgentAtom } from '../agentAtoms.js';
import { chainForAtom, type CapabilityResolutionAttempt, type CapabilityTier } from '../agentCapabilityRegistry.js';
import { runPolicyPipeline } from '../policyOrchestrator.js';
import type { SimulationDigest, TxGateContext } from '../txGates.js';

function okValue(value: unknown, tier: CapabilityTier): CapabilityResolutionAttempt {
  return { status: 'ok', value, source: tier.provider, endpoint: tier.endpoint, checkedAt: new Date().toISOString() };
}

const NOTE = [
  'BTC Fear & Greed must be above 20.',
  'SOL must be above $80.',
  'mint authority disabled.',
  'token age above 24h.',
  'only executes the requested swap.',
  'no extra transfers.',
  'no unrelated instructions.',
  'And only approve if helium phone plan is less than $20.',
].join('\n');

const SYSTEM = '11111111111111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

function cleanSwapDigest(): SimulationDigest {
  return {
    ok: true,
    invokedPrograms: [COMPUTE, ATA, JUPITER],
    logs: [
      `Program ${COMPUTE} invoke [1]`,
      `Program ${COMPUTE} success`,
      `Program ${JUPITER} invoke [1]`,
      `Program ${SPL_TOKEN} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${SPL_TOKEN} success`,
      `Program ${SPL_TOKEN} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${SPL_TOKEN} success`,
      `Program ${JUPITER} success`,
    ],
  };
}

const swapCtx: TxGateContext = {
  allowedPrograms: new Set([SYSTEM, COMPUTE, SPL_TOKEN, ATA, JUPITER]),
  swapProgramIds: new Set([JUPITER]),
  isSwap: true,
  expectedSolTransfers: 0,
};

describe('runPolicyPipeline', () => {
  it('returns empty bundle on empty NOTE', async () => {
    const bundle = await runPolicyPipeline({ text: '', resolver: async () => ({ status: 'missing', source: 'web', checkedAt: new Date().toISOString() }) });
    expect(bundle.atoms).toHaveLength(0);
    expect(bundle.evaluations).toHaveLength(0);
    expect(bundle.hasBlockingFailure).toBe(false);
  });

  it('extracts, resolves, evaluates, and runs tx-gate analyzers end-to-end', async () => {
    const resolver = async (atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt> => {
      // First-tier success per atom type. Web tiers always defer (status=missing).
      const first = chainForAtom(atom)[0];
      if (tier !== first) return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
      switch (atom.type) {
        case 'price':
          return okValue(146, tier);                                             // SOL > $80 → pass
        case 'market_regime':
          if (atom.subject === 'fear_and_greed') return okValue({ numeric: 42, text: 'Fear' }, tier);
          return okValue({ numeric: 56 }, tier);
        case 'token_audit':
          return okValue(true, tier);                                            // mint auth disabled → pass
        case 'token_age':
          return okValue(86_400 * 30, tier);                                     // 30 days → pass
        case 'external_price':
          return okValue(15, tier);                                              // helium plan $15 < $20 → pass
        case 'tx_gate':
          return { status: 'missing' as const, source: 'rpc', checkedAt: new Date().toISOString() };
        case 'protocol_health':
        case 'external_state':
        case 'external_event':
        case 'external_identity':
        case 'tradfi_price':
        case 'time_fact':
        case 'network_metric':
        case 'wallet_balance':
        case 'token_balance':
        case 'relative_amount':
        case 'tx_fee':
        case 'network_congestion':
        case 'token_supply':
        case 'mint_decimals':
        case 'wallet_age_onchain':
        case 'recipient_known':
        case 'token_held_duration':
        case 'required_signatures':
        case 'instruction_count':
        case 'account_writability_count':
        case 'rent_exempt_required':
          return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
      }
    };
    const bundle = await runPolicyPipeline({
      text: NOTE,
      knownTokenSymbols: ['SOL', 'USDC'],
      resolver,
      simulation: cleanSwapDigest(),
      txGateContext: swapCtx,
      resolveOptions: { retryDelayMs: 0 },
    });

    // Every atom got an evaluation; the only unresolved ones should be tx_gate atoms
    // for which the analyzer isn't supported (none here).
    expect(bundle.evaluations.length).toBe(bundle.atoms.length);
    // No blocking failures — all gates pass for this clean swap.
    expect(bundle.hasBlockingFailure).toBe(false);
    // tx_gate outcomes were recorded for the three supported rules.
    expect(Object.keys(bundle.txGateOutcomes).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(bundle.txGateOutcomes).every((o) => o.pass)).toBe(true);
  });

  it('reports hasBlockingFailure when a price atom fails its threshold', async () => {
    const resolver = async (atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt> => {
      const first = chainForAtom(atom)[0];
      if (tier !== first) return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
      // SOL price 50 < $80 threshold → fails.
      if (atom.type === 'price') return okValue(50, tier);
      // Everything else missing.
      return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
    };
    const bundle = await runPolicyPipeline({ text: 'SOL must be above $80.', resolver, resolveOptions: { retryDelayMs: 0 } });
    expect(bundle.hasBlockingFailure).toBe(true);
    expect(bundle.evaluations.find((e) => e.atomId.startsWith('atom.price.'))?.pass).toBe(false);
  });

  it('marks tx_gate atoms unresolved when no simulation supplied', async () => {
    const resolver = async (_atom: AgentAtom, tier: CapabilityTier) => ({ status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() });
    const bundle = await runPolicyPipeline({
      text: 'no extra transfers. no unrelated instructions.',
      resolver,
      resolveOptions: { retryDelayMs: 0 },
    });
    expect(bundle.evaluations.every((e) => e.atomId.startsWith('atom.tx_gate.') && e.unresolved === true)).toBe(true);
  });

  it('coerces raw number/boolean values from the resolver', async () => {
    const resolver = async (atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt> => {
      // Mix of return shapes: raw number for price; raw boolean for token_audit.
      const first = chainForAtom(atom)[0];
      if (tier !== first) return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
      if (atom.type === 'price') return okValue(99, tier);
      if (atom.type === 'token_audit') return okValue(true, tier);
      return { status: 'missing' as const, source: tier.provider, checkedAt: new Date().toISOString() };
    };
    const bundle = await runPolicyPipeline({
      text: 'SOL > $80 and mint authority disabled',
      resolver,
      resolveOptions: { retryDelayMs: 0 },
    });
    const priceEval = bundle.evaluations.find((e) => e.atomId.startsWith('atom.price.'));
    const auditEval = bundle.evaluations.find((e) => e.atomId.startsWith('atom.token_audit.'));
    expect(priceEval?.pass).toBe(true);
    expect(auditEval?.pass).toBe(true);
  });
});
