import { describe, expect, it } from 'vitest';

import {
  CHAT_DECISION_CHECK_TITLE,
  CHAT_DECISION_SUGGESTED_PROMPTS,
  buildChatDecisionCheckPlan,
  chatDecisionStatusClass,
  chatDecisionStatusLabel,
} from '../chatDecisionCheck.js';

describe('chat decision check', () => {
  it('builds a decision-only manual review plan from the user policy prompt', () => {
    const prompt = 'Approve only if SOL is above $60 and token age is above 24h.';
    const plan = buildChatDecisionCheckPlan(prompt);

    expect(plan.templateTitle).toBe(CHAT_DECISION_CHECK_TITLE);
    expect(plan.source).toBe('template');
    expect(plan.category).toBe('chat');
    expect(plan.actionType).toBe('manual_review');
    expect(plan.userNotes).toBe(prompt);
    expect(plan.parameters).toMatchObject({
      mode: 'chat_decision_check',
      decisionMode: 'pass_fail',
      policy: prompt,
    });
    expect(plan.route).toContain('current research');
    expect(plan.approval.toLowerCase()).toContain('no transaction');
    expect(plan.safeguards.join(' ').toLowerCase()).toContain('do not create');
  });

  it('ships four concise example prompts that cover market, payment, nft, and token safety checks', () => {
    expect(CHAT_DECISION_SUGGESTED_PROMPTS).toHaveLength(4);
    expect(CHAT_DECISION_SUGGESTED_PROMPTS.join('\n')).toContain('POPCAT');
    expect(CHAT_DECISION_SUGGESTED_PROMPTS.join('\n')).toContain('Helium plan');
    expect(CHAT_DECISION_SUGGESTED_PROMPTS.join('\n')).toContain('Mad Lads');
    expect(CHAT_DECISION_SUGGESTED_PROMPTS.join('\n')).toContain('mint authority');
    expect(CHAT_DECISION_SUGGESTED_PROMPTS.filter((prompt) => /\bcurrent\b/i.test(prompt)).length).toBeGreaterThanOrEqual(3);
  });

  it('maps review statuses to compact chat verdict labels and classes', () => {
    expect(chatDecisionStatusLabel('approved')).toBe('APPROVE');
    expect(chatDecisionStatusLabel('denied')).toBe('DENY');
    expect(chatDecisionStatusLabel('needs_input')).toBe('NEEDS INPUT');
    expect(chatDecisionStatusClass('approved')).toBe('approved');
    expect(chatDecisionStatusClass('needs_input')).toBe('needs-input');
    expect(chatDecisionStatusClass('wallet_required')).toBe('wallet-required');
  });
});
