import { describe, expect, it } from 'vitest';

import {
  extractPolicyEnrichPayload,
  shouldEnrichPolicyBundle,
} from '../deviceAgentPolicyMiddleware.js';

describe('deviceAgentPolicyMiddleware', () => {
  it('enriches reviewPlan and ask, but leaves generatePlan alone', () => {
    expect(shouldEnrichPolicyBundle('reviewPlan', { instruction: 'approve if SOL > $80' })).toBe(true);
    expect(shouldEnrichPolicyBundle('ask', { question: 'what is SOL price right now?' })).toBe(true);
    expect(shouldEnrichPolicyBundle('generatePlan', { userPrompt: 'swap SOL to USDC' })).toBe(false);
  });

  it('skips enrichment when a caller already supplied a policy bundle', () => {
    expect(shouldEnrichPolicyBundle('reviewPlan', {
      instruction: 'approve if SOL > $80',
      context: { policyBundle: { atoms: [] } },
    })).toBe(false);
  });

  it('extracts ask questions as enrichment instructions without approval semantics', () => {
    const payload = extractPolicyEnrichPayload('ask', {
      question: 'Is there a Solana network outage right now?',
      walletAddress: 'Wallet111',
      plan: {
        actionType: 'swap',
        intent: 'Swap SOL to USDC',
        userNotes: 'only if Solana is healthy',
        parameters: { inputToken: 'SOL', outputToken: 'USDC' },
      },
    });

    expect(payload).toMatchObject({
      instruction: 'Is there a Solana network outage right now?',
      walletAddress: 'Wallet111',
      actionType: 'swap',
      intent: 'Swap SOL to USDC',
      userNotes: 'only if Solana is healthy',
      draftParameters: { inputToken: 'SOL', outputToken: 'USDC' },
    });
  });
});
