/**
 * Threshold reconciler tests — especially the subject-aware candidate selection
 * that fixes the Gemini-bug (where the model dumps both the user-asked price AND
 * the SOL/swap price into prose and the reconciler picks the wrong one).
 */

import { describe, expect, it } from 'vitest';

import type { AgentPlanReviewResult } from '../agentPlans.js';
import {
  extractInstructionSubjectHints,
  extractThresholdRule,
  reconcileThresholdReviewDecision,
  selectThresholdPriceCandidate,
} from '../thresholdReview.js';

function baseResult(overrides: Partial<AgentPlanReviewResult> = {}): AgentPlanReviewResult {
  return {
    decision: 'approve',
    reason: '',
    summary: '',
    evidence: { findings: [] },
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...overrides,
  } as AgentPlanReviewResult;
}

describe('extractInstructionSubjectHints', () => {
  it('returns subject tokens from the user instruction', () => {
    const tokens = extractInstructionSubjectHints('check helium mobile. lowest monthly plan. if less than $20. approve.');
    expect(tokens).toContain('helium');
    expect(tokens).toContain('mobile');
    expect(tokens).not.toContain('approve');
    expect(tokens).not.toContain('plan'); // 'plan' is a stop word (generic threshold noun)
    expect(tokens).not.toContain('monthly');
    expect(tokens).not.toContain('lowest');
    expect(tokens).not.toContain('under');
  });

  it('returns empty for instruction without subject tokens', () => {
    expect(extractInstructionSubjectHints('approve if value is less than $20.')).toEqual([]);
    expect(extractInstructionSubjectHints('')).toEqual([]);
    expect(extractInstructionSubjectHints(undefined)).toEqual([]);
  });

  it('captures multi-word subjects', () => {
    const tokens = extractInstructionSubjectHints('approve only if T-Mobile Essentials plan is under $50.');
    expect(tokens).toEqual(expect.arrayContaining(['mobile', 'essentials']));
  });
});

describe('selectThresholdPriceCandidate — subject-aware (Gemini bug fix)', () => {
  it('prefers Helium-mentioning candidate over SOL-price candidate', () => {
    // Simulates Gemini's response: includes both the Helium plan price AND the SOL price.
    const result = baseResult({
      reason: 'SOL is currently priced at $86.18. Helium Mobile cheapest plan costs $15/month.',
      evidence: { findings: [
        { label: 'SOL price', value: '$86.18', tone: 'neutral' },
        { label: 'Helium Mobile plan', value: '$15/month', tone: 'neutral' },
      ] },
    });
    const rule = extractThresholdRule('check helium mobile. lowest monthly plan. if less than $20. approve.');
    expect(rule).toMatchObject({ threshold: 20, approveWhen: 'below' });
    const candidate = selectThresholdPriceCandidate(result, rule!, {
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
    });
    expect(candidate?.amount).toBe(15);
  });

  it('returns undefined when no candidate matches the subject and only crypto-price candidates exist', () => {
    // Simulates a worse Gemini response: only SOL price in the evidence, no Helium fact.
    const result = baseResult({
      reason: 'SOL price is $86.18.',
      evidence: { findings: [{ label: 'SOL price', value: '$86.18', tone: 'neutral' }] },
    });
    const rule = extractThresholdRule('check helium mobile lowest monthly plan if less than $20 approve.');
    const candidate = selectThresholdPriceCandidate(result, rule!, {
      instruction: 'check helium mobile lowest monthly plan if less than $20 approve.',
    });
    // Subject "helium/mobile" is crypto-free, all candidates are crypto-asset prose →
    // return undefined so the reconciler downgrades to needs_input instead of guessing.
    expect(candidate).toBeUndefined();
  });

  it('still works when the instruction has no specific subject (legacy heuristic path)', () => {
    const result = baseResult({
      reason: 'Current price is $15/month.',
      evidence: { findings: [{ label: 'Current price', value: '$15', tone: 'neutral' }] },
    });
    const rule = extractThresholdRule('approve if under $20.');
    const candidate = selectThresholdPriceCandidate(result, rule!, { instruction: 'approve if under $20.' });
    expect(candidate?.amount).toBe(15);
  });
});

