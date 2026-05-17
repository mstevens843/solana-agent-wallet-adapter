/**
 * Policy orchestrator — composes the atom pipeline for a single review.
 *
 *   extract → resolve (with retries + telemetry) → evaluate → tx-gate analyze
 *
 * Callers supply:
 *   - The raw NOTE / instruction text.
 *   - A `CapabilityResolverFn` (per-deployment; mcp-server provides one in
 *     `packages/mcp-server/src/agentResolvers/index.ts`).
 *   - Optional `SimulationDigest` + `TxGateContext` when a prepared transaction
 *     exists, so tx_gate atoms can be deterministically analyzed.
 *   - Optional `knownTokenSymbols` to disambiguate `$X` thresholds.
 *
 * The orchestrator returns a structured `PolicyEvaluationBundle` that the
 * reviewer LLM consumes as already-resolved facts (no rediscovery, no
 * model judgment over raw simulation logs).
 */

import {
  extractAtoms,
  extractAtomsWithLlmFallback,
  type AgentAtom,
  type AgentAtomLlmExtractor,
  type TxGateAtom,
} from './agentAtoms.js';
import {
  resolveAtoms,
  type CapabilityResolverFn,
  type CapabilityResolution,
  type ResolveOptions,
} from './agentCapabilityRegistry.js';
import {
  evaluateAtoms,
  type AtomEvaluation,
  type ResolvedFactValue,
} from './policyEvaluator.js';
import {
  analyzeTxGateAtoms,
  type SimulationDigest,
  type TxGateContext,
  type TxGateOutcome,
} from './txGates.js';

export interface RunPolicyPipelineInput {
  /** Free-form NOTE / instruction text the user typed. */
  text: string;
  /** Optional symbols already known from the draft, used to disambiguate price atoms. */
  knownTokenSymbols?: string[];
  /** Capability resolver — wired per-deployment. */
  resolver: CapabilityResolverFn;
  /** Optional simulation digest for tx_gate atoms. Required to actually run the analyzers. */
  simulation?: SimulationDigest;
  /** Optional tx gate context. Required when `simulation` is provided. */
  txGateContext?: TxGateContext;
  /** Optional resolve options (retry, telemetry trace hook). */
  resolveOptions?: ResolveOptions;
  /**
   * Optional LLM atom-extraction fallback. When supplied AND the regex extractor returns
   * no atoms but the text reads like a policy, this function is invoked to decompose the
   * NOTE into structured atoms. Useful for novel phrasings outside the regex vocabulary.
   */
  llmAtomExtractor?: AgentAtomLlmExtractor;
}

export interface PolicyEvaluationBundle {
  atoms: AgentAtom[];
  resolutions: CapabilityResolution[];
  evaluations: AtomEvaluation[];
  txGateOutcomes: Record<string, TxGateOutcome>;
  /** Atoms whose resolution chain was exhausted (no provider returned ok). */
  unresolvedAtoms: AgentAtom[];
  /** Whether any decisive evaluation reported pass=false. Useful for short-circuit denial. */
  hasBlockingFailure: boolean;
  /** ISO timestamp of pipeline completion. */
  finishedAt: string;
}

/**
 * Run the full policy pipeline once for a review request.
 *
 * Behavior:
 *   1. Extract structured atoms from the NOTE.
 *   2. Resolve every non-tx_gate atom in parallel via the supplied resolver.
 *   3. Build `ResolvedFactValue` map keyed by atom id.
 *   4. Evaluate each atom against its fact (pass/fail/unresolved).
 *   5. If a simulation digest is supplied, run tx_gate analyzers and surface outcomes.
 *
 * The orchestrator is pure (apart from the injected resolver). All network I/O
 * goes through the resolver, so unit tests can pass stubs.
 */
