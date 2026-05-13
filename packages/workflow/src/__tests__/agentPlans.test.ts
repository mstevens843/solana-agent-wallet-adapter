import { describe, expect, it } from 'vitest';

import {
  buildTemplatePlan,
  canQueueAgentPlan,
  defaultTemplateFieldValues,
  inferTemplateIdForPrompt,
  inferredTemplateParameters,
  planWithStructuredSwapText,
  templateById,
} from '../agentPlans.js';

describe('shared agent plan helpers', () => {
  it('infers and parameterizes SOL transfers from natural language', () => {
    const recipient = '9xQeWvG816bUx9EPfU37Fv8qvYfVhbUvv3RCq7JtZVw9';
    const template = templateById(inferTemplateIdForPrompt(`send 0.25 SOL to ${recipient}`));
    const parameters = inferredTemplateParameters(template, `send 0.25 SOL to ${recipient}`);
    const plan = buildTemplatePlan(template, parameters, 'template');

    expect(template.id).toBe('transfer-sol');
    expect(parameters).toMatchObject({ amount: '0.25', recipient });
    expect(plan.actionType).toBe('transfer_sol');
    expect(canQueueAgentPlan(plan)).toBe(true);
  });

  it('keeps swap execution tokens structured while repairing stale prose', () => {
    const template = templateById('swap');
    const parameters = {
      ...defaultTemplateFieldValues(template),
      inputToken: 'SOL',
      outputToken: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
      outputTokenLabel: 'POPCAT',
      amount: '0.1',
      slippageBps: '50',
    };
    const plan = planWithStructuredSwapText({
      ...buildTemplatePlan(template, parameters, 'ai'),
      intent: 'Swap 0.1 SOL to USDC',
      route: 'SOL -> USDC',
      approval: 'Confirm the USDC amount before signing.',
      risk: 'USDC output must match policy.',
      safeguards: ['Check USDC route.'],
    });

    expect(plan.parameters.outputToken).toBe('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr');
    expect(plan.route).toBe('SOL -> POPCAT');
    expect(plan.intent).toContain('POPCAT');
    expect(plan.intent).not.toContain('USDC');
  });

  it('treats recurring and Blink drafts as queueable but leaves custom requests proof-only', () => {
    const recurring = buildTemplatePlan(templateById('subscription'), {
      token: 'USDC',
      recipient: '9xRecipient',
      amount: '5',
      cadence: 'monthly',
      memo: 'subscription',
    });
    const blink = buildTemplatePlan(templateById('protocol-blink-action'), {
      protocol: 'Meteora',
      operation: 'Claim fees',
      blinkUrl: 'https://actions.meteora.ag/claim',
      position: '',
      amount: '',
      memo: '',
    });
    const custom = buildTemplatePlan(templateById('custom-request'), { policy: 'No hidden approvals' });

    expect(canQueueAgentPlan(recurring)).toBe(true);
    expect(canQueueAgentPlan(blink)).toBe(true);
    expect(canQueueAgentPlan(custom)).toBe(false);
  });
});
