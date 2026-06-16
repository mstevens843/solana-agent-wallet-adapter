import { describe, expect, it } from 'vitest';

import {
  auditReceiptDisplayRows,
  evidenceEntryTone,
  evidenceFactDisplayRows,
  isAuditEvidenceKey,
  isTokenMismatchEvidenceKey,
  reviewEvidenceRows,
  reviewEvidenceSections,
  swapTokenTextMismatchWarning,
  tokenMismatchEvidenceRows,
} from '../agentReviewPresentation.js';
import type { AgentAuditReceiptLike } from '../agentReviewPresentation.js';
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
  it('drops unavailable capability-gap fact rows but keeps resolved ones', () => {
    const rows = evidenceFactDisplayRows([
      { id: 'fact.connectorRead', label: 'Connector read facts', value: 'Jupiter connector facts unavailable: missing JUPITER_API_KEY.', tone: 'warn', severity: 'warn' },
      { id: 'fact.walletHoldings', label: 'Wallet holdings', value: 'Wallet holdings unavailable: no signed-in cloud session.', tone: 'warn', severity: 'warn' },
      { id: 'fact.tokenMint', label: 'Token identity', value: 'SOL and USDC resolved to known mints', tone: 'good', severity: 'info' },
    ]);
    const labels = rows.map((r) => r.label);
    expect(labels).toContain('Token identity');
    expect(labels).not.toContain('Connector read facts');
    expect(labels).not.toContain('Wallet holdings');
  });

  it('never hides a blocking (fail) row even if it mentions "unavailable"', () => {
    const rows = evidenceFactDisplayRows([
      { id: 'fact.oracle', label: 'Oracle', value: 'Price oracle unavailable', tone: 'fail', severity: 'block' },
    ]);
    expect(rows.map((r) => r.label)).toContain('Oracle');
  });

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

  it('localizes decision and evidence sections from source language metadata', () => {
    const sections = reviewEvidenceSections({
      status: 'approved',
      summary: 'Cheapest Helium Mobile monthly plan is under $20, so the swap draft passes the stated condition.',
      reason: "Helium Mobile's cheapest listed monthly mobile plan is $0/month, which is below the user's $20 approval threshold.",
      evidence: {
        language: { sourceLanguage: 'zh-Hans' },
        findings: [
          { label: 'Threshold check', value: '$0/month is below $20, so the approve-when condition holds.', tone: 'good' },
          { label: 'Monthly rate', value: '$0/month', tone: 'good' },
        ],
      },
    }, { actionType: 'swap' });

    const decision = sections.find((section) => section.id === 'decision');
    const market = sections.find((section) => section.id === 'market');
    expect(decision?.label).toBe('决策');
    expect(decision?.rows.map((row) => row.label)).toEqual(['摘要', '批准摘要', '阈值检查']);
    expect(decision?.rows[0]?.value).toContain('低于 $20');
    expect(market?.label).toBe('市场与价格');
    expect(market?.rows).toEqual([
      { label: '月费', value: '$0/month', tone: 'good' },
    ]);
  });

  it('prefers model-localized finding values in evidence sections', () => {
    const sections = reviewEvidenceSections({
      status: 'approved',
      summary: 'Approve the swap because the cheapest Helium Mobile monthly plan is under $20.',
      reason: "Helium Mobile's cheapest monthly phone plan found is $15/month, which is below the user's $20 approval threshold.",
      localized: {
        language: 'zh-Hans',
        status: 'ready',
        source: 'model',
        summary: '批准该 swap，因为 Helium Mobile 最便宜的月度套餐低于 $20。',
        reason: 'Helium Mobile 最便宜的月度手机套餐为 $15/month，低于用户的 $20 批准阈值。',
        findings: [
          { index: 0, label: '阈值检查', value: '$15/month 低于 $20，因此用户的批准条件成立。' },
        ],
      },
      evidence: {
        language: { sourceLanguage: 'zh-Hans' },
        findings: [
          { label: 'Threshold check', value: '$15/month is below $20, so the user’s approval condition holds.', tone: 'good' },
        ],
      },
    }, { actionType: 'swap' });

    const decision = sections.find((section) => section.id === 'decision');
    expect(decision?.rows).toEqual(expect.arrayContaining([
      { label: '阈值检查', value: '$15/month 低于 $20，因此用户的批准条件成立。', tone: 'good' },
    ]));
  });

  it('prefers model-localized reviewer and question copy in evidence rows', () => {
    const rows = reviewEvidenceRows({
      status: 'denied',
      reason: 'Risk reviewer flagged the mint authority.',
      reviewers: [
        { id: 'risk', label: 'Risk reviewer', decision: 'deny', reason: 'Token mint authority is still enabled.' },
      ],
      questions: [
        { id: 'q1', prompt: 'Which DLMM position should be checked?', required: true },
      ],
      localized: {
        language: 'zh-Hans',
        status: 'ready',
        source: 'model',
        reviewers: [
          { id: 'risk', label: '风险审核员', reason: '代币 mint 权限仍处于启用状态。' },
        ],
        questions: [
          { id: 'q1', prompt: '应检查哪个 DLMM 仓位？' },
        ],
      },
    });

    // Reviewer row: model-translated name + reason, and the verdict word ("Denied")
    // localized through the shared finding-label pack ("已拒绝").
    expect(rows).toEqual(expect.arrayContaining([
      { label: '风险审核员: 已拒绝', value: '代币 mint 权限仍处于启用状态。', tone: 'fail' },
      { label: 'Missing input', value: '应检查哪个 DLMM 仓位？', tone: 'warn' },
    ]));
  });

  it('falls back to source reviewer/question text when no model translation is present', () => {
    const rows = reviewEvidenceRows({
      status: 'denied',
      reviewers: [
        { id: 'risk', label: 'Risk reviewer', decision: 'deny', reason: 'Token mint authority is still enabled.' },
      ],
      questions: [
        { id: 'q1', prompt: 'Which DLMM position should be checked?', required: true },
      ],
    });

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Risk reviewer: Denied', value: 'Token mint authority is still enabled.', tone: 'fail' },
      { label: 'Missing input', value: 'Which DLMM position should be checked?', tone: 'warn' },
    ]));
  });

  it('prefers model-localized policy and fact copy in evidence rows', () => {
    const rows = reviewEvidenceRows({
      status: 'denied',
      reason: 'Denied by user policy.',
      policies: [{ label: 'Spend cap', ruleText: 'Deny if over $20.', outcome: 'block' }],
      facts: { route: { state: 'checked', message: 'SOL -> USDC via Jupiter.' } },
      localized: {
        language: 'zh-Hans',
        status: 'ready',
        source: 'model',
        policies: [{ index: 0, label: '消费上限', ruleText: '若超过 $20 则拒绝。' }],
        facts: [{ key: 'route', message: 'SOL -> USDC 通过 Jupiter。' }],
      },
    }, { actionType: 'swap' });

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Policy: 消费上限', value: '若超过 $20 则拒绝。', tone: 'fail' },
      { label: 'Route', value: 'SOL -> USDC 通过 Jupiter。', tone: 'good' },
    ]));
  });

  it('localizes counterfactual rationale from the localized copy', () => {
    const receipt: AgentAuditReceiptLike = {
      schemaVersion: 1,
      receiptId: 'rcpt_1',
      planFingerprint: 'fp_1',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'mainnet',
      routePlanHash: 'rph_1',
      evidenceHash: 'eh_1',
      aiDecisionHash: 'adh_1',
      finalDecision: 'deny',
      gateDecision: 'block',
      checkedAt: '2026-06-15T00:00:00.000Z',
      providerRoutes: [],
      evidenceFactIds: [],
      blockingFactIds: [],
      missingRequirementIds: [],
      counterfactualSummary: [{ id: 'cf1', rationale: 'If under $20 it would approve.', decisionAfter: 'approve' }],
    };

    const rows = auditReceiptDisplayRows(receipt, [{ index: 0, rationale: '若低于 $20 则会批准。' }]);

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Counterfactual → approve', value: '若低于 $20 则会批准。', tone: 'good' },
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

  it('suppresses unrelated swap/token rows for research-focused plan-threshold reviews', () => {
    const rows = reviewEvidenceRows({
      status: 'approved',
      evidenceFacts: [
        { id: 'fact.wallet', label: 'Connected wallet', value: '7abc...', tone: 'good' },
        { id: 'fact.route', label: 'Swap route', value: 'SOL -> USDC via Jupiter', tone: 'neutral' },
        { id: 'fact.token.security', label: 'Token security', value: 'Mint disabled; freeze disabled', tone: 'neutral' },
        { id: 'fact.token.market', label: 'Token market evidence', value: 'SOL price $82.63 via BirdEye', tone: 'neutral' },
      ],
      evidence: {
        research: { status: 'checked' },
        findings: [
          { label: 'Plan rate', value: '$15/month', tone: 'good' },
          { label: 'Threshold check', value: '$15 is less than $20.', tone: 'good' },
          { label: 'Execution aggregator', value: 'Jupiter prepares the swap for separate wallet approval', tone: 'neutral' },
        ],
        sources: [{ title: 'Helium Mobile Plans', url: 'https://www.heliummobile.com/plans' }],
      },
    }, { actionType: 'swap' });

    expect(rows).toEqual(expect.arrayContaining([
      { label: 'Plan rate', value: '$15/month', tone: 'good' },
      { label: 'Threshold check', value: '$15 is less than $20.', tone: 'good' },
      { label: 'Source: Helium Mobile Plans', value: 'https://www.heliummobile.com/plans', tone: 'neutral' },
    ]));
    expect(rows.map((row) => row.label)).not.toEqual(expect.arrayContaining([
      'Connected wallet',
      'Swap route',
      'Token security',
      'Token market evidence',
      'Execution aggregator',
    ]));
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

  it('renders wallet-required reviews as warning context, not failures', () => {
    expect(reviewEvidenceRows({
      status: 'wallet_required',
      decision: 'needs_input',
      summary: 'Condition passed; connect a wallet to continue.',
      reason: 'Condition passed, but a wallet must be connected before this draft can continue.',
    })).toEqual([
      { label: 'Summary', value: 'Condition passed; connect a wallet to continue.', tone: 'warn' },
      {
        label: 'Wallet required',
        value: 'Condition passed, but a wallet must be connected before this draft can continue.',
        tone: 'warn',
      },
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
