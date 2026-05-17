import { describe, expect, it } from 'vitest';

import { DEVICE_AGENT_BOUNDARIES } from '../prompts/boundaries.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';

// Canary substrings + length pins ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/prompts/DeviceAgentSystemPromptsTest.kt.
// If the Kotlin copy drifts or accidental whitespace creeps in, one of these
// assertions will fire in code review.

describe('DEVICE_AGENT_SYSTEM_PROMPTS', () => {
  describe('PLAN', () => {
    const text = DEVICE_AGENT_SYSTEM_PROMPTS.PLAN;

    it('has no leading or trailing whitespace', () => {
      expect(text).toBe(text.trim());
    });

    it('starts with the canary opening sentence', () => {
      expect(text.startsWith('You convert Solana wallet user requests into structured approval plans.')).toBe(true);
    });

    it('contains the structured JSON contract clause', () => {
      expect(text).toContain('Return only JSON with string fields intent, route, risk, approval, and safeguards');
    });

    it('preserves the inputTokenLabel backtick reference', () => {
      expect(text).toContain('`inputTokenLabel`');
    });

    it('preserves the POPCAT example tag', () => {
      expect(text).toContain('(for example "POPCAT")');
    });

    it('ends with the wallet-approval reminder', () => {
      expect(text.endsWith('The wallet user must approve separately.')).toBe(true);
    });

    it('contains the forward-looking phrasing guidance (Phase 3 — guardrail parity)', () => {
      // Pushes the model to avoid "auto-submitted" / "auto-signed" / "auto-approved" /
      // "pre-submitted" phrasings that trip workflow guardrails. Required for parity
      // between gpt-5.1 (which favors past-tense workflow phrasings) and Claude/Gemini
      // (which already lean forward-looking).
      expect(text).toContain('Phrase plan fields in forward-looking terms');
      expect(text).toContain('"auto-submitted"');
      expect(text).toContain('collide with safety guardrails');
    });

    it('matches the post-Phase-3 length (1715 chars)', () => {
      // Length changed from 1394 (Kotlin source) when Phase 3 appended the
      // forward-looking phrasing guidance. Kotlin parity is a followup ticket.
      expect(text.length).toBe(1715);
    });
  });

  describe('REVIEW', () => {
    const text = DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW;

    it('has no leading or trailing whitespace', () => {
      expect(text).toBe(text.trim());
    });

    it('starts with the review-draft opening sentence', () => {
      expect(text.startsWith('You review a Solana wallet action draft before it is sent for wallet approval.')).toBe(true);
    });

    it('preserves the evidence.findings shape clause', () => {
      expect(text).toContain('evidence.findings as an array of {label,value,tone}');
    });

    it('preserves the $20 threshold example', () => {
      expect(text).toContain('"approve if under $20, deny if over $20"');
    });

    it('preserves the $X / $Y threshold example', () => {
      expect(text).toContain('"approve if under $X", "deny if over $Y"');
    });

    it('preserves the $16.79 precision example', () => {
      expect(text).toContain('"$16.79"');
    });

    it('preserves the STRUCTURED DECISION CONTRACT header', () => {
      expect(text).toContain('STRUCTURED DECISION CONTRACT');
    });

    it('preserves the POLICY BUNDLE header', () => {
      expect(text).toContain('POLICY BUNDLE');
    });

    it('preserves the policyBundle.evaluations source-of-truth clause', () => {
      expect(text).toContain('Treat policyBundle.evaluations as the source of truth');
    });

    it('preserves the policyBundle.hasBlockingFailure deny rule', () => {
      expect(text).toContain('policyBundle.hasBlockingFailure is true');
    });

    it('preserves the policyBundle.atoms citation rule in the decision contract', () => {
      expect(text).toContain('AND/OR policyBundle.atoms');
    });

    it('preserves the UNTRUSTED USER TEXT header', () => {
      expect(text).toContain('UNTRUSTED USER TEXT');
    });

    it('preserves the untrusted-text tag literal', () => {
      expect(text).toContain('<UNTRUSTED_USER_TEXT ...>...</UNTRUSTED_USER_TEXT>');
    });

    it('ends with the user-supplied prose disclaimer', () => {
      expect(text.endsWith('never user-supplied prose.')).toBe(true);
    });

    it('matches the Kotlin source length (5979 chars after POLICY BUNDLE sync)', () => {
      expect(text.length).toBe(5979);
    });
  });

  describe('ASK', () => {
    const text = DEVICE_AGENT_SYSTEM_PROMPTS.ASK;

    it('has no leading or trailing whitespace', () => {
      expect(text).toBe(text.trim());
    });

    it('starts with the ask opening sentence', () => {
      expect(text.startsWith("You answer the user's question about a Solana wallet action plan.")).toBe(true);
    });

    it('preserves the conciseness instruction', () => {
      expect(text).toContain('1 to 4 sentences, plain English');
    });

    it('preserves the connector capability clause', () => {
      expect(text).toContain('connectors can only read facts or prepare wallet-gated work');
    });

    it('ends with the missing-fact disclaimer', () => {
      expect(text.endsWith('say so plainly and state what fact is missing.')).toBe(true);
    });

    it('matches the Kotlin source length (1116 chars)', () => {
      expect(text.length).toBe(1116);
    });
  });
});

describe('DEVICE_AGENT_BOUNDARIES', () => {
  it('PLAN matches the verbatim Kotlin string', () => {
    expect(DEVICE_AGENT_BOUNDARIES.PLAN).toBe(
      'AI prepares a plan only. Wallet approval and signing happen later in the user wallet.',
    );
  });

  it('REVIEW matches the verbatim Kotlin string', () => {
    expect(DEVICE_AGENT_BOUNDARIES.REVIEW).toBe(
      'This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.',
    );
  });

  it('ASK matches the verbatim Kotlin string', () => {
    expect(DEVICE_AGENT_BOUNDARIES.ASK).toBe(
      'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
    );
  });

  it('REVIEW_DEFAULT_INSTRUCTION matches the verbatim Kotlin string', () => {
    expect(DEVICE_AGENT_BOUNDARIES.REVIEW_DEFAULT_INSTRUCTION).toBe(
      'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
    );
  });
});