describe('reconcileThresholdReviewDecision — end-to-end Gemini fix', () => {
  const INSTRUCTION = 'check helium mobile. lowest monthly plan. if less than $20. approve.';

  it('reaches approve when Helium $15 is named even with SOL $86.18 also in evidence', () => {
    const result = baseResult({
      decision: 'deny',                                            // Gemini's wrong call
      reason: '$86.18 is over $20, so the user threshold rule denies this draft.',
      summary: 'Threshold rule checked: $86.18 is over $20.',
      evidence: { findings: [
        { label: 'SOL price', value: '$86.18', tone: 'neutral' },
        { label: 'Helium Mobile plan', value: '$15/month', tone: 'neutral' },
      ] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    expect(out.reason).toMatch(/\$15/);
    expect(out.reason).not.toMatch(/\$86/);
  });

  it('escalates to needs_input when ONLY a SOL price is available and the subject is Helium', () => {
    const result = baseResult({
      decision: 'deny',
      reason: 'SOL price is $86.18.',
      summary: 'Could not find Helium price.',
      evidence: { findings: [{ label: 'SOL price', value: '$86.18', tone: 'neutral' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('needs_input');
    expect(out.summary).toMatch(/Threshold rule needs a numeric value/);
  });

  it('surfaces the source sentence as a separate `Source` finding, not inline in the reason', () => {
    const result = baseResult({
      decision: 'deny',
      reason: 'Helium plan is $15/month.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    // Reason is now natural and DOES NOT carry the `(from "...")` inline citation.
    expect(out.reason).not.toContain('from "');
    expect(out.reason).not.toContain('(from');
    // Source is preserved on a dedicated finding so the audit trail stays traceable.
    const findings = (out.evidence as Record<string, unknown>).findings as Array<Record<string, unknown>>;
    const sourceFinding = findings.find((f) => f.label === 'Source');
    expect(sourceFinding).toBeDefined();
    expect(String(sourceFinding!.value)).toMatch(/\$15/);
  });

  it('extracts the current value from a facts object returned by the Device Agent', () => {
    const result = baseResult({
      decision: 'needs_input',
      reason: 'Threshold rule needs a numeric value.',
      summary: 'Needs input.',
      evidence: {
        facts: {
          heliumMobileLowestPlan: {
            label: 'Helium Mobile lowest plan',
            value: '$15',
          },
        },
      },
    });

    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });

    expect(out.decision).toBe('approve');
    expect(out.reason).toContain('$15');
  });

  it('extracts the current value from non-finding display evidence rows', () => {
    const result = baseResult({
      decision: 'deny',
      reason: 'See evidence.',
      summary: 'Model summary.',
      evidence: {
        evidenceRows: [
          { label: 'Helium Mobile lowest plan', value: '$15/month', tone: 'good' },
        ],
      },
    });

    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });

    expect(out.decision).toBe('approve');
    expect(out.reason).toContain('$15');
  });

  // Phase 4 — gate-stomp bypass flag. When the reconciler promotes deny → approve
  // because the user's threshold rule is satisfied by the resolved value, the result
  // must carry `evidence.thresholdRulePromoted = true` so that the server-side safety
  // gate (aiPlanner.applyServerSideReviewSafety) does not silently downgrade it.
  it('sets evidence.thresholdRulePromoted=true when promoting deny → approve via user rule', () => {
    const result = baseResult({
      decision: 'deny',
      reason: 'Model wrongly denied.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBe(true);
  });

  it('sets evidence.thresholdRulePromoted=true when promoting needs_input → approve via user rule', () => {
    const result = baseResult({
      decision: 'needs_input',
      reason: 'Awaiting value.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBe(true);
  });

  it('does NOT set evidence.thresholdRulePromoted when no promotion happens (decision already matches)', () => {
    const result = baseResult({
      decision: 'approve',
      reason: 'Already correct.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    // No promotion needed — flag must not be set, otherwise the safety bypass would
    // incorrectly fire on cases where the AI got the answer right without help.
    expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBeUndefined();
  });

  it('does NOT set evidence.thresholdRulePromoted when reconciler promotes deny → deny (value over threshold)', () => {
    const result = baseResult({
      decision: 'approve',
      reason: 'Model wrongly approved.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$25/month', tone: 'fail' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('deny');
    // Reconciler corrected approve → deny here. Flag is only for deny/needs_input →
    // approve direction; downgrades to deny must NOT carry the bypass flag.
    expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBeUndefined();
  });

  // Phase 7 — multi-rule prompts. The single-threshold reconciler was over-reaching
  // on mixed-policy prompts (SOL > $80 + Fear & Greed > 20 + Helium plan < $20),
  // arbitrarily picking the first $ value ($80) and the first matching direction-
  // keyword ('less than'), then matching SOL's price ($85.06) against that wrong
  // rule and denying. For multi-threshold instructions the model's own decision +
  // policyBundle.evaluations are authoritative; the reconciler must defer.
  describe('multi-rule prompts — reconciler defers to the model', () => {
    const MIXED_POLICY = 'Run my pre-signing policy for this swap. Market gates: BTC Fear & Greed must be above 20. SOL must be above $80. Return APPROVE or DENY. And only approve if helium phone plan is less than $20.';
    const TWO_DOLLAR_THRESHOLDS = 'Approve if SOL is above $80 and total cost is under $20.';
    const SINGLE_RULE_HELIUM = 'check helium mobile. lowest monthly plan. if less than $20. approve.';
    const SINGLE_RULE_SOL = 'Approve only if SOL is above $80.';

    it('leaves the model decision intact on mixed API+web policy (the SOL/Helium failure case)', () => {
      // Model correctly approved (SOL $84.98 > $80, Helium $15 < $20). The reconciler
      // previously mis-extracted ($80 threshold, "less than" direction) and matched
      // SOL's $85.06 → wrongly denied. With the multi-threshold guard, reconciler
      // returns the result unchanged so the model's approve stands.
      const result = baseResult({
        decision: 'approve',
        reason: 'All gates satisfied: SOL $84.98 > $80, F&G 28 > 20, Helium $15 < $20.',
        summary: 'All gates satisfied.',
        evidence: { findings: [
          { label: 'SOL price', value: '$84.98', tone: 'good' },
          { label: 'Fear & Greed', value: '28', tone: 'good' },
          { label: 'Helium plan', value: '$15/month', tone: 'good' },
        ] },
      });
      const out = reconcileThresholdReviewDecision(result, { instruction: MIXED_POLICY });
      expect(out.decision).toBe('approve');
      expect(out.reason).toBe('All gates satisfied: SOL $84.98 > $80, F&G 28 > 20, Helium $15 < $20.');
      expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBeUndefined();
    });

    it('leaves the model decision intact on two-dollar-threshold prompts (both $ rules)', () => {
      const result = baseResult({
        decision: 'deny',
        reason: 'SOL is above $80 ($85) but total cost is also $25 (over $20).',
        summary: 'Mixed gates: one fails.',
        evidence: { findings: [
          { label: 'SOL price', value: '$85.00', tone: 'good' },
          { label: 'Total cost', value: '$25.00', tone: 'fail' },
        ] },
      });
      const out = reconcileThresholdReviewDecision(result, { instruction: TWO_DOLLAR_THRESHOLDS });
      expect(out.decision).toBe('deny');
      expect(out.reason).toContain('$25');
    });

    it('STILL reconciles single-rule web-search prompts (regression guard for Helium fix)', () => {
      // Single-threshold prompts must continue to reconcile — that's the whole point
      // of the threshold reconciler. Don't accidentally regress the Helium-style fix.
      const result = baseResult({
        decision: 'deny',
        reason: 'Model wrongly denied.',
        summary: '',
        evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
      });
      const out = reconcileThresholdReviewDecision(result, { instruction: SINGLE_RULE_HELIUM });
      expect(out.decision).toBe('approve');
      expect((out.evidence as Record<string, unknown>).thresholdRulePromoted).toBe(true);
    });

    it('STILL reconciles single-rule SOL prompts (above-$ threshold)', () => {
      const result = baseResult({
        decision: 'deny',
        reason: 'Model wrongly denied.',
        summary: '',
        evidence: { findings: [{ label: 'SOL price', value: '$85.00', tone: 'good' }] },
      });
      const out = reconcileThresholdReviewDecision(result, { instruction: SINGLE_RULE_SOL });
      expect(out.decision).toBe('approve');
    });
  });
});
