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

/**
 * The concrete wallet action a Decision Check is gating (2-step flow: the user sends
 * conditions, then builds this action to be checked against them). `parameters` carries
 * `planMints`-friendly string keys (inputMint/outputMint/token/amountSol/amount/recipient/
 * statement) so the agent-review fact router fetches token-safety/price/age for the REAL
 * tokens the action touches.
 */
export interface ChatDecisionCheckAction {
  kind: string;
  summary: string;
  parameters?: Record<string, string>;
}

export function buildChatDecisionCheckPlan(prompt: string, action?: ChatDecisionCheckAction): AgentPlan {
  const request = prompt.trim();
  if (action) {
    const actionParams = action.parameters ?? {};
    return {
      intent: `Pass/fail decision on a wallet action: ${request}`,
      route: 'Evaluate the attached wallet action against every user-supplied condition, using current research for any outside fact. Return an explicit APPROVE, DENY, or NEEDS INPUT decision for THIS action.',
      risk: 'Medium. This reviews a prepared wallet action; nothing is signed or submitted unless the user approves the verdict and signs it afterward.',
      approval: 'The wallet action becomes signable only when the decision is APPROVE, and only after the user reviews and signs it. Nothing is auto-signed.',
      source: 'template',
      category: 'chat',
      actionType: 'manual_review',
      templateTitle: CHAT_DECISION_CHECK_TITLE,
      userNotes: request,
      parameters: {
        mode: 'chat_decision_check',
        decisionMode: 'pass_fail',
        policy: request,
        walletActionKind: action.kind,
        walletAction: action.summary,
        ...actionParams,
      },
      fields: [
        { label: 'Decision prompt', value: request },
        { label: 'Wallet action', value: action.summary },
        { label: 'Mode', value: 'Pass/fail action check' },
      ],
      safeguards: [
        'Treat the user prompt as the decision policy for the attached wallet action.',
        'Use current research when conditions depend on prices, market state, token safety, listings, plans, news, or protocol data.',
        'Evaluate the attached wallet action against every condition and return a precise APPROVE, DENY, or NEEDS INPUT result with reasons mapped to the conditions.',
        'Do not sign or submit the wallet action; APPROVE only signals the user may review and sign it.',
      ],
    };
  }
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
