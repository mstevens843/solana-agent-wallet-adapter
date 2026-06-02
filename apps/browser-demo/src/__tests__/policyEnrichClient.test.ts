// Tests for the BYOK device-agent policy-bundle helpers. Covers:
//   - spliceBundle merges into existing context without clobbering siblings
//   - enforceBlockingFailure overrides approve → deny when bundle has failures
//   - enforceBlockingFailure passes through deny/needs_input unchanged
//   - mergePolicyBundleEvaluations mirrors authoritative policy findings
//   - empty bundle is a no-op
import { describe, expect, it } from 'vitest';
import {
  applyPolicyBundleReviewSafety,
  enforceBlockingFailure,
  mergePolicyBundleEvaluations,
  policyBundleNeedsResearch,
  policyBundleResearchTargets,
  spliceBundle,
  type PolicyBundle,
} from '../policyEnrichClient.js';

const baseBundle: PolicyBundle = {
  atoms: [
    { id: 'atom.price.sol.gte.80', type: 'price', rawText: 'SOL must be above $80' },
    { id: 'atom.external_price.helium.lt.20', type: 'external_price', rawText: 'helium plan less than $20' },
  ],
  evaluations: [
    {
      atomId: 'atom.price.sol.gte.80',
      pass: true,
      finding: { label: 'SOL price', value: '$146.50 — jupiter', tone: 'good' },
    },
    {
      atomId: 'atom.external_price.helium.lt.20',
      pass: false,
      finding: { label: 'Helium plan', value: '$25 — web', tone: 'fail' },
    },
  ],
  hasBlockingFailure: true,
  finishedAt: '2026-05-21T00:00:00.000Z',
};

describe('spliceBundle', () => {
  it('returns payload unchanged when bundle is null', () => {
    const payload = { instruction: 'review this', context: { foo: 'bar' } };
    expect(spliceBundle(payload, null)).toBe(payload);
  });

  it('returns payload unchanged when bundle has no atoms', () => {
    const empty: PolicyBundle = { ...baseBundle, atoms: [], evaluations: [], hasBlockingFailure: false };
    const payload = { instruction: 'foo' };
    expect(spliceBundle(payload, empty)).toBe(payload);
  });

  it('creates context when missing', () => {
    const out = spliceBundle({ instruction: 'do x' }, baseBundle) as Record<string, unknown>;
    expect(out.instruction).toBe('do x');
    expect((out.context as Record<string, unknown>).policyBundle).toEqual(baseBundle);
  });

  it('preserves existing context fields', () => {
    const out = spliceBundle(
      { instruction: 'do x', context: { researchEvidence: { foo: 1 } } },
      baseBundle,
    ) as Record<string, unknown>;
    const ctx = out.context as Record<string, unknown>;
    expect((ctx.researchEvidence as Record<string, unknown>).foo).toBe(1);
    expect(ctx.policyBundle).toEqual(baseBundle);
  });

  it('adds targeted research metadata for unresolved web-only atoms', () => {
    const unresolved: PolicyBundle = {
      ...baseBundle,
      atoms: [
        { id: 'atom.external_state.solana.outage', type: 'external_state', rawText: 'no Solana outage' },
        { id: 'atom.price.sol.gte.80', type: 'price', rawText: 'SOL above $80' },
      ],
      evaluations: [
        {
          atomId: 'atom.external_state.solana.outage',
          unresolved: true,
          finding: { label: 'Solana outage', value: 'unknown', tone: 'warn' },
        },
        {
          atomId: 'atom.price.sol.gte.80',
          unresolved: true,
          finding: { label: 'SOL price', value: 'unknown', tone: 'warn' },
        },
      ],
      hasBlockingFailure: false,
    };
    const out = spliceBundle(
      { instruction: 'do x', research: { currentDate: '2026-05-21T00:00:00.000Z', maxSearches: 5 } },
      unresolved,
    ) as Record<string, unknown>;
    const ctx = out.context as Record<string, unknown>;
    expect(out.research).toMatchObject({
      needed: true,
      mode: 'resolve_specific_atoms',
      currentDate: '2026-05-21T00:00:00.000Z',
      maxSearches: 5,
    });
    expect(ctx.researchTargets).toEqual([
      {
        atomId: 'atom.external_state.solana.outage',
        type: 'external_state',
        rawText: 'no Solana outage',
      },
    ]);
    expect(policyBundleNeedsResearch(unresolved)).toBe(true);
    expect(policyBundleResearchTargets(unresolved)).toHaveLength(1);
  });
});

