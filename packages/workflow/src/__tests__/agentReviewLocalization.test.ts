import { describe, expect, it } from 'vitest';

import {
  agentReviewLocalizedLabel,
  agentReviewLocalizedProse,
  localizeAgentReviewResultForDisplay,
  normalizeAgentReviewLocalizedCopy,
  reviewLocalizationPayload,
  reviewLocalizationPayloadHasText,
  sanitizeAgentReviewLocalizedCopy,
} from '../agentReviewLocalization.js';
import {
  POLICY_LANGUAGE_NEEDS_INPUT_REASON,
  POLICY_LANGUAGE_NEEDS_INPUT_SUMMARY,
} from '../policyLanguage.js';

describe('agent review display localization', () => {
  it('localizes common Helium approval copy from policy language metadata', () => {
    const result = localizeAgentReviewResultForDisplay({
      decision: 'approve' as const,
      reason: "Helium Mobile's cheapest listed monthly mobile plan is $0/month, which is below the user's $20 approval threshold.",
      summary: 'Cheapest Helium Mobile monthly plan is under $20, so the swap draft passes the stated condition.',
      evidence: {
        language: { sourceLanguage: 'zh-Hans' },
        findings: [
          { label: 'Threshold check', value: '$0/month is below $20, so the approve-when condition holds.', tone: 'good' },
          { label: 'Monthly rate', value: '$0/month', tone: 'good' },
        ],
      },
    });

    expect(result.localized?.language).toBe('zh-Hans');
    expect(result.localized?.summary).toContain('低于 $20');
    expect(result.localized?.reason).toContain('批准阈值');
    expect(result.localized?.findings?.[0]).toMatchObject({
      label: '阈值检查',
      value: '$0/month 低于 $20，因此“满足条件时批准”的规则成立。',
    });
    expect(agentReviewLocalizedLabel('reviewPassed', 'zh-Hans')).toBe('审核通过');
  });

  it('ignores stale model-localized copy when the canonical review text changed', () => {
    const result = localizeAgentReviewResultForDisplay({
      decision: 'approve' as const,
      reason: 'Cheapest Helium Mobile monthly plan is under $20, so the swap draft passes the stated condition.',
      summary: 'Cheapest Helium Mobile monthly plan is under $20, so the swap draft passes the stated condition.',
      evidence: { language: { sourceLanguage: 'zh-Hans' }, findings: [] },
      localized: {
        language: 'zh-Hans',
        status: 'ready',
        source: 'model',
        canonicalHash: 'stale',
        summary: '旧摘要',
      },
    });

    expect(result.localized?.summary).not.toBe('旧摘要');
    expect(result.localized?.summary).toContain('Helium Mobile');
  });

  it('normalizes model-provided reviewer localized copy', () => {
    const localized = normalizeAgentReviewLocalizedCopy({
      language: 'ja',
      source: 'model',
      reviewers: [{ id: 'policy', label: 'Policy', reason: '条件を満たします。' }],
    });

    expect(localized?.reviewers).toEqual([
      { id: 'policy', label: 'Policy', reason: '条件を満たします。' },
    ]);
  });

  it('localizes the generated Helium prose variants shown in review details', () => {
    const result = localizeAgentReviewResultForDisplay({
      decision: 'approve' as const,
      summary: 'Approve the swap because the cheapest Helium Mobile monthly plan is under $20.',
      reason: "Helium Mobile’s cheapest monthly phone plan found is $15/month, which is below the user’s $20 approval threshold.",
      evidence: {
        language: { sourceLanguage: 'zh-Hans' },
        findings: [
          { label: 'Threshold check', value: '$15/month is below $20, so the user’s approval condition holds.', tone: 'good' },
          { label: 'Transaction simulation', value: 'Transaction simulation runs after the wallet signs and broadcasts. Not required for draft review unless the prompt asks about on-chain effects.', tone: 'neutral' },
        ],
        decisionContract: { decision: 'approve', evidenceFactIds: [], blockingFactIds: [], missingFactIds: [] },
      },
    });

    expect(result.localized?.summary).toBe('批准该 swap，因为 Helium Mobile 最便宜的月度套餐低于 $20。');
    expect(result.localized?.reason).toContain('$15/month');
    expect(result.localized?.reason).toContain('$20');
    expect(result.localized?.findings?.[0]?.value).toContain('$15/month');
    expect(result.localized?.findings?.[0]?.value).toContain('$20');
    expect(result.localized?.findings?.[1]).toMatchObject({
      label: '交易模拟',
      value: expect.stringContaining('钱包签名'),
    });
  });

  it('rejects localized model fields that change protected facts', () => {
    const review = {
      summary: 'Approve swap as Helium Mobile plan is under $20.',
      reason: '$15/month is below $20, so approve.',
      evidence: {
        findings: [
          { label: 'Threshold check', value: '$15/month is below $20, so approve.', tone: 'good' },
        ],
      },
    };

    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'zh-Hans',
      status: 'ready',
      source: 'model',
      summary: '批准 swap，因为 Helium Mobile 套餐低于 $25。',
      reason: '$15/month 低于 $20，因此批准。',
      findings: [
        { index: 0, label: '阈值检查', value: '$18/month 低于 $20，因此批准。' },
      ],
    });

    expect(sanitized?.summary).toBeUndefined();
    expect(sanitized?.reason).toBe('$15/month 低于 $20，因此批准。');
    expect(sanitized?.findings?.[0]).toEqual({ index: 0, label: '阈值检查' });
  });

  it('accepts currency reformatting that preserves the numeric amount', () => {
    const review = {
      reason: 'SOL price is under $20, so approve.',
      evidence: {
        findings: [{ label: 'Threshold check', value: 'under $20', tone: 'good' }],
      },
    };

    // Italian reformats "$20" -> "20 dollari" (same amount, no $). It MUST be accepted now,
    // while the verbatim token symbol "SOL" is still required.
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'it',
      status: 'ready',
      source: 'model',
      reason: 'Il prezzo di SOL è meno di 20 dollari, quindi approva.',
      findings: [{ index: 0, label: 'Controllo soglia', value: 'meno di 20 dollari' }],
    });

    expect(sanitized?.reason).toBe('Il prezzo di SOL è meno di 20 dollari, quindi approva.');
    expect(sanitized?.findings?.[0]?.value).toBe('meno di 20 dollari');
  });

  it('still rejects a translation that drops the token symbol', () => {
    const review = { reason: 'SOL price is under $20, so approve.', evidence: {} };
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'it',
      status: 'ready',
      source: 'model',
      // Drops "SOL" — must be rejected (protected token symbol).
      reason: 'Il prezzo è meno di 20 dollari, quindi approva.',
    });
    expect(sanitized?.reason).toBeUndefined();
  });

  it('localizes model policies, facts, and counterfactual rationale', () => {
    const review = {
      reason: 'Denied by user policy.',
      policies: [{ label: 'Spend cap', ruleText: 'Deny if over $20.', outcome: 'block' as const }],
      facts: { route: { state: 'checked', message: 'SOL -> USDC via Jupiter.' } },
      auditReceipt: {
        counterfactualSummary: [{ id: 'cf1', rationale: 'If under $20 it would approve.', decisionAfter: 'approve' as const }],
      },
      evidence: {},
    };
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'zh-Hans',
      status: 'ready',
      source: 'model',
      policies: [{ index: 0, label: '消费上限', ruleText: '若超过 $20 则拒绝。' }],
      facts: [{ key: 'route', message: 'SOL -> USDC 通过 Jupiter。' }],
      counterfactuals: [{ index: 0, rationale: '若低于 $20 则会批准。' }],
    });

    expect(sanitized?.policies).toEqual([{ index: 0, label: '消费上限', ruleText: '若超过 $20 则拒绝。' }]);
    expect(sanitized?.facts).toEqual([{ key: 'route', message: 'SOL -> USDC 通过 Jupiter。' }]);
    expect(sanitized?.counterfactuals).toEqual([{ index: 0, rationale: '若低于 $20 则会批准。' }]);
  });

  it('drops localized policy/fact/counterfactual entries with no matching source', () => {
    const review = {
      reason: 'Denied.',
      policies: [{ label: 'Cap', ruleText: 'Deny over $20.' }],
      facts: { route: { message: 'SOL route.' } },
      auditReceipt: { counterfactualSummary: [{ rationale: 'base rationale' }] },
      evidence: {},
    };
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'es',
      status: 'ready',
      source: 'model',
      reason: 'Rechazado.',
      // index 7 / key 'ghost' / index 9 have no source — the model invented them.
      policies: [{ index: 7, label: 'inventado', ruleText: 'texto inventado' }],
      facts: [{ key: 'ghost', message: 'mensaje inventado' }],
      counterfactuals: [{ index: 9, rationale: 'inventado' }],
    });

    expect(sanitized?.reason).toBe('Rechazado.');
    expect(sanitized?.policies).toBeUndefined();
    expect(sanitized?.facts).toBeUndefined();
    expect(sanitized?.counterfactuals).toBeUndefined();
  });

  it('rejects a translation that introduces a foreign URL absent from the source', () => {
    const review = { summary: 'Swap review.', reason: 'Approve the swap.', evidence: {} };
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'es',
      status: 'ready',
      source: 'model',
      summary: 'Revisión del swap.',
      // Hallucinated phishing link not present in the source — must be dropped.
      reason: 'Aprueba el swap. Verifica en http://evil.example/claim',
    });

    expect(sanitized?.summary).toBe('Revisión del swap.');
    expect(sanitized?.reason).toBeUndefined();
  });

  it('keeps localized question options index-aligned with the source (no filter shift)', () => {
    const review = {
      questions: [{ id: 'q1', prompt: 'Choose one', options: ['Approve', 'Keep SOL', 'Cancel'] }],
      evidence: {},
    };
    const sanitized = sanitizeAgentReviewLocalizedCopy(review, {
      language: 'es',
      status: 'ready',
      source: 'model',
      questions: [{
        id: 'q1',
        prompt: 'Elige una',
        // "Mantener" drops the protected token "SOL" -> rejected. It MUST fall back to the source
        // option at index 1, not be filtered out (which would shift "Cancelar" into index 1 and
        // make the renderer show the wrong label for option 2).
        options: ['Aprobar', 'Mantener', 'Cancelar'],
      }],
    });

    expect(sanitized?.questions?.[0]?.options).toEqual(['Aprobar', 'Keep SOL', 'Cancelar']);
  });

  it('reviewLocalizationPayload emits policies/facts/counterfactuals and hasText detects them', () => {
    const payload = reviewLocalizationPayload({
      policies: [{ label: 'Spend cap', ruleText: 'Deny if over $20.', outcome: 'block' }],
      facts: { route: { state: 'checked', message: 'SOL -> USDC via Jupiter.' } },
      auditReceipt: {
        counterfactualSummary: [{ rationale: 'If under $20 it would approve.' }],
      },
    }, 'zh-Hans');

    expect(payload.policies).toEqual([{ index: 0, label: 'Spend cap', ruleText: 'Deny if over $20.' }]);
    expect(payload.facts).toEqual([{ key: 'route', message: 'SOL -> USDC via Jupiter.' }]);
    expect(payload.counterfactuals).toEqual([{ index: 0, rationale: 'If under $20 it would approve.' }]);
    // A policy/fact-only review (no reason/summary/findings) must still trigger the localize call.
    expect(reviewLocalizationPayloadHasText(payload)).toBe(true);
  });
});

