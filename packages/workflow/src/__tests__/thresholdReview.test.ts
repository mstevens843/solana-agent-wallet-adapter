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

  it('includes the source sentence in the corrected reason (richer than the boilerplate)', () => {
    const result = baseResult({
      decision: 'deny',
      reason: 'Helium plan is $15/month.',
      summary: '',
      evidence: { findings: [{ label: 'Helium plan', value: '$15/month', tone: 'good' }] },
    });
    const out = reconcileThresholdReviewDecision(result, { instruction: INSTRUCTION });
    expect(out.decision).toBe('approve');
    expect(out.reason).toContain('from "');
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
});
