import { describe, expect, it } from 'vitest';

import { extractAtoms, type AgentAtom } from '../agentAtoms.js';
import {
  chainForAtom,
  resolveAtoms,
  type CapabilityResolutionAttempt,
  type CapabilityTier,
} from '../agentCapabilityRegistry.js';
import { evaluateAtoms, type ResolvedFactValue } from '../policyEvaluator.js';
import {
  analyzeTxGateAtoms,
  type SimulationDigest,
  type TxGateContext,
} from '../txGates.js';

/**
 * Integration test: full mixed-policy NOTE end-to-end.
 *
 *   1. extractAtoms              -> structured AgentAtom[]
 *   2. resolveAtoms (mocked)     -> ResolvedFactValue per atom
 *   3. evaluateAtoms             -> per-atom pass/fail with findings
 *   4. analyzeTxGateAtoms        -> deterministic tx-gate outcomes from a simulation digest
 *
 * The test asserts that every gate in the user's NOTE produces a structured outcome with
 * the right provider source and pass/fail status. This is the contract the final reviewer
 * LLM consumes, so locking it in here prevents drift between the four layers.
 */
describe('policy pipeline — extract → resolve → evaluate (+ tx gates)', () => {
  const NOTE = [
    'Run my pre-signing policy for this swap.',
    'Market gates: BTC Fear & Greed must be above 20. SOL must be above $80.',
    'Token gates: mint authority disabled. freeze authority disabled. token age above 24h.',
    'Transaction gates: only executes the requested swap. no extra transfers. no unrelated instructions.',
    'And only approve if helium phone plan is less than $20.',
  ].join('\n');

  it('extracts atoms, fans them out to the registry, and evaluates each pass/fail', async () => {
    const { atoms } = extractAtoms({ text: NOTE, knownTokenSymbols: ['SOL', 'USDC'] });
    expect(atoms.length).toBeGreaterThanOrEqual(7);

    // Stub resolver: imitate the production behavior where the first tier of each chain
    // succeeds, returning a plausible value. This proves the registry → resolver → evaluator
    // flow composes without exercising any real network.
    const resolver = async (atom: AgentAtom, tier: CapabilityTier): Promise<CapabilityResolutionAttempt> => {
      const checkedAt = new Date().toISOString();
      const base = { source: tier.provider, checkedAt };
      // Only the FIRST tier of each chain returns ok; later tiers are missing. This proves
      // the resolver short-circuits at the first success.
      const first = chainForAtom(atom)[0];
      if (tier !== first) return { ...base, status: 'missing' };
      switch (atom.type) {
        case 'price':
          if (atom.subject === 'SOL') return { ...base, status: 'ok', value: 146 };
          return { ...base, status: 'missing' };
        case 'market_regime':
          if (atom.subject === 'fear_and_greed') return { ...base, status: 'ok', value: { numeric: 42, text: 'Fear' } };
          return { ...base, status: 'ok', value: { numeric: 56 } };
        case 'token_audit':
          return { ...base, status: 'ok', value: true };
        case 'token_age':
          return { ...base, status: 'ok', value: 1_500_000 }; // ~17 days
        case 'external_price':
          return { ...base, status: 'ok', value: 15 };
        case 'tx_gate':
          return { ...base, status: 'ok', value: true }; // simulated as pass-through; analyzer below is the real check
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
        case 'sets_authority':
        case 'delegates_token':
        case 'closes_account':
        case 'daily_outflow_sum':
        case 'cooldown_since_last_tx':
        case 'recent_blockhash_age_ms':
        case 'time_of_day':
        case 'day_of_week_window':
          return { ...base, status: 'missing' };
      }
      return { ...base, status: 'missing' };
    };

    const resolutions = await resolveAtoms(atoms, resolver);
    expect(resolutions.every((r) => r.resolved || r.atom.type === 'protocol_health')).toBe(true);

    // Convert resolved values into ResolvedFactValue keyed by atom id.
    const facts: Record<string, ResolvedFactValue> = {};
    for (const res of resolutions) {
      if (!res.resolved) continue;
      const provider = String(res.resolved.source);
      const raw = res.resolved.value as unknown;
      if (typeof raw === 'number') facts[res.atom.id] = { numeric: raw, source: provider };
      else if (typeof raw === 'boolean') facts[res.atom.id] = { boolean: raw, source: provider };
      else if (raw && typeof raw === 'object' && 'numeric' in (raw as Record<string, unknown>)) {
        const v = raw as { numeric: number; text?: string };
        facts[res.atom.id] = { numeric: v.numeric, text: v.text, source: provider };
      }
    }

    const evaluations = evaluateAtoms(atoms, facts);
    // Every market/price/audit/age/external_price atom should have a definitive pass/fail.
    const decisive = evaluations.filter((e) => e.atomId.startsWith('atom.') && (e.atomId.includes('price') || e.atomId.includes('market_regime') || e.atomId.includes('token_audit') || e.atomId.includes('token_age') || e.atomId.includes('external_price')));
    expect(decisive.every((e) => e.pass === true)).toBe(true);

    // Findings include the provider source string.
    const sources = evaluations.map((e) => e.finding.value);
    expect(sources.some((v) => v.includes('jupiter'))).toBe(true);            // SOL price tier-0
    expect(sources.some((v) => v.includes('alternative_me'))).toBe(true);     // F&G tier-0
    expect(sources.some((v) => v.includes('web'))).toBe(true);                // Helium plan tier-0
  });

  it('runs deterministic tx-gate analyzers from the same atom set against a swap digest', () => {
    const { atoms } = extractAtoms({ text: NOTE, knownTokenSymbols: ['SOL', 'USDC'] });
    const txGateAtoms = atoms.filter((atom): atom is Extract<AgentAtom, { type: 'tx_gate' }> => atom.type === 'tx_gate');
    expect(txGateAtoms.length).toBeGreaterThanOrEqual(2); // only_requested_swap + no_extra_transfers + no_unrelated_instructions

    const SYSTEM = '11111111111111111111111111111111';
    const COMPUTE = 'ComputeBudget111111111111111111111111111111';
    const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    const JUPITER = 'JUP6Lkbpx6mUwBmYDPDgyARyZHbphoenzefdNzqovxN3';

    const digest: SimulationDigest = {
      ok: true,
      invokedPrograms: [COMPUTE, ATA, JUPITER],
      logs: [
        `Program ${COMPUTE} invoke [1]`,
        `Program ${COMPUTE} success`,
        `Program ${ATA} invoke [1]`,
        `Program ${SYSTEM} invoke [2]`,
        'Program log: Instruction: Transfer',
        `Program ${SYSTEM} success`,
        `Program ${ATA} success`,
        `Program ${JUPITER} invoke [1]`,
        `Program ${SPL_TOKEN} invoke [2]`,
        'Program log: Instruction: TransferChecked',
        `Program ${SPL_TOKEN} success`,
        `Program ${SPL_TOKEN} invoke [2]`,
        'Program log: Instruction: TransferChecked',
        `Program ${SPL_TOKEN} success`,
        `Program ${JUPITER} success`,
        `Program ${SYSTEM} invoke [1]`,
        'Program log: Instruction: Transfer',
        `Program ${SYSTEM} success`,
      ],
    };
    const ctx: TxGateContext = {
      allowedPrograms: new Set([SYSTEM, COMPUTE, SPL_TOKEN, ATA, JUPITER]),
      swapProgramIds: new Set([JUPITER]),
      isSwap: true,
    };
    const outcomes = analyzeTxGateAtoms(txGateAtoms, digest, ctx);
    // Every supported atom got an outcome and every outcome passed for this clean swap.
    expect(Object.values(outcomes).every((o) => o.pass)).toBe(true);
    expect(Object.keys(outcomes).length).toBe(txGateAtoms.length);
  });
});
