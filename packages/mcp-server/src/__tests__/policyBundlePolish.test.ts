/**
 * Polish-pass tests for the post-sweep items:
 *   - #4 hasBlockingFailure enforcement: applyServerSideReviewSafety must downgrade
 *     an AI "approve" when policyBundle.hasBlockingFailure === true.
 *   - #8 unresolved-row filter: mergePolicyBundleFindings drops unresolved ("UNKNOWN")
 *     atom rows regardless of bundle size (a bare UNKNOWN row is never informative).
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

  it('uses evaluation atom ids when the atom catalog is absent', () => {
    const request = baseRequest({
      policyBundle: {
        hasBlockingFailure: true,
        evaluations: [
          { atomId: 'atom.external_price.helium.lt.20', pass: false, finding: { label: 'Helium plan', value: '$25', tone: 'fail' } },
        ],
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    const contract = (out.evidence as { decisionContract?: { blockingFactIds?: string[] } }).decisionContract;
    expect(out.decision).toBe('deny');
    expect(contract?.blockingFactIds).toEqual(['atom.external_price.helium.lt.20']);
  });

  it('keeps a cited policyBundle atom id (does not strip it or downgrade)', () => {
    // evidenceFacts present so the validation block runs; the model cites ONLY a policyBundle atom id.
    // It used to be stripped (knownIds was built from evidenceFacts only) → spurious approve→needs_input.
    const request = baseRequest({
      evidenceFacts: [{ id: 'fact.wallet.connected_public_key' }],
      policyBundle: {
        atoms: [{ id: 'atom.external_price.lowest_helium_monthly_phone_plan.lt.20' }],
        evaluations: [
          { atomId: 'atom.external_price.lowest_helium_monthly_phone_plan.lt.20', pass: true, finding: { label: 'Lowest Helium plan', value: '$15/month — web', tone: 'good' } },
        ],
      },
    });
    const result = baseResult({
      decision: 'approve',
      evidence: { decisionContract: { evidenceFactIds: ['atom.external_price.lowest_helium_monthly_phone_plan.lt.20'] } },
    });
    const out = applyServerSideReviewSafety(result, request);
    expect(out.decision).toBe('approve');
    const contract = (out.evidence as { decisionContract?: { evidenceFactIds?: string[]; serverSafetyStrippedIds?: string[] } }).decisionContract;
    expect(contract?.evidenceFactIds).toContain('atom.external_price.lowest_helium_monthly_phone_plan.lt.20');
    expect(contract?.serverSafetyStrippedIds ?? []).not.toContain('atom.external_price.lowest_helium_monthly_phone_plan.lt.20');
  });
});

describe('applyServerSideReviewSafety — blocking evidence fact re-verification (server-side gate hardening)', () => {
  // The evidence gate is computed client-side (browser/WebView) and handed in via
  // context.evidenceGate. A non-WebView caller (raw MCP / CLI / reference-agent) could strip that
  // gate or fake it to "pass" to skip gate enforcement. These tests prove the server independently
  // refuses to approve over a fact the caller itself marked severity:'block'.

  it('downgrades approve to deny when a blocking evidence fact is present and the gate is STRIPPED', () => {
    const request = baseRequest({
      // caller supplies facts but omits context.evidenceGate entirely
      evidenceFacts: [
        { id: 'fact.token_audit.mint_authority', severity: 'block' },
        { id: 'fact.wallet.connected_public_key', severity: 'info' },
      ],
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/blocking evidence fact/i);
    const contract = (out.evidence as { decisionContract?: { blockingFactIds?: string[] } }).decisionContract;
    expect(contract?.blockingFactIds).toContain('fact.token_audit.mint_authority');
    expect(contract?.blockingFactIds).not.toContain('fact.wallet.connected_public_key');
  });

  it('downgrades approve to deny even when the client FAKES the gate to pass', () => {
    const request = baseRequest({
      evidenceGate: { decision: 'pass' }, // attacker-supplied rosy gate
      evidenceFacts: [{ id: 'fact.token_audit.freeze_authority', severity: 'block' }],
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('deny');
    expect(out.reason).toMatch(/blocking evidence fact/i);
  });

  it('does NOT over-fire on non-blocking facts (warn/info) with no gate — legit policyBundle-backed approve stands', () => {
    const request = baseRequest({
      evidenceFacts: [
        { id: 'fact.wallet.connected_public_key', severity: 'info' },
        { id: 'fact.market.liquidity', severity: 'warn' },
      ],
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('approve');
  });

  it('leaves deny/needs_input unchanged when a blocking fact is present (never upgrades)', () => {
    const request = baseRequest({
      evidenceFacts: [{ id: 'fact.token_audit.mint_authority', severity: 'block' }],
    });
    expect(applyServerSideReviewSafety(baseResult({ decision: 'deny' }), request).decision).toBe('deny');
    expect(applyServerSideReviewSafety(baseResult({ decision: 'needs_input' }), request).decision).toBe('needs_input');
  });

  it('does nothing when there are no evidence facts at all (background-watch / pure-policyBundle path)', () => {
    const request = baseRequest({}); // no evidenceFacts, no gate
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('approve');
  });

  it('merges the blocking fact id into an EXISTING decisionContract (not a fresh one)', () => {
    // A benign fact the AI legitimately cites (so the evidence-id-strip block does not pre-empt) plus
    // a blocking fact. The AI already produced a decisionContract; the downgrade must merge into it.
    const request = baseRequest({
      evidenceFacts: [
        { id: 'fact.ok', severity: 'info' },
        { id: 'fact.token_audit.mint_authority', severity: 'block' },
      ],
    });
    const result = baseResult({
      decision: 'approve',
      evidence: { decisionContract: { evidenceFactIds: ['fact.ok'], blockingFactIds: ['pre.existing'] } },
    });
    const out = applyServerSideReviewSafety(result, request);
    expect(out.decision).toBe('deny');
    const contract = (out.evidence as { decisionContract?: { evidenceFactIds?: string[]; blockingFactIds?: string[] } }).decisionContract;
    expect(contract?.evidenceFactIds).toContain('fact.ok');            // existing contract reused
    expect(contract?.blockingFactIds).toContain('pre.existing');       // prior ids preserved
    expect(contract?.blockingFactIds).toContain('fact.token_audit.mint_authority'); // new id merged
  });
});

describe('applyServerSideReviewSafety — non-English language fail-closed enforcement', () => {
  it('forces needs_input when the policy bundle language requires input', () => {
    const request = baseRequest({
      policyBundle: {
        atoms: [],
        evaluations: [],
        hasBlockingFailure: false,
        language: { sourceLanguage: 'zh-Hans', canonicalizationStatus: 'failed', requiresInput: true },
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('needs_input');
    expect(out.reason).toMatch(/could not safely translate/i);
    const evidence = out.evidence as { languageSafetyApplied?: boolean; missingFactIds?: string[]; decisionContract?: { missingFactIds?: string[] } };
    expect(evidence.languageSafetyApplied).toBe(true);
    expect(evidence.missingFactIds).toContain('policy.language.canonicalization');
    expect(evidence.decisionContract?.missingFactIds).toContain('policy.language.canonicalization');
  });

  it('enforces on canonicalizationStatus=failed even without the requiresInput flag', () => {
    const request = baseRequest({
      policyBundle: { atoms: [], evaluations: [], hasBlockingFailure: false, language: { sourceLanguage: 'ru', canonicalizationStatus: 'failed' } },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('needs_input');
  });

  it('overrides a model deny too — an untranslatable rule cannot be safely denied either', () => {
    const request = baseRequest({
      policyBundle: { atoms: [], evaluations: [], hasBlockingFailure: false, language: { requiresInput: true } },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'deny' }), request);
    expect(out.decision).toBe('needs_input');
  });

  it('does NOT downgrade when canonicalization succeeded', () => {
    const request = baseRequest({
      policyBundle: {
        atoms: [{ id: 'atom.price.sol.gt.80' }],
        evaluations: [{ atomId: 'atom.price.sol.gt.80', pass: true, finding: { label: 'SOL price', value: '$146 — jupiter', tone: 'good' } }],
        hasBlockingFailure: false,
        language: { sourceLanguage: 'zh-Hans', canonicalizationStatus: 'success', requiresInput: false },
      },
    });
    const out = applyServerSideReviewSafety(baseResult({ decision: 'approve' }), request);
    expect(out.decision).toBe('approve');
  });
});

describe('#8 mergePolicyBundleFindings — drops unresolved (UNKNOWN) atom rows', () => {
  it('drops unresolved rows even when the bundle is small (a bare "UNKNOWN" row is never informative)', () => {
    const evaluations = [
      { atomId: 'a1', pass: true, finding: { label: 'A', value: 'ok — jupiter', tone: 'good' } },
      { atomId: 'a2', pass: undefined, unresolved: true, finding: { label: 'B', value: 'unknown', tone: 'warn' } },
    ];
    const request = baseRequest({ policyBundle: { evaluations, atoms: [{ id: 'a1' }, { id: 'a2' }] } });
    const out = mergePolicyBundleFindings(baseResult(), request);
    const findings = (out.evidence as { findings?: Array<{ label: string }> }).findings ?? [];
    const labels = findings.map((f) => f.label);
    expect(labels).toContain('A');
    expect(labels).not.toContain('B');
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
