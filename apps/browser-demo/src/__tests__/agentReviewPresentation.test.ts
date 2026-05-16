import { describe, expect, it } from 'vitest';

import {
  evidenceEntryTone,
  isAuditEvidenceKey,
  isTokenMismatchEvidenceKey,
  reviewEvidenceRows,
  reviewEvidenceSections,
  swapTokenTextMismatchWarning,
  tokenMismatchEvidenceRows,
} from '../agentReviewPresentation.js';
import type { AgentPlan } from '../planner.js';

const POPCAT_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function swapPlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    intent: 'Review DeFi swap of 0.1 SOL to USDC',
    route: 'SOL -> USDC',
    risk: 'Medium',
    approval: 'User wallet approval',
    source: 'template',
    category: 'trading',
    actionType: 'swap',
    templateTitle: 'Swap tokens',
    userNotes: '',
    parameters: {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.1',
      slippageBps: '50',
    },
    fields: [],
    safeguards: [],
    ...overrides,
  };
}

describe('agent review presentation helpers', () => {
  it('warns when swap text says USDC but the active output token is a different mint', () => {
    const warning = swapTokenTextMismatchWarning(
      swapPlan({ parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' } }),
      (value) => value === POPCAT_MINT ? 'POPCAT' : value,
    );

    expect(warning).toMatchObject({
      expectedToken: 'USDC',
      actualToken: 'POPCAT',
      actualValue: POPCAT_MINT,
    });
    expect(warning?.message).toContain('Draft text mentions USDC');
  });

  it('does not warn when swap text and output token are both USDC', () => {
    expect(swapTokenTextMismatchWarning(swapPlan())).toBeUndefined();
    expect(swapTokenTextMismatchWarning(
      swapPlan({ parameters: { inputToken: 'SOL', outputToken: USDC_MINT, amount: '0.1', slippageBps: '50' } }),
    )).toBeUndefined();
  });

  it('does not warn when a custom mint is consistently described as that custom token', () => {
    expect(swapTokenTextMismatchWarning(swapPlan({
      intent: 'Review DeFi swap of 0.1 SOL to POPCAT',
      route: `SOL -> ${POPCAT_MINT}`,
      userNotes: 'Swap to POPCAT for the demo.',
      parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' },
    }))).toBeUndefined();
  });

  it('does not warn when the active mint has a selected token label', () => {
    expect(swapTokenTextMismatchWarning(swapPlan({
      intent: 'Review DeFi swap of 0.1 SOL to POPCAT',
      route: 'SOL -> POPCAT',
      userNotes: 'Swap to POPCAT for the demo.',
      parameters: {
        inputToken: 'SOL',
        outputToken: POPCAT_MINT,
        outputTokenLabel: 'POPCAT',
        outputTokenMint: POPCAT_MINT,
        amount: '0.1',
        slippageBps: '50',
      },
    }))).toBeUndefined();
  });

  it('does not warn from stale prose when the route already uses the active output mint', () => {
    expect(swapTokenTextMismatchWarning(swapPlan({
      intent: 'Review DeFi swap of 0.1 SOL to USDC',
      route: `SOL -> ${POPCAT_MINT}`,
      userNotes: 'Review a new defi position before signing.',
      parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' },
    }))).toBeUndefined();
  });

  it('promotes token mismatch evidence into a fail row', () => {
    const rows = tokenMismatchEvidenceRows({
      tokenMismatch: true,
      intendedToken: 'USDC',
      actualToken: 'POPCAT',
      actualMint: POPCAT_MINT,
    });

    expect(rows).toEqual([{
      label: 'Token mismatch',
      value: `expected USDC; actual POPCAT; mint ${POPCAT_MINT}`,
      tone: 'fail',
    }]);
  });

  it('marks generic mismatch evidence keys and copy as fail tone', () => {
    expect(isTokenMismatchEvidenceKey('actualMint')).toBe(true);
    expect(isTokenMismatchEvidenceKey('actual_output_token')).toBe(true);
    expect(evidenceEntryTone('Token mismatch', 'Wrong token')).toBe('fail');
    expect(evidenceEntryTone('Market data', 'Liquidity checked')).toBe('neutral');
  });

  it('renders findings-only evidence without exposing raw structured JSON rows', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      evidence: {
        findings: [
          { label: 'Connector', value: 'Kamino enabled; reads are ready', tone: 'good' },
          { label: 'Wallet boundary', value: 'Wallet approval is still required', tone: 'neutral' },
        ],
      },
    });

    expect(rows).toEqual([
      { label: 'Connector', value: 'Kamino enabled; reads are ready', tone: 'good' },
      { label: 'Wallet boundary', value: 'Wallet approval is still required', tone: 'neutral' },
    ]);
    expect(rows.map((row) => row.label)).not.toContain('Findings');
  });

  it('keeps decision contract and raw object evidence out of normal findings', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      evidence: {
        findings: [
          { label: 'SOL price', value: '$86.60 (BirdEye)', tone: 'good' },
        ],
        decisionContract: {
          decision: 'approve',
          evidenceFactIds: ['fact.price.sol'],
          blockingFactIds: [],
          missingFactIds: [],
          confidence: 'low',
        },
        confidenceFactors: [{ id: 'gate.passed', delta: 0.2 }],
        rawProviderPayload: { nested: true },
      },
      auditReceipt: {
        schemaVersion: 1,
        receiptId: 'rcpt_123',
        planFingerprint: 'plan_hash',
        walletAddress: 'wallet',
        cluster: 'mainnet-beta',
        routePlanHash: 'route_hash',
        evidenceHash: 'evidence_hash',
        aiDecisionHash: 'ai_hash',
        finalDecision: 'approve',
        gateDecision: 'pass',
        checkedAt: '2026-05-16T00:00:00.000Z',
        providerRoutes: ['price'],
        evidenceFactIds: ['fact.price.sol'],
        blockingFactIds: [],
        missingRequirementIds: [],
      },
    });

    expect(isAuditEvidenceKey('decisionContract')).toBe(true);
    expect(rows).toEqual([{ label: 'SOL price', value: '$86.60 (BirdEye)', tone: 'good' }]);
    expect(rows.map((row) => row.label)).not.toContain('Decision contract');
    expect(rows.map((row) => row.label)).not.toContain('Raw provider payload');
    expect(rows.map((row) => row.label)).not.toContain('Audit receipt');
  });

  it('groups varied agent findings and moves audit rows into Advanced Audit', () => {
    const sections = reviewEvidenceSections({
      status: 'approved',
      summary: 'All requested gates passed.',
      reason: 'The swap matched the requested policy.',
      evidence: {
        findings: [
          { label: 'SOL price', value: '$86.60 (BirdEye)', tone: 'good' },
          { label: 'BTC Fear & Greed Index', value: '31 (Fear) - alternative.me', tone: 'good' },
          { label: 'INPUT SOL mint authority', value: 'disabled (null) - BirdEye', tone: 'good' },
          { label: 'Slippage protection', value: '0.50% (50 bps)', tone: 'good' },
          { label: 'Swap amount', value: '0.01 SOL (~$0.87)', tone: 'neutral' },
        ],
        sources: [{ title: 'BirdEye', url: 'https://birdeye.so/' }],
        decisionContract: {
          decision: 'approve',
          evidenceFactIds: ['fact.price.sol'],
          blockingFactIds: [],
          missingFactIds: [],
          confidence: 'low',
        },
      },
    }, { actionType: 'swap' });

    expect(sections.find((section) => section.id === 'decision')?.rows.map((row) => row.label)).toEqual(['Summary', 'Approval summary']);
    expect(sections.find((section) => section.id === 'market')?.rows.map((row) => row.label)).toEqual(['SOL price', 'BTC Fear & Greed Index']);
    expect(sections.find((section) => section.id === 'token')?.rows.map((row) => row.label)).toEqual(['INPUT SOL mint authority']);
    expect(sections.find((section) => section.id === 'transaction')?.rows.map((row) => row.label)).toEqual(['Slippage protection', 'Swap amount']);
    expect(sections.find((section) => section.id === 'sources')?.rows.map((row) => row.label)).toEqual(['Source: BirdEye']);
    expect(sections.find((section) => section.id === 'advanced')?.rows.map((row) => row.label)).toEqual(expect.arrayContaining([
      'Decision contract',
      'Confidence',
      'Cited evidence ids',
    ]));
  });

  it('renders research sources as first-class rows without raw source JSON', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      evidence: {
        research: { status: 'checked' },
        findings: [
          { label: 'Current price', value: 'Air Plan: $15/month plus taxes and fees', tone: 'good' },
          { label: 'Threshold rule', value: '$15 is less than $20, so approve.', tone: 'good' },
        ],
        sources: [
          {
            title: 'All Things Helium Mobile FAQ',
            url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
          },
        ],
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parseError: 'missing_or_invalid_review_json',
      },
      facts: {
        research: {
          state: 'checked',
          message: 'Official Helium Mobile support article checked.',
        },
        route: {
          state: 'checked',
          message: 'SOL -> USDC; exact venue route resolves from the Jupiter quote.',
        },
        quote: {
          state: 'missing',
          message: 'No quote fetched in the browser yet for this draft.',
        },
      },
    });

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Current price', value: 'Air Plan: $15/month plus taxes and fees', tone: 'good' },
      { label: 'Threshold rule', value: '$15 is less than $20, so approve.', tone: 'good' },
      {
        label: 'Source: All Things Helium Mobile FAQ',
        value: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
        tone: 'neutral',
      },
      { label: 'Research', value: 'Official Helium Mobile support article checked.', tone: 'good' },
    ]));
    expect(rows.map((row) => row.label)).not.toContain('Sources');
    expect(rows.map((row) => row.label)).not.toContain('Research status');
    expect(rows.map((row) => row.label)).not.toContain('Route');
    expect(rows.map((row) => row.label)).not.toContain('Quote');
    expect(rows.map((row) => row.label)).not.toContain('Action type');
    expect(rows.map((row) => row.label)).not.toContain('Template title');
    expect(rows.map((row) => row.label)).not.toContain('Parse error');
  });

  it('renders denial, missing input, connector warning, and stale state as first-class rows', () => {
    const rows = reviewEvidenceRows({
      status: 'denied',
      reason: 'Meteora connector is not enabled.',
      questions: [{ prompt: 'Which DLMM position should be checked?', required: true }],
      facts: {
        protocolConnector: {
          state: 'warn',
          message: 'Meteora is not enabled in Protocol Connectors.',
        },
      },
      evidence: {
        missingInputs: ['position address'],
      },
    }, { stale: true });

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Connector', value: 'Meteora is not enabled in Protocol Connectors.', tone: 'warn' },
      { label: 'Missing input', value: 'Which DLMM position should be checked?', tone: 'warn' },
      { label: 'Missing input', value: 'position address', tone: 'warn' },
      expect.objectContaining({ label: 'Stale review', tone: 'warn' }),
    ]));
  });

  it('falls back to summary and reason when the agent returns no findings', () => {
    expect(reviewEvidenceRows({
      status: 'needs_input',
      summary: 'The agent needs more information.',
      reason: 'Recipient is missing.',
    })).toEqual([
      { label: 'Summary', value: 'The agent needs more information.', tone: 'warn' },
      { label: 'Missing information', value: 'Recipient is missing.', tone: 'warn' },
    ]);
  });

  it('renders Plan rate and Threshold check findings above facts for swap action', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      decision: 'approve',
      reason: '$16.79 is under $20.',
      summary: 'Threshold rule checked.',
      evidence: {
        findings: [
          { label: 'Plan rate', value: '$16.79', tone: 'good' },
          { label: 'Threshold check', value: 'Corrected model comparison: $16.79 is under $20. Original decision was deny.', tone: 'good' },
        ],
      },
      facts: {
        protocol: { state: 'ok', message: 'Jupiter' },
        route: { state: 'ok', message: 'SOL -> USDC' },
      },
    }, { actionType: 'swap' });

    const labels = rows.map((row) => row.label);
    const planRateIdx = labels.indexOf('Plan rate');
    const thresholdIdx = labels.indexOf('Threshold check');
    const protocolIdx = labels.indexOf('Protocol');
    expect(planRateIdx).toBeGreaterThanOrEqual(0);
    expect(thresholdIdx).toBeGreaterThanOrEqual(0);
    expect(protocolIdx).toBeGreaterThanOrEqual(0);
    expect(planRateIdx).toBeLessThan(protocolIdx);
    expect(thresholdIdx).toBeLessThan(protocolIdx);
    expect(rows[planRateIdx]?.tone).toBe('good');
    expect(rows[thresholdIdx]?.tone).toBe('good');
  });

  it('renders Plan rate and Threshold check findings above facts for recurring_payment', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      decision: 'approve',
      reason: '$16.79 is under $20.',
      summary: 'Threshold rule checked.',
      evidence: {
        findings: [
          { label: 'Plan rate', value: '$16.79', tone: 'good' },
          { label: 'Threshold check', value: '$16.79 is under $20.', tone: 'good' },
        ],
      },
      facts: {
        recipient: { state: 'ok', message: 'CnTpbHELIUM...' },
        tokenMint: { state: 'ok', message: 'USDC' },
        schedule: { state: 'ok', message: 'monthly' },
      },
    }, { actionType: 'recurring_payment' });

    const labels = rows.map((row) => row.label);
    const planRateIdx = labels.indexOf('Plan rate');
    const thresholdIdx = labels.indexOf('Threshold check');
    const recipientIdx = labels.indexOf('Recipient');
    expect(planRateIdx).toBeGreaterThanOrEqual(0);
    expect(thresholdIdx).toBeGreaterThanOrEqual(0);
    expect(recipientIdx).toBeGreaterThanOrEqual(0);
    expect(planRateIdx).toBeLessThan(recipientIdx);
    expect(thresholdIdx).toBeLessThan(recipientIdx);
  });

  it('renders Threshold check as warn tone when reconciliation could not extract a price', () => {
    const rows = reviewEvidenceRows({
      status: 'needs_input',
      decision: 'needs_input',
      reason: 'The agent did not return a numeric value that could be compared against the $20 threshold.',
      summary: 'Threshold rule needs a numeric value to apply ($20).',
      evidence: {
        findings: [
          { label: 'Threshold check', value: 'Could not extract a current value to compare against the $20 threshold.', tone: 'warn' },
        ],
      },
    }, { actionType: 'swap' });

    const thresholdRow = rows.find((row) => row.label === 'Threshold check');
    expect(thresholdRow).toBeDefined();
    expect(thresholdRow?.tone).toBe('warn');
  });
});
