/**
 * Polish-pass tests for the post-sweep items:
 *   - #4 hasBlockingFailure enforcement: applyServerSideReviewSafety must downgrade
 *     an AI "approve" when policyBundle.hasBlockingFailure === true.
 *   - #8 unresolved-row filter: mergePolicyBundleFindings drops unresolved rows on
 *     bundles larger than 3 atoms (noise control) but keeps them on small bundles.
 *   - #10 compact bundle: the LLM-facing policyBundle is compact (no resolutions.attempts).
 */

import { describe, expect, it } from 'vitest';

import { applyServerSideReviewSafety, mergePolicyBundleFindings } from '../aiPlanner.js';
import type { AiReviewRequest, AiReviewResult } from '../aiPlanner.js';

function baseResult(overrides: Partial<AiReviewResult> = {}): AiReviewResult {
  return {
    decision: 'approve',
    reason: 'OK',
    summary: 'OK',
    evidence: {},
    checkedAt: new Date().toISOString(),
    source: 'ai',
    ...overrides,
  } as AiReviewResult;
}

function baseRequest(context: Record<string, unknown> = {}): Required<AiReviewRequest> {
  return {
    plan: {
      source: 'ai', category: 'trading', actionType: 'swap',
      templateTitle: 'Swap', intent: 'Swap',
      route: 'AI draft only.', risk: 'Medium.', approval: 'Wallet approval is required.',
      parameters: {},
      fields: [],
      safeguards: ['Wallet approval is required.'],
    },
    instruction: 'Run policy review.',
    walletAddress: 'Wallet11111111111111111111111111111111111111',
    cluster: 'mainnet-beta',
    mode: 'single',
    context,
  } as unknown as Required<AiReviewRequest>;
}

describe('#4 applyServerSideReviewSafety — policyBundle.hasBlockingFailure enforcement', () => {
  it('downgrades AI "approve" to "deny" when bundle reports a blocking failure', () => {
    const request = baseRequest({
      policyBundle: {
        hasBlockingFailure: true,
        atoms: [
          { id: 'atom.price.sol.gt.80' },
          { id: 'atom.token_audit.mint_authority_disabled.true' },
        ],
        evaluations: [
          { atomId: 'atom.price.sol.gt.80', pass: false, finding: { label: 'SOL price', value: '$70 — jupiter', tone: 'fail' } },
          { atomId: 'atom.token_audit.mint_authority_disabled.true', pass: true, finding: { label: 'Mint authority', value: 'disabled — jupiter', tone: 'good' } },
        ],
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/policy bundle/i);
    const contract = (out.evidence as { decisionContract?: { blockingFactIds?: string[] } }).decisionContract;
    expect(contract?.blockingFactIds).toContain('atom.price.sol.gt.80');
    expect(contract?.blockingFactIds).not.toContain('atom.token_audit.mint_authority_disabled.true');
  });

  it('does NOT downgrade when hasBlockingFailure is false', () => {
    const request = baseRequest({
      policyBundle: {
        hasBlockingFailure: false,
        evaluations: [
          { atomId: 'atom.price.sol.gt.80', pass: true, finding: { label: 'SOL price', value: '$146 — jupiter', tone: 'good' } },
        ],
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('approve');
  });

  it('does not change deny/needs_input even when bundle has a blocking failure', () => {
    const request = baseRequest({
      policyBundle: { hasBlockingFailure: true, evaluations: [] },
    });
    const denied = applyServerSideReviewSafety(baseResult({ decision: 'deny' }), request);
    expect(denied.decision).toBe('deny');
    const needsInput = applyServerSideReviewSafety(baseResult({ decision: 'needs_input' }), request);
    expect(needsInput.decision).toBe('needs_input');
  });

  it('does not leak malformed failing atom ids into blockingFactIds', () => {
    const request = baseRequest({
      policyBundle: {
        hasBlockingFailure: true,
        atoms: [{ id: 'atom.price.sol.gt.80' }],
        evaluations: [
          { atomId: 'atom.malformed.missing', pass: false, finding: { label: 'Malformed', value: 'fail', tone: 'fail' } },
        ],
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    const contract = (out.evidence as { decisionContract?: { blockingFactIds?: string[] } }).decisionContract;
    expect(out.decision).toBe('deny');
    expect(contract?.blockingFactIds ?? []).toEqual([]);
  });
});

describe('#8 mergePolicyBundleFindings — unresolved-row filter on large bundles', () => {
  it('keeps unresolved rows when the bundle is small (≤3 atoms)', () => {
    const evaluations = [
      { atomId: 'a1', pass: true, finding: { label: 'A', value: 'ok — jupiter', tone: 'good' } },
      { atomId: 'a2', pass: undefined, unresolved: true, finding: { label: 'B', value: 'unknown', tone: 'warn' } },
    ];
    const request = baseRequest({ policyBundle: { evaluations, atoms: [{ id: 'a1' }, { id: 'a2' }] } });
    const out = mergePolicyBundleFindings(baseResult(), request);
    const findings = (out.evidence as { findings?: Array<{ label: string }> }).findings ?? [];
    expect(findings.map((f) => f.label)).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('drops unresolved rows when the bundle is large (>3 atoms)', () => {
    const evaluations = [
      { atomId: 'a1', pass: true, finding: { label: 'A', value: 'ok — jupiter', tone: 'good' } },
      { atomId: 'a2', pass: true, finding: { label: 'B', value: 'ok — birdeye', tone: 'good' } },
      { atomId: 'a3', pass: true, finding: { label: 'C', value: 'ok — coingecko', tone: 'good' } },
      { atomId: 'a4', pass: undefined, unresolved: true, finding: { label: 'D', value: 'unknown', tone: 'warn' } },
      { atomId: 'a5', pass: undefined, unresolved: true, finding: { label: 'E', value: 'unknown', tone: 'warn' } },
    ];
    const request = baseRequest({ policyBundle: { evaluations, atoms: evaluations.map((e) => ({ id: e.atomId })) } });
    const out = mergePolicyBundleFindings(baseResult(), request);
    const findings = (out.evidence as { findings?: Array<{ label: string }> }).findings ?? [];
    const labels = findings.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    expect(labels).not.toContain('D');
    expect(labels).not.toContain('E');
  });

  it('ignores evaluations whose atomId is not present in bundle.atoms', () => {
    const request = baseRequest({
      policyBundle: {
        atoms: [{ id: 'a1' }],
        evaluations: [
          { atomId: 'a1', pass: true, finding: { label: 'A', value: 'ok — jupiter', tone: 'good' } },
          { atomId: 'a2', pass: false, finding: { label: 'Malformed', value: 'fail', tone: 'fail' } },
        ],
      },
    });
    const out = mergePolicyBundleFindings(baseResult(), request);
    const findings = (out.evidence as { findings?: Array<{ label: string }> }).findings ?? [];
    expect(findings.map((f) => f.label)).toEqual(['A']);
  });
});
