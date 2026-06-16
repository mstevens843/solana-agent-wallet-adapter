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

function fact(partial: {
  id: string;
  label: string;
  routeId?: string;
  tone?: AgentEvidenceFact['tone'];
  severity?: AgentEvidenceFact['severity'];
  checkedAt?: string;
  ttlMs?: number;
}): AgentEvidenceFact {
  return normalizeAgentEvidenceFact({
    id: partial.id,
    label: partial.label,
    value: 'ok',
    tone: partial.tone ?? 'good',
    source: 'deterministic',
    severity: partial.severity,
    routeId: partial.routeId,
    checkedAt: partial.checkedAt ?? new Date().toISOString(),
    ttlMs: partial.ttlMs ?? 60_000,
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

  it('approve is allowed when gate passes and AI drove decision from external research (no internal ids)', () => {
    // External-fact threshold approval like "approve this T-Mobile plan if it's under $20".
    // The gate has only wallet identity (no Helius, no BirdEye — router was correctly silent).
    // The AI did web research and approved. Validator must respect the gate's pass.
    const reqs = [requirement({ routeId: 'wallet.connected_public_key', need: 'wallet_identity', provider: 'wallet', ttlMs: Number.POSITIVE_INFINITY })];
    const facts = [fact({ id: 'fact.wallet.connected_public_key', routeId: 'wallet.connected_public_key', label: 'Wallet', tone: 'good' })];
    const gate = passingGate(reqs, facts);
    expect(gate.decision).toBe('pass');
    const ai = aiResult({
      decision: 'approve',
      reason: 'T-Mobile Essentials is $15/month, which is under your $20 threshold.',
      evidence: {
        research: { status: 'checked', required: true },
        sources: [{ title: 'T-Mobile Essentials', url: 'https://www.t-mobile.com/cell-phone-plans/essentials' }],
        findings: [
          { label: 'Plan rate', value: '$15.00/month', tone: 'good' },
          { label: 'Threshold check', value: '$15 < $20', tone: 'good' },
        ],
        // AI cites no internal evidenceFactIds — its citation is the research sources above.
        decisionContract: {
          decision: 'approve',
          reason: 'Research-backed',
          summary: 'ok',
          evidenceFactIds: [],
          blockingFactIds: [],
          missingFactIds: [],
        },
      },
    });
    const { final, violations } = validateAgentReviewDecision({ aiResult: ai, gate, facts, requirements: reqs });
    expect(final.decision).toBe('approve');
    expect(violations).toEqual([]);
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

  describe('deferred external research', () => {
    const researchReq = requirement({
      id: 'req.external_research.helium',
      routeId: 'external_research.current_web',
      need: 'external_research',
      provider: 'external_research',
      blocking: true,
      reason: 'The question references a current external price.',
    });
    const deferredContext = { walletAddress: WALLET, isWalletScoped: true, externalResearchAvailable: true } as const;

    it('approve stands when the gate deferred research AND the AI returned research citations', () => {
      const gate = evaluateAgentEvidenceGate([researchReq], [], deferredContext);
      expect(gate.decision).toBe('pass');
      const ai = aiResult({
        decision: 'approve',
        evidence: {
          research: { status: 'checked' },
          sources: [{ title: 'Helium plans', url: 'https://www.heliummobile.com/plans' }],
        },
      });
      const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts: [], requirements: [researchReq], context: deferredContext });
      expect(final.decision).toBe('approve');
    });

    it('approve downgrades to needs_input when research was deferred but the AI returned NONE', () => {
      const gate = evaluateAgentEvidenceGate([researchReq], [], deferredContext);
      const ai = aiResult({ decision: 'approve', evidence: {} });
      const { final, violations } = validateAgentReviewDecision({ aiResult: ai, gate, facts: [], requirements: [researchReq], context: deferredContext });
      expect(final.decision).toBe('needs_input');
      expect(violations.join(' ')).toContain('without returning research');
    });

    it('approve stands when a deterministic fact already satisfied the research route (no AI citation needed)', () => {
      const researchFact = fact({ id: 'fact.policy.helium_price', routeId: 'external_research.current_web', label: 'Plan rate' });
      const gate = evaluateAgentEvidenceGate([researchReq], [researchFact], deferredContext);
      expect(gate.decision).toBe('pass');
      const ai = aiResult({ decision: 'approve', evidence: {} });
      const { final } = validateAgentReviewDecision({ aiResult: ai, gate, facts: [researchFact], requirements: [researchReq], context: deferredContext });
      expect(final.decision).toBe('approve');
    });
  });

  describe('walletless off-chain condition approvals', () => {
    const walletReq = requirement({
      id: 'req.wallet.connected_public_key',
      routeId: 'wallet.connected_public_key',
      need: 'wallet_identity',
      provider: 'wallet',
      ttlMs: Number.POSITIVE_INFINITY,
      reason: 'A connected wallet public key is required before wallet approval.',
    });
    const researchReq = requirement({
      id: 'req.external_research.helium',
      routeId: 'external_research.current_web',
      need: 'external_research',
      provider: 'external_research',
      blocking: true,
      reason: 'The question depends on a current off-chain plan price.',
    });
    const walletlessOffChainContext = {
      isWalletScoped: true,
      offChainGateOnly: true,
      externalResearchAvailable: true,
    } as const;

    it('returns needs_input, not deny, when research proves the off-chain condition but no wallet is connected', () => {
      const gate = evaluateAgentEvidenceGate([walletReq, researchReq], [], walletlessOffChainContext);
      expect(gate.decision).toBe('block');
      const ai = aiResult({
        decision: 'approve',
        reason: 'Helium Mobile lists a $15/month plan, which is under the $20 threshold.',
        evidence: {
          thresholdRulePromoted: true,
          research: { status: 'checked' },
          sources: [{ title: 'Helium Mobile plans', url: 'https://hellohelium.com' }],
          decisionContract: {
            decision: 'approve',
            reason: 'Research-backed threshold pass.',
            summary: 'Helium plan is under the threshold.',
            evidenceFactIds: [],
          },
        },
      });

      const { final, decisionContract, violations } = validateAgentReviewDecision({
        aiResult: ai,
        gate,
        facts: [],
        requirements: [walletReq, researchReq],
        context: walletlessOffChainContext,
      });
      const evidence = final.evidence as Record<string, unknown>;

      expect(final.decision).toBe('needs_input');
      expect(final.summary).toBe('Condition passed; connect a wallet to continue.');
      expect(final.reason).toMatch(/wallet must be connected/i);
      expect(final.reason).not.toMatch(/Gate blocked/i);
      expect(evidence.walletRequired).toBe(true);
      expect(evidence.conditionDecision).toBe('approve');
      expect(decisionContract.decision).toBe('needs_input');
      expect(decisionContract.missingFactIds).toContain('wallet.connected_public_key');
      expect(violations).toContain('Wallet connection required after off-chain condition passed.');
    });

    it('still denies walletless approvals when the condition is not marked as off-chain-only', () => {
      const context = {
        isWalletScoped: true,
        offChainGateOnly: false,
        externalResearchAvailable: true,
      } as const;
      const gate = evaluateAgentEvidenceGate([walletReq, researchReq], [], context);
      const ai = aiResult({
        decision: 'approve',
        evidence: {
          thresholdRulePromoted: true,
          research: { status: 'checked' },
        },
      });

      const { final } = validateAgentReviewDecision({
        aiResult: ai,
        gate,
        facts: [],
        requirements: [walletReq, researchReq],
        context,
      });

      expect(final.decision).toBe('deny');
      expect((final.evidence as Record<string, unknown>).walletRequired).toBeUndefined();
    });

    it('still denies when another deterministic blocker exists alongside the missing wallet', () => {
      const quoteReq = requirement({
        id: 'req.jupiter.quote',
        routeId: 'jupiter.swap_order_preview',
        need: 'swap_quote',
        provider: 'jupiter',
        ttlMs: 1_000,
      });
      const staleQuote = fact({
        id: 'fact.jupiter.quote',
        routeId: 'jupiter.swap_order_preview',
        label: 'Quote',
        checkedAt: new Date(Date.now() - 60_000).toISOString(),
        ttlMs: 1_000,
      });
      const gate = evaluateAgentEvidenceGate([walletReq, quoteReq, researchReq], [staleQuote], walletlessOffChainContext);
      expect(gate.decision).toBe('block');
      expect(gate.staleRequired).toHaveLength(1);
      const ai = aiResult({
        decision: 'approve',
        evidence: {
          thresholdRulePromoted: true,
          research: { status: 'checked' },
        },
      });

      const { final } = validateAgentReviewDecision({
        aiResult: ai,
        gate,
        facts: [staleQuote],
        requirements: [walletReq, quoteReq, researchReq],
        context: walletlessOffChainContext,
      });

      expect(final.decision).toBe('deny');
      expect((final.evidence as Record<string, unknown>).walletRequired).toBeUndefined();
    });
  });
});
