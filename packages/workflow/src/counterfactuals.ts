import {
  type AgentEvidenceContext,
  type AgentEvidenceFact,
  type AgentEvidenceGateResult,
  type AgentEvidenceRequirement,
  freshnessFor,
} from './agentEvidence.js';
import { evaluateAgentEvidenceGate } from './agentEvidenceGate.js';

export type CounterfactualChange =
  | 'fact_becomes_stale'
  | 'fact_becomes_blocking'
  | 'fact_becomes_fresh'
  | 'fact_becomes_clean'
  | 'fact_becomes_present'
  | 'fact_becomes_missing'
  | 'wallet_disconnect';

export interface Counterfactual {
  id: string;
  factId?: string;
  requirementId?: string;
  change: CounterfactualChange;
  rationale: string;
  decisionBefore: 'approve' | 'deny' | 'needs_input';
  decisionAfter: 'approve' | 'deny' | 'needs_input';
}

const MAX_COUNTERFACTUALS = 5;

/**
 * Generate up to MAX_COUNTERFACTUALS "what if" explanations for the agent's decision.
 *
 * For each load-bearing fact / requirement, simulate the opposite state and re-run the
 * gate. If the gate's verdict changes, that's a counterfactual worth surfacing — it tells
 * the user exactly which evidence is load-bearing.
 *
 * Three classes of mutations are considered:
 *   - Flipping a present fact's severity (warn ↔ block) or freshness (fresh ↔ stale).
 *   - Removing a present fact (simulates the API failing or returning empty).
 *   - For deny decisions: synthesizing a "fresh + good" fact for each missing required req.
 *
 * Returns only the counterfactuals that actually flipped the decision, ranked by closeness
 * to the boundary (i.e., mutations that flipped to/from approve come first).
 */
export function computeCounterfactuals(args: {
  decision: 'approve' | 'deny' | 'needs_input';
  gate: AgentEvidenceGateResult;
  facts: AgentEvidenceFact[];
  requirements: AgentEvidenceRequirement[];
  context: AgentEvidenceContext;
}): Counterfactual[] {
  const found: Counterfactual[] = [];
  const before = args.decision;

  const tryAlt = (
    id: string,
    factId: string | undefined,
    requirementId: string | undefined,
    change: CounterfactualChange,
    rationale: string,
    mutatedFacts: AgentEvidenceFact[],
    contextOverride?: Partial<AgentEvidenceContext>,
  ): void => {
    if (found.length >= MAX_COUNTERFACTUALS) return;
    const altGate = evaluateAgentEvidenceGate(args.requirements, mutatedFacts, {
      ...args.context,
      ...(contextOverride ?? {}),
    });
    const altDecision = decisionFromGate(altGate, before);
    if (altDecision === before) return;
    found.push({
      id,
      ...(factId ? { factId } : {}),
      ...(requirementId ? { requirementId } : {}),
      change,
      rationale,
      decisionBefore: before,
      decisionAfter: altDecision,
    });
  };

  // 1. For each present fact, try removing or flipping it.
  for (const fact of args.facts) {
    if (fact.severity === 'block') {
      const cleaned = args.facts.map((f) => f.id === fact.id ? { ...f, severity: 'info' as const, tone: 'good' as const, freshness: 'fresh' as const } : f);
      tryAlt(
        `cf.${fact.id}.unblock`,
        fact.id,
        fact.requirementId,
        'fact_becomes_clean',
        `If "${fact.label}" were not blocking, decision would change.`,
        cleaned,
      );
    } else if (fact.severity === 'info' || fact.tone === 'good') {
      const blocked = args.facts.map((f) => f.id === fact.id ? { ...f, severity: 'block' as const, tone: 'fail' as const } : f);
      tryAlt(
        `cf.${fact.id}.block`,
        fact.id,
        fact.requirementId,
        'fact_becomes_blocking',
        `If "${fact.label}" had failed, decision would change.`,
        blocked,
      );
    }

    if (fact.freshness === 'fresh') {
      const staled = args.facts.map((f) => f.id === fact.id ? { ...f, freshness: 'stale' as const } : f);
      tryAlt(
        `cf.${fact.id}.stale`,
        fact.id,
        fact.requirementId,
        'fact_becomes_stale',
        `If "${fact.label}" were stale, decision would change.`,
        staled,
      );
    } else if (fact.freshness === 'stale') {
      const refreshed = args.facts.map((f) => f.id === fact.id ? { ...f, freshness: 'fresh' as const } : f);
      tryAlt(
        `cf.${fact.id}.fresh`,
        fact.id,
        fact.requirementId,
        'fact_becomes_fresh',
        `If "${fact.label}" were fresh, decision would change.`,
        refreshed,
      );
    }
  }

  // 2. For each required-but-missing req (deny/needs_input paths), simulate a present fresh fact.
  for (const req of args.gate.missingRequired) {
    if (found.length >= MAX_COUNTERFACTUALS) break;
    const synthetic: AgentEvidenceFact = {
      id: `synthetic.${req.routeId}`,
      requirementId: req.id,
      routeId: req.routeId,
      label: `${req.routeId} (synthetic)`,
      value: 'synthetic-pass',
      tone: 'good',
      source: 'deterministic',
      checkedAt: args.context.nowIso ?? new Date().toISOString(),
      freshness: 'fresh',
      severity: 'info',
    };
    tryAlt(
      `cf.${req.routeId}.synthetic_present`,
      undefined,
      req.id,
      'fact_becomes_present',
      `If ${req.routeId} were present and fresh, decision would change.`,
      [...args.facts, synthetic],
    );
  }

  // 3. Wallet disconnect counterfactual (for approve outcomes that depend on wallet identity).
  if (before === 'approve' && args.context.walletAddress && found.length < MAX_COUNTERFACTUALS) {
    tryAlt(
      'cf.wallet.disconnect',
      undefined,
      undefined,
      'wallet_disconnect',
      'If no wallet were connected, the approval would not be possible.',
      args.facts.filter((f) => f.routeId !== 'wallet.connected_public_key'),
      { walletAddress: undefined },
    );
  }

  // Rank: flips touching approve come first, then those touching deny, then needs_input.
  return found
    .sort((a, b) => rankFlip(a) - rankFlip(b))
    .slice(0, MAX_COUNTERFACTUALS);
}

function rankFlip(cf: Counterfactual): number {
  const touchesApprove = cf.decisionBefore === 'approve' || cf.decisionAfter === 'approve';
  const touchesDeny = cf.decisionBefore === 'deny' || cf.decisionAfter === 'deny';
  if (touchesApprove) return 0;
  if (touchesDeny) return 1;
  return 2;
}

/**
 * Map a gate result to the corresponding final-decision band. Mirrors the validator's
 * top-level logic so counterfactuals reflect the same flip the validator would produce.
 */
function decisionFromGate(gate: AgentEvidenceGateResult, originalDecision: 'approve' | 'deny' | 'needs_input'): 'approve' | 'deny' | 'needs_input' {
  if (gate.decision === 'block') return 'deny';
  if (gate.decision === 'needs_input') return 'needs_input';
  // gate passes: original AI decision usually stands. We use the prior decision as the
  // "best estimate" since we cannot re-run the AI; if the prior was an override (deny on
  // a gate-pass) we keep it.
  return originalDecision === 'approve' || originalDecision === 'needs_input' ? originalDecision : 'approve';
}

// Re-exported for tests to keep the module self-contained.
export { freshnessFor };