export async function runPolicyPipeline(input: RunPolicyPipelineInput): Promise<PolicyEvaluationBundle> {
  const extracted = input.llmAtomExtractor
    ? await extractAtomsWithLlmFallback(
        { text: input.text, knownTokenSymbols: input.knownTokenSymbols },
        { llm: input.llmAtomExtractor },
      )
    : extractAtoms({ text: input.text, knownTokenSymbols: input.knownTokenSymbols });
  const { atoms } = extracted;
  const finishedAt = () => new Date().toISOString();
  if (atoms.length === 0) {
    return {
      atoms: [],
      resolutions: [],
      evaluations: [],
      txGateOutcomes: {},
      unresolvedAtoms: [],
      hasBlockingFailure: false,
      finishedAt: finishedAt(),
    };
  }

  // tx_gate atoms are not resolved through the registry — they're analyzed from the
  // simulation digest after the fact. Resolve everything else in parallel.
  const nonTxGate = atoms.filter((atom): atom is Exclude<AgentAtom, TxGateAtom> => atom.type !== 'tx_gate');
  const txGateAtoms = atoms.filter((atom): atom is TxGateAtom => atom.type === 'tx_gate');

  const resolutions = await resolveAtoms(nonTxGate, input.resolver, input.resolveOptions);

  const factMap: Record<string, ResolvedFactValue> = {};
  for (const resolution of resolutions) {
    if (!resolution.resolved) continue;
    const provider = String(resolution.resolved.source);
    const raw = resolution.resolved.value;
    const fact = coerceResolvedFact(raw, provider, resolution.resolved.checkedAt);
    if (fact) factMap[resolution.atom.id] = fact;
  }

  const evaluations = evaluateAtoms(nonTxGate, factMap);

  // If a simulation digest is supplied, also evaluate tx_gate atoms deterministically.
  const txGateOutcomes: Record<string, TxGateOutcome> = input.simulation && input.txGateContext && txGateAtoms.length > 0
    ? analyzeTxGateAtoms(txGateAtoms, input.simulation, input.txGateContext)
    : {};

  // Append tx_gate evaluations into the main evaluations array so the consumer has a
  // single list to iterate.
  for (const atom of txGateAtoms) {
    const outcome = txGateOutcomes[atom.id];
    if (outcome) {
      evaluations.push({
        atomId: atom.id,
        pass: outcome.pass,
        finding: {
          label: `Tx gate: ${atom.rule.replace(/_/g, ' ')}`,
          value: outcome.reason,
          tone: outcome.pass ? 'good' : 'fail',
        },
      });
    } else {
      // Unsupported rule or no simulation supplied → unresolved.
      evaluations.push({
        atomId: atom.id,
        pass: undefined,
        unresolved: true,
        finding: {
          label: `Tx gate: ${atom.rule.replace(/_/g, ' ')}`,
          value: input.simulation ? 'rule not yet supported' : 'no simulation available',
          tone: 'warn',
        },
      });
    }
  }

  const unresolvedAtoms = atoms.filter((atom) => {
    const evaluation = evaluations.find((e) => e.atomId === atom.id);
    return !evaluation || evaluation.unresolved === true;
  });

  const hasBlockingFailure = evaluations.some((e) => e.pass === false);

  return {
    atoms,
    resolutions,
    evaluations,
    txGateOutcomes,
    unresolvedAtoms,
    hasBlockingFailure,
    finishedAt: finishedAt(),
  };
}

/**
 * Coerce arbitrary resolver values into the canonical `ResolvedFactValue` shape.
 * Resolvers MAY return:
 *   - a raw number (treated as `.numeric`)
 *   - a raw boolean (treated as `.boolean`)
 *   - a partial ResolvedFactValue ({ numeric?, boolean?, text? })
 *   - anything else (ignored as missing)
 */
function coerceResolvedFact(raw: unknown, source: string, checkedAt?: string): ResolvedFactValue | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { numeric: raw, source, ...(checkedAt ? { checkedAt } : {}) };
  if (typeof raw === 'boolean') return { boolean: raw, source, ...(checkedAt ? { checkedAt } : {}) };
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const numeric = typeof rec.numeric === 'number' && Number.isFinite(rec.numeric) ? rec.numeric : undefined;
    const boolean = typeof rec.boolean === 'boolean' ? rec.boolean : undefined;
    const text = typeof rec.text === 'string' ? rec.text : undefined;
    if (numeric !== undefined || boolean !== undefined || text !== undefined) {
      return {
        ...(numeric !== undefined ? { numeric } : {}),
        ...(boolean !== undefined ? { boolean } : {}),
        ...(text !== undefined ? { text } : {}),
        source,
        ...(checkedAt ? { checkedAt } : {}),
      };
    }
  }
  return undefined;
}