describe('enforceBlockingFailure', () => {
  it('overrides approve → deny when bundle has blocking failure', () => {
    const llm = { decision: 'approve', reason: 'looks good to me' };
    const out = enforceBlockingFailure(llm, baseBundle);
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('Helium plan');
    expect(out.blockingFactIds).toEqual(['atom.external_price.helium.lt.20']);
  });

  it('passes through when LLM already denied', () => {
    const llm = { decision: 'deny', reason: 'looks bad' };
    expect(enforceBlockingFailure(llm, baseBundle).decision).toBe('deny');
  });

  it('passes through needs_input unchanged', () => {
    const llm = { decision: 'needs_input', reason: 'need amount' };
    expect(enforceBlockingFailure(llm, baseBundle).decision).toBe('needs_input');
  });

  it('passes through approve when bundle has no failure', () => {
    const safe: PolicyBundle = { ...baseBundle, hasBlockingFailure: false };
    const llm = { decision: 'approve', reason: 'ok' };
    expect(enforceBlockingFailure(llm, safe).decision).toBe('approve');
  });

  it('handles null bundle as no-op', () => {
    const llm = { decision: 'approve', reason: 'ok' };
    expect(enforceBlockingFailure(llm, null).decision).toBe('approve');
  });

  it('ignores malformed failing atom ids that are not in bundle.atoms', () => {
    const malformed: PolicyBundle = {
      ...baseBundle,
      evaluations: [
        {
          atomId: 'atom.malformed.missing',
          pass: false,
          finding: { label: 'Bad row', value: 'fail', tone: 'fail' },
        },
      ],
      hasBlockingFailure: true,
    };
    const llm = { decision: 'approve', reason: 'ok' };
    const out = enforceBlockingFailure(llm, malformed);
    expect(out.decision).toBe('deny');
    expect(out.blockingFactIds).toEqual([]);
  });

  it('uses evaluation atom ids when the atom catalog is absent', () => {
    const missingAtoms: PolicyBundle = { ...baseBundle, atoms: [] };
    const llm = { decision: 'approve', reason: 'ok' };
    const out = enforceBlockingFailure(llm, missingAtoms);
    expect(out.decision).toBe('deny');
    expect(out.blockingFactIds).toEqual(['atom.external_price.helium.lt.20']);
  });
});

