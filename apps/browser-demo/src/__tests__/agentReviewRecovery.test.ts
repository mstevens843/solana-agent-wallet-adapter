import { describe, expect, it } from 'vitest';

import {
  ASK_AGENT_CONVERSATION_ONLY_REASON,
  INTERRUPTED_AGENT_ASK_REASON,
  INTERRUPTED_AGENT_REVIEW_REASON,
  recoverInterruptedAgentReviews,
} from '../agentReviewRecovery.js';

describe('agent review recovery', () => {
  it('marks interrupted checking reviews as retryable errors', () => {
    const nowIso = '2026-05-31T18:00:00.000Z';
    const { records, changed } = recoverInterruptedAgentReviews([{
      id: 'plan_1',
      updatedAt: '2026-05-31T17:59:00.000Z',
      agentReview: {
        status: 'checking',
        reason: 'Agent is reviewing this draft before it can move forward.',
        checkedAt: '2026-05-31T17:59:00.000Z',
      },
    }], { nowIso, staleAfterMs: 0 });

    expect(changed).toBe(true);
    expect(records[0]?.updatedAt).toBe(nowIso);
    expect(records[0]?.agentReview).toMatchObject({
      status: 'error',
      reason: INTERRUPTED_AGENT_REVIEW_REASON,
      checkedAt: nowIso,
    });
  });

  it('marks pending ask-agent exchanges as interrupted', () => {
    const nowIso = '2026-05-31T18:00:00.000Z';
    const { records, changed } = recoverInterruptedAgentReviews([{
      id: 'plan_1',
      updatedAt: '2026-05-31T17:59:00.000Z',
      agentReview: {
        status: 'approved',
        reason: 'Approved.',
        conversation: [{
          id: 'ask_1',
          question: 'why?',
          askedAt: '2026-05-31T17:59:30.000Z',
          pending: true,
        }],
      },
    }], { nowIso, staleAfterMs: 0 });

    expect(changed).toBe(true);
    expect(records[0]?.agentReview?.status).toBe('approved');
    expect(records[0]?.agentReview?.conversation?.[0]).toMatchObject({
      pending: false,
      error: INTERRUPTED_AGENT_ASK_REASON,
      answeredAt: nowIso,
    });
  });

  it('does not turn completed ask-only conversations into review failures', () => {
    const record = {
      id: 'plan_1',
      updatedAt: '2026-05-31T17:59:00.000Z',
      agentReview: {
        status: 'checking',
        reason: ASK_AGENT_CONVERSATION_ONLY_REASON,
        checkedAt: '2026-05-31T17:59:00.000Z',
        conversation: [{
          id: 'ask_1',
          question: 'why?',
          askedAt: '2026-05-31T17:59:00.000Z',
          answer: 'Because the draft still needs wallet approval.',
          answeredAt: '2026-05-31T17:59:10.000Z',
        }],
      },
    };

    const { records, changed } = recoverInterruptedAgentReviews([record], {
      nowIso: '2026-05-31T18:00:00.000Z',
      staleAfterMs: 0,
    });

    expect(changed).toBe(false);
    expect(records[0]).toBe(record);
  });
});
