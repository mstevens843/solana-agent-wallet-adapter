import { describe, expect, it } from 'vitest';

import {
  type AgentEvidenceFact,
  type AgentEvidenceGateResult,
  type AgentEvidenceRequirement,
  type AgentPlanReviewResult,
  evaluateAgentEvidenceGate,
  normalizeAgentEvidenceFact,
  validateAgentReviewDecision,
} from '../index.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';

function requirement(partial: Partial<AgentEvidenceRequirement>): AgentEvidenceRequirement {
  return {
    id: partial.id ?? `req.${partial.routeId ?? 'route'}`,
    routeId: partial.routeId ?? 'route',
    need: partial.need ?? 'protocol_position',
    provider: partial.provider ?? 'protocol_connector',
    endpoint: partial.endpoint ?? 'endpoint',
    status: partial.status ?? 'required',
    ttlMs: partial.ttlMs ?? 60_000,
    blocking: partial.blocking ?? true,
    reason: partial.reason ?? 'required for review',
  };
}

function fact(partial: { id: string; label: string; routeId?: string; tone?: AgentEvidenceFact['tone']; severity?: AgentEvidenceFact['severity'] }): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id: partial.id,
    label: partial.label,
    value: 'ok',
    tone: partial.tone ?? 'good',
    source: 'deterministic',
    severity: partial.severity,
    routeId: partial.routeId,
    checkedAt: new Date().toISOString(),
    ttlMs: 60_000,
  });
}

function aiResult(partial: Partial<AgentPlanReviewResult> & { decision: AgentPlanReviewResult['decision'] }): AgentPlanReviewResult {
  return {
    decision: partial.decision,
    reason: partial.reason ?? 'AI reason',
    summary: partial.summary ?? 'AI summary',
    evidence: partial.evidence ?? {},
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
    source: 'ai',
    questions: partial.questions,
  };
}

function passingGate(reqs: AgentEvidenceRequirement[], facts: AgentEvidenceFact[]): AgentEvidenceGateResult {
  return evaluateAgentEvidenceGate(reqs, facts, { walletAddress: WALLET, isWalletScoped: true });
}

describe('validateAgentReviewDecision — golden scenarios', () => {
  it('19. AI hallucinated source: cited evidence id does not exist → needs_input', () => {
    const reqs = [requirement({ routeId: 'helius.getTransfersByAddress', need: 'wallet_transfers', provider: 'helius' })];
    const facts = [fact({ id: 'fact.helius.transfer.0', routeId: 'helius.getTransfersByAddress', label: 'Transfer' })];
    const gate = passingGate(reqs, facts);
    const ai = aiResult({
      decision: 'approve',
      evidence: {
        decisionContract: {
          decision: 'approve',
          reason: 'looks fine',
          summary: 'fine',
          evidenceFactIds: ['fact.helius.transfer.NONEXISTENT'],
        },
      },
    });
    const { final, violations } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('needs_input');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('20. AI approve despite gate block → final decision is deny', () => {
    const reqs = [requirement({ routeId: 'birdeye.token_security', need: 'token_security', provider: 'birdeye' })];
    const facts = [fact({ id: 'fact.birdeye.security', routeId: 'birdeye.token_security', label: 'Mint authority active', tone: 'fail', severity: 'block' })];
    const gate = passingGate(reqs, facts);
    expect(gate.decision).toBe('block');
    const ai = aiResult({
      decision: 'approve',
      evidence: {
        decisionContract: {
          decision: 'approve',
          reason: 'looks fine',
          summary: 'fine',
          evidenceFactIds: ['fact.birdeye.security'],
        },
      },
    });
    const { final, violations } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('deny');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('AI approve with missing required evidence id → needs_input', () => {
    const reqs = [requirement({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const gate = passingGate(reqs, []);
    expect(gate.decision).toBe('block'); // missing fact for required
    const ai = aiResult({
      decision: 'approve',
      evidence: {
        decisionContract: { decision: 'approve', reason: 'r', summary: 's', evidenceFactIds: [] },
      },
    });
    const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts: [], requirements: reqs });
    expect(final.decision).not.toBe('approve');
  });

  it('AI deny with blocking evidence is preserved as deny', () => {
    const reqs = [requirement({ routeId: 'birdeye.token_security', need: 'token_security', provider: 'birdeye' })];
    const facts = [fact({ id: 'fact.security.fail', routeId: 'birdeye.token_security', label: 'Mint authority', tone: 'fail', severity: 'block' })];
    const gate = passingGate(reqs, facts);
    const ai = aiResult({
      decision: 'deny',
      reason: 'token is unsafe',
      evidence: {
        decisionContract: {
          decision: 'deny',
          reason: 'token is unsafe',
          summary: 'unsafe',
          evidenceFactIds: ['fact.security.fail'],
          blockingFactIds: ['fact.security.fail'],
        },
      },
    });
    const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('deny');
  });

  it('AI needs_input preserved when evidence is incomplete', () => {
    const reqs = [requirement({ routeId: 'helius.getTransfersByAddress', need: 'wallet_transfers', provider: 'helius' })];
    const gate = passingGate(reqs, []);
    const ai = aiResult({
      decision: 'needs_input',
      reason: 'need recipient list',
      evidence: {
        decisionContract: { decision: 'needs_input', reason: 'r', summary: 's', evidenceFactIds: [] },
      },
      questions: [{ id: 'recipient', prompt: 'Recipient?', inputKind: 'text', required: true }],
    });
    const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts: [], requirements: reqs });
    expect(final.decision).toBe('needs_input');
  });

  it('approve is allowed when gate passes and AI cites real fact ids', () => {
    const reqs = [requirement({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.jupiter.quote', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = passingGate(reqs, facts);
    expect(gate.decision).toBe('pass');
    const ai = aiResult({
      decision: 'approve',
      evidence: {
        decisionContract: { decision: 'approve', reason: 'r', summary: 's', evidenceFactIds: ['fact.jupiter.quote'] },
      },
    });
    const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('approve');
  });

  it('strips unknown ids but preserves approve when at least one known id is cited', () => {
    const reqs = [requirement({ routeId: 'jupiter.swap_order_preview', need: 'swap_quote', provider: 'jupiter' })];
    const facts = [fact({ id: 'fact.jupiter.quote', routeId: 'jupiter.swap_order_preview', label: 'Quote' })];
    const gate = passingGate(reqs, facts);
    const ai = aiResult({
      decision: 'approve',
      evidence: {
        decisionContract: {
          decision: 'approve',
          reason: 'r',
          summary: 's',
          evidenceFactIds: ['fact.jupiter.quote', 'fact.unknown.X'],
        },
      },
    });
    const { final, decisionContract, violations } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('approve');
    expect(decisionContract.evidenceFactIds).toEqual(['fact.jupiter.quote']);
    expect(violations.join(' ')).toContain('stripped');
  });
});
