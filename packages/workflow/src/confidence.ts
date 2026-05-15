import type { AgentEvidenceFact, AgentEvidenceGateResult, AgentEvidenceRequirement } from './agentEvidence.js';

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface ConfidenceFactor {
  id: string;
  label: string;
  delta: number;
  detail?: string;
}

export interface ConfidenceResult {
  score: number;
  band: ConfidenceBand;
  factors: ConfidenceFactor[];
}

const BASE_SCORE = 1.0;
const MIN_SCORE = 0.0;
const HIGH_THRESHOLD = 0.8;
const MEDIUM_THRESHOLD = 0.5;

/**
 * Deterministic confidence calibrator. The AI's stated confidence is one input, weighted
 * less than the gate's hard signals. The output is both a numeric score (0–1) and a band
 * (high / medium / low), plus the breakdown of each factor that shifted the score.
 *
 * Design principle: the score should be reproducible from the inputs alone. The validator
 * persists score + factors in the audit receipt so anyone replaying the decision can
 * recompute the same value.
 *
 * Score model (additive deltas applied to BASE_SCORE = 1.0, clamped to [0,1]):
 *   - Gate decision !== 'pass': −0.4 (very low confidence — usually a deny/needs_input)
 *   - Each blocking fact: −0.15 (capped at −0.45)
 *   - Each stale required fact: −0.20 (capped at −0.40)
 *   - Each missing required fact: −0.25 (capped at −0.50)
 *   - Each optional warn-severity fact: −0.04 (capped at −0.20)
 *   - AI confidence is 'low': −0.15
 *   - AI confidence is 'medium': −0.04
 *   - AI confidence is 'high' or absent: 0
 *   - Decision is 'approve' and ZERO evidence facts cited: −0.10 (no support)
 *   - Decision is 'approve' and external-research-only (no internal fact ids): +0 (research approvals are fine, scored elsewhere)
 */
export function computeConfidence(args: {
  gate: AgentEvidenceGateResult;
  facts: AgentEvidenceFact[];
  requirements: AgentEvidenceRequirement[];
  aiBand?: ConfidenceBand;
  decision: 'approve' | 'deny' | 'needs_input';
  citedFactIdCount: number;
  externalResearchUsed?: boolean;
}): ConfidenceResult {
  const factors: ConfidenceFactor[] = [];
  let score = BASE_SCORE;

  const apply = (id: string, label: string, delta: number, detail?: string): void => {
    if (delta === 0) return;
    factors.push({ id, label, delta, ...(detail ? { detail } : {}) });
    score = clamp01(score + delta);
  };

  if (args.gate.decision === 'block') {
    apply('gate.blocked', 'Gate blocked the approval', -0.4);
  } else if (args.gate.decision === 'needs_input') {
    apply('gate.needs_input', 'Gate flagged missing input', -0.25);
  }

  if (args.gate.blockingFacts.length) {
    const delta = -Math.min(0.45, args.gate.blockingFacts.length * 0.15);
    apply('facts.blocking', `${args.gate.blockingFacts.length} blocking fact(s)`, delta);
  }

  if (args.gate.staleRequired.length) {
    const delta = -Math.min(0.4, args.gate.staleRequired.length * 0.2);
    apply('facts.stale', `${args.gate.staleRequired.length} required fact(s) stale`, delta);
  }

  if (args.gate.missingRequired.length) {
    const delta = -Math.min(0.5, args.gate.missingRequired.length * 0.25);
    apply('facts.missing', `${args.gate.missingRequired.length} required fact(s) missing`, delta);
  }

  if (args.gate.warnings.length) {
    const delta = -Math.min(0.2, args.gate.warnings.length * 0.04);
    apply('facts.warn', `${args.gate.warnings.length} warning(s) in evidence`, delta);
  }

  if (args.aiBand === 'low') {
    apply('ai.confidence.low', 'AI self-reported low confidence', -0.15);
  } else if (args.aiBand === 'medium') {
    apply('ai.confidence.medium', 'AI self-reported medium confidence', -0.04);
  }

  if (args.decision === 'approve' && args.citedFactIdCount === 0 && !args.externalResearchUsed) {
    apply('approval.unsupported', 'Approval without cited fact ids', -0.1);
  }

  const band = bandForScore(score);
  return { score: round(score), band, factors };
}

export function bandForScore(score: number): ConfidenceBand {
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return MIN_SCORE;
  return Math.max(MIN_SCORE, Math.min(BASE_SCORE, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
