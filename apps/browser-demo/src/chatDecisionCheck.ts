import type { AgentPlan } from './planner.js';

export const CHAT_DECISION_CHECK_TEMPLATE_ID = 'chat-decision-check';
export const CHAT_DECISION_CHECK_TITLE = 'Agent Decision Planner';

export const CHAT_DECISION_SUGGESTED_PROMPTS: string[] = [
  'SOL to POPCAT: approve only if current BTC Fear & Greed > 20, current SOL price > $60, mint/freeze disabled, token age > 24h, and no extra transfers.',
  'Helium plan check: approve payment only if the current monthly plan price is under $20.',
  'Mad Lads floor check: approve buy only if the current floor is under 30 SOL.',
  'Token safety check: deny if mint authority or freeze authority is enabled, or token age is under 24h.',
];

export type ChatDecisionStatus = 'approved' | 'denied' | 'needs_input' | 'wallet_required' | 'error' | 'checking';

export function buildChatDecisionCheckPlan(prompt: string): AgentPlan {
  const request = prompt.trim();
  return {
    intent: `One-shot pass/fail decision: ${request}`,
    route: 'Use current research for outside facts, evaluate every user-supplied condition, and return an explicit APPROVE, DENY, or NEEDS INPUT decision.',
    risk: 'Medium. This is a decision-only review with no wallet action prepared, queued, signed, or submitted.',
    approval: 'No transaction is prepared or signed automatically. The result is advisory until the user separately creates a wallet action.',
    source: 'template',
    category: 'chat',
    actionType: 'manual_review',
    templateTitle: CHAT_DECISION_CHECK_TITLE,
    userNotes: request,
    parameters: {
      mode: 'chat_decision_check',
      decisionMode: 'pass_fail',
      policy: request,
    },
    fields: [
      { label: 'Decision prompt', value: request },
      { label: 'Mode', value: 'Pass/fail chat check' },
    ],
    safeguards: [
      'Treat the user prompt as the decision policy.',
      'Use current research when conditions depend on prices, market state, token safety, listings, plans, news, or protocol data.',
      'Return a precise APPROVE, DENY, or NEEDS INPUT result with reasons mapped to the conditions.',
      'Do not create, queue, sign, or submit a wallet action from this chat decision check.',
    ],
  };
}

export function chatDecisionStatusLabel(status: ChatDecisionStatus | undefined): string {
  switch (status) {
    case 'approved':
      return 'APPROVE';
    case 'denied':
      return 'DENY';
    case 'needs_input':
      return 'NEEDS INPUT';
    case 'wallet_required':
      return 'WALLET NEEDED';
    case 'checking':
      return 'CHECKING';
    case 'error':
    default:
      return 'REVIEW FAILED';
  }
}

export function chatDecisionStatusClass(status: ChatDecisionStatus | undefined): string {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'denied':
      return 'denied';
    case 'needs_input':
      return 'needs-input';
    case 'wallet_required':
      return 'wallet-required';
    case 'checking':
      return 'checking';
    case 'error':
    default:
      return 'error';
  }
}