describe('mergePolicyBundleEvaluations', () => {
  it('mirrors policy findings and atom ids into the LLM result', () => {
    const safe: PolicyBundle = { ...baseBundle, hasBlockingFailure: false };
    const llm = {
      decision: 'approve',
      reason: 'ok',
      evidence: {
        findings: [{ label: 'Existing', value: 'kept', tone: 'neutral' }],
        decisionContract: { evidenceFactIds: ['fact.wallet.connected_public_key'] },
      },
      evidenceFactIds: ['fact.wallet.connected_public_key'],
    };

    const out = mergePolicyBundleEvaluations(llm, safe);
    expect(out.evidenceFactIds).toEqual([
      'fact.wallet.connected_public_key',
      'atom.price.sol.gte.80',
      'atom.external_price.helium.lt.20',
    ]);
    expect((out.evidence as { findings: unknown[] }).findings).toEqual(expect.arrayContaining([
      { label: 'Existing', value: 'kept', tone: 'neutral' },
      { label: 'SOL price', value: '$146.50 — jupiter', tone: 'good', atomId: 'atom.price.sol.gte.80' },
      { label: 'Helium plan', value: '$25 — web', tone: 'fail', atomId: 'atom.external_price.helium.lt.20' },
    ]));
    expect((out.evidence as unknown as { policyAtoms: unknown[] }).policyAtoms).toEqual([
      { id: 'atom.price.sol.gte.80', type: 'price', rawText: 'SOL must be above $80' },
      { id: 'atom.external_price.helium.lt.20', type: 'external_price', rawText: 'helium plan less than $20' },
    ]);
    expect(((out.evidence as Record<string, unknown>).decisionContract as Record<string, unknown>).evidenceFactIds).toEqual([
      'fact.wallet.connected_public_key',
      'atom.price.sol.gte.80',
      'atom.external_price.helium.lt.20',
    ]);
  });

  it('replaces same-label LLM findings with authoritative bundle findings', () => {
    const safe: PolicyBundle = { ...baseBundle, hasBlockingFailure: false };
    const out = mergePolicyBundleEvaluations({
      decision: 'approve',
      reason: 'ok',
      evidence: {
        findings: [{ label: 'Helium plan', value: 'model guess', tone: 'neutral' }],
      },
    }, safe);

    expect((out.evidence as { findings: unknown[] }).findings).toEqual(expect.arrayContaining([
      { label: 'Helium plan', value: '$25 — web', tone: 'fail', atomId: 'atom.external_price.helium.lt.20' },
    ]));
    expect((out.evidence as { findings: unknown[] }).findings).not.toEqual(expect.arrayContaining([
      { label: 'Helium plan', value: 'model guess', tone: 'neutral' },
    ]));
  });

  it('mirrors tx-gate outcomes onto evidence for audit/UI parity', () => {
    const withTxGates: PolicyBundle = {
      ...baseBundle,
      hasBlockingFailure: false,
      txGateOutcomes: {
        'atom.price.sol.gte.80': {
          rule: 'no_unrelated_instructions',
          pass: false,
          reason: 'Simulation touched an unrelated program.',
        },
      },
    };
    const out = mergePolicyBundleEvaluations({
      decision: 'approve',
      reason: 'ok',
      evidence: {},
    }, withTxGates);

    expect((out.evidence as Record<string, unknown>).policyTxGates).toEqual(withTxGates.txGateOutcomes);
  });

  it('mirrors evaluation findings when the atom catalog is absent', () => {
    const missingAtoms: PolicyBundle = { ...baseBundle, atoms: [] };
    const out = mergePolicyBundleEvaluations({
      decision: 'approve',
      reason: 'ok',
      evidence: {},
      evidenceFactIds: [],
    }, missingAtoms);

    expect(out.evidenceFactIds).toEqual([
      'atom.price.sol.gte.80',
      'atom.external_price.helium.lt.20',
    ]);
    expect((out.evidence as { findings: unknown[] }).findings).toEqual(expect.arrayContaining([
      { label: 'Helium plan', value: '$25 — web', tone: 'fail', atomId: 'atom.external_price.helium.lt.20' },
    ]));
  });

  it('merges policy findings before applying blocking safety', () => {
    const out = applyPolicyBundleReviewSafety({
      decision: 'approve',
      reason: 'model ignored bundle',
      evidence: {},
    }, baseBundle);

    expect(out.decision).toBe('deny');
    expect(out.blockingFactIds).toEqual(['atom.external_price.helium.lt.20']);
    expect(((out.evidence as Record<string, unknown>).decisionContract as Record<string, unknown>).blockingFactIds).toEqual([
      'atom.external_price.helium.lt.20',
    ]);
    expect((out.evidence as { findings: unknown[] }).findings).toEqual(expect.arrayContaining([
      { label: 'Helium plan', value: '$25 — web', tone: 'fail', atomId: 'atom.external_price.helium.lt.20' },
    ]));
  });
});
