// Tests for the BYOK device-agent policy-bundle helpers. Covers:
//   - spliceBundle merges into existing context without clobbering siblings
//   - enforceBlockingFailure overrides approve → deny when bundle has failures
//   - enforceBlockingFailure passes through deny/needs_input unchanged
//   - empty bundle is a no-op
import { describe, expect, it } from 'vitest';
import {
  enforceBlockingFailure,
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
});
