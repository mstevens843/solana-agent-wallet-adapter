// Locks the Plan Connector (paired-bridge / relay) agent-decision contract: the desktop connector runs
// the shared system prompt and returns ALREADY-NORMALIZED payloads, which the phone passes through
// normalizeDeviceAgentPlan / normalizeAiReview / normalizeAiAsk (short-circuiting via the
// isHostedPlanPayload / isHostedReviewPayload / isNormalizedAskPayload detectors). The iOS relay path
// (iosForwardPlanRequest → these same normalizers) therefore yields identical, correctly-formatted
// results to Android. If the desktop response shape or the detectors drift, these break.

import { describe, expect, it } from 'vitest';

import {
  normalizeAiAsk,
  normalizeAiReview,
  normalizeDeviceAgentPlan,
  type AgentPlanAskRequest,
  type AgentPlanReviewRequest,
  type AiPlanRequest,
} from '../planner.js';

const planRequest: AiPlanRequest = {
  prompt: 'transfer 0.01 SOL',
  template: {
    id: 'custom-request',
    category: 'custom',
    title: 'Custom request',
    description: 'Turn request into a plan.',
    actionType: 'custom',
    risk: 'low',
  },
  parameters: { amount: '0.01' },
};

// A desktop-normalized plan payload (source:'ai' + the four structured fields) — the exact shape the
// bridge AI handler returns.
const desktopPlanPayload = {
  source: 'ai' as const,
  intent: 'Transfer 0.01 SOL to the recipient.',
  route: 'Wallet approval and signing happen later in the user wallet.',
  risk: 'Low risk routine transfer.',
  approval: 'User wallet approval is required.',
  safeguards: ['Verify the recipient address.'],
  category: 'transfer',
  actionType: 'transfer-sol',
  fields: [],
  parameters: { amount: '0.01' },
};

describe('Plan Connector (paired bridge) desktop pre-normalized payloads', () => {
  it('passes a desktop-normalized PLAN through normalizeDeviceAgentPlan (no re-parse, no false guardrail block)', () => {
    const plan = normalizeDeviceAgentPlan(desktopPlanPayload, planRequest);
    expect(plan.source).toBe('ai');
    expect(plan.intent).toBe('Transfer 0.01 SOL to the recipient.');
    expect(plan.route).toBe('Wallet approval and signing happen later in the user wallet.');
    expect(plan.risk).toMatch(/^Low/);
    expect(plan.approval).toContain('approval');
    expect(plan.guardrailReport?.verdict).not.toBe('block');
  });

  it('passes a desktop-normalized REVIEW through normalizeAiReview', () => {
    const plan = normalizeDeviceAgentPlan(desktopPlanPayload, planRequest);
    const reviewRequest: AgentPlanReviewRequest = { plan };
    const review = normalizeAiReview(
      {
        decision: 'approve',
        reason: 'The transfer is small and the recipient address looks valid.',
        summary: 'Approve the transfer.',
        evidence: { findings: [{ label: 'Amount', value: '0.01 SOL', tone: 'neutral' }] },
        checkedAt: '2026-06-12T00:00:00.000Z',
        source: 'ai',
      },
      reviewRequest,
    );
    expect(review.decision).toBe('approve');
    expect(review.reason).toContain('transfer');
    expect(review.summary).toBeTruthy();
    expect(review.source).toBe('ai');
  });

  it('passes a desktop-normalized ASK through normalizeAiAsk', () => {
    const ask = normalizeAiAsk({
      answer: 'This only prepares the action — you still approve and sign in your own wallet.',
      checkedAt: '2026-06-12T00:00:00.000Z',
      source: 'ai',
    });
    expect(ask.answer).toContain('your own wallet');
    expect(ask.source).toBe('ai');
  });

  it('still parses raw model text from a desktop that returns a chat envelope (fallback path)', () => {
    // Defensive: if a desktop ever returns the raw provider envelope instead of a normalized plan, the
    // phone still extracts + parses it (the non-short-circuit path), so paired AI never hard-fails on shape.
    const plan = normalizeDeviceAgentPlan(
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'Transfer 0.01 SOL.',
                route: 'Wallet approval happens later in the user wallet.',
                risk: 'Low risk.',
                approval: 'User wallet approval is required.',
                safeguards: ['Verify the recipient.'],
              }),
            },
          },
        ],
      },
      planRequest,
    );
    expect(plan.intent).toContain('Transfer');
    expect(plan.guardrailReport?.verdict).not.toBe('block');
  });
});