// Fail-closed needs_input copy is shared across FOUR enforcers. The TS surfaces (this constant,
// mcp-server aiPlanner, browser-demo policyEnrichClient) all import POLICY_LANGUAGE_NEEDS_INPUT_*.
// The native enforcers hold verbatim copies that MUST match this canary:
//   - apps/android-twa/.../agent/runtime/PolicyBundleEnforcer.kt
//   - packages/ios-capacitor-bridge/ios/Plugin/AgenticPolicyBundleEnforcer.swift
// If you change the constant below, update both native files in lockstep.
describe('policy-language fail-closed needs_input copy (cross-platform drift guard)', () => {
  it('pins the canonical reason + summary strings', () => {
    expect(POLICY_LANGUAGE_NEEDS_INPUT_REASON).toBe(
      'Agentic could not safely translate this non-English policy rule. Rephrase it or provide the rule in English before approval.',
    );
    expect(POLICY_LANGUAGE_NEEDS_INPUT_SUMMARY).toBe('Non-English policy translation needs review.');
  });

  it('keeps the phrase-pack patterns in sync with the constant (recognized, not passed through)', () => {
    expect(agentReviewLocalizedProse(POLICY_LANGUAGE_NEEDS_INPUT_REASON, 'zh-Hans')).not.toBe(
      POLICY_LANGUAGE_NEEDS_INPUT_REASON,
    );
    expect(agentReviewLocalizedProse(POLICY_LANGUAGE_NEEDS_INPUT_SUMMARY, 'zh-Hans')).not.toBe(
      POLICY_LANGUAGE_NEEDS_INPUT_SUMMARY,
    );
  });
});
