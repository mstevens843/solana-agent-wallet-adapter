import { describe, expect, it } from 'vitest';

import { DEVICE_AGENT_BOUNDARIES } from '../prompts/boundaries.js';
import {
  buildAskMessages,
  buildPlanMessages,
  buildReviewMessages,
  type NowFn,
} from '../prompts/messageAssembler.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';

// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/prompts/DeviceAgentMessageAssemblerTest.kt.
// The Kotlin test asserts currentDate as "2026-05-15T12:00:00Z" because Java's
// Instant.toString() trims zero millis; JavaScript's Date.toISOString() always
// emits the .000 suffix, so the canonical value here is "2026-05-15T12:00:00.000Z".

const FIXED_NOW: NowFn = () => new Date('2026-05-15T12:00:00.000Z');
const FIXED_CURRENT_DATE = '2026-05-15T12:00:00.000Z';

describe('buildPlanMessages', () => {
  it('uses the PLAN system prompt and preserves userPrompt + boundary defaults', () => {
    const messages = buildPlanMessages({ userPrompt: 'send 1 SOL to alice' });
    expect(messages.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.PLAN);
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.userPrompt).toBe('send 1 SOL to alice');
    expect(parsed.requiredBoundary).toBe(DEVICE_AGENT_BOUNDARIES.PLAN);
  });

  it('accepts browser payload aliases (prompt → userPrompt, connectorContext → protocolConnectors)', () => {
    const connector = { id: 'jupiter', selected: true };
    const messages = buildPlanMessages({
      prompt: 'swap 1 SOL for USDC',
      connectorContext: [connector],
    });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.userPrompt).toBe('swap 1 SOL for USDC');
    const connectors = parsed.protocolConnectors as Array<Record<string, unknown>>;
    expect(connectors[0]?.id).toBe('jupiter');
    expect('prompt' in parsed).toBe(false);
    expect('connectorContext' in parsed).toBe(false);
  });

  it('falls back to the default connector rule when no selected connector', () => {
    const messages = buildPlanMessages({
      userPrompt: 'swap',
      protocolConnectors: [{ id: 'jupiter', selected: false }],
    });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect((parsed.connectorRule as string).startsWith('Only propose first-class or Blink executable actions')).toBe(true);
  });

  it('switches the connector rule to the selected protocol when selected=true', () => {
    const messages = buildPlanMessages({
      userPrompt: 'swap',
      protocolConnectors: [{ id: 'jupiter', name: 'Jupiter', selected: true }],
    });
    const rule = (JSON.parse(messages.userContent) as Record<string, unknown>).connectorRule as string;
    expect(rule.startsWith('Use the selected protocol connector only: Jupiter.')).toBe(true);
    expect(rule).toContain('Do not switch protocols.');
    expect(rule).toContain('The wallet owner must approve separately.');
  });

  it('honors selectedOnly=true and falls back to id when name is missing', () => {
    const messages = buildPlanMessages({
      userPrompt: 'swap',
      protocolConnectors: [{ id: 'raydium', selectedOnly: true }],
    });
    const rule = (JSON.parse(messages.userContent) as Record<string, unknown>).connectorRule as string;
    expect(rule).toContain('raydium');
    expect(rule.startsWith('Use the selected protocol connector only: raydium.')).toBe(true);
  });

  it('omits userNotes from the output when absent in payload', () => {
    const messages = buildPlanMessages({ userPrompt: 'send 1 SOL' });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect('userNotes' in parsed).toBe(false);
  });

  it('preserves userNotes when present in payload', () => {
    const messages = buildPlanMessages({ userPrompt: 'send 1 SOL', userNotes: 'remember the memo' });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.userNotes).toBe('remember the memo');
  });

  it('lets a pre-built connectorRule pass through unchanged', () => {
    const messages = buildPlanMessages({
      userPrompt: 'swap',
      connectorRule: 'custom rule X.',
      protocolConnectors: [{ id: 'jupiter', selected: true }],
    });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.connectorRule).toBe('custom rule X.');
  });

  it('round-trips template and parameters objects unchanged', () => {
    const template = { id: 'swap', title: 'Swap SOL→USDC' };
    const parameters = { amount: '1.5', slippageBps: '50' };
    const messages = buildPlanMessages({ userPrompt: 'swap', template, parameters });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.template).toEqual(template);
    expect(parsed.parameters).toEqual(parameters);
  });

  it('defaults protocolConnectors to an empty array', () => {
    const messages = buildPlanMessages({ userPrompt: 'swap' });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.protocolConnectors).toEqual([]);
  });

  it('honors a non-blank requiredBoundary override', () => {
    const messages = buildPlanMessages({ userPrompt: 'swap', requiredBoundary: 'custom plan boundary' });
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.requiredBoundary).toBe('custom plan boundary');
  });
});

describe('buildReviewMessages', () => {
  it('uses the REVIEW system prompt and produces the hardcoded research object', () => {
    const messages = buildReviewMessages(
      { plan: { intent: 'swap' }, walletAddress: 'ABC123' },
      FIXED_NOW,
    );
    expect(messages.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW);
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    const research = parsed.research as Record<string, unknown>;
    expect(research.needed).toBe(false);
    expect(research.mode).toBe('not_required');
    expect(research.currentDate).toBe(FIXED_CURRENT_DATE);
    expect(research.maxSearches).toBe(3);
    expect(parsed.requiredBoundary).toBe(DEVICE_AGENT_BOUNDARIES.REVIEW);
    expect(parsed.walletAddress).toBe('ABC123');
  });

  it('defaults instruction, walletAddress, cluster, and plan when payload is empty', () => {
    const messages = buildReviewMessages({}, FIXED_NOW);
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.instruction).toBe(DEVICE_AGENT_BOUNDARIES.REVIEW_DEFAULT_INSTRUCTION);
    expect(parsed.walletAddress).toBe('not_connected');
    expect(parsed.cluster).toBe('unknown');
    expect(parsed.plan).toEqual({});
  });

  it('deep-preserves the context object', () => {
    const context = {
      evidenceFacts: [{ id: 'f1' }, { id: 'f2' }],
      evidenceGate: { decision: 'pass' },
    };
    const messages = buildReviewMessages(
      { plan: { intent: 'swap' }, context },
      FIXED_NOW,
    );
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.context).toEqual(context);
  });

  it('uses the system clock when no NowFn is supplied', () => {
    const before = Date.now();
    const messages = buildReviewMessages({});
    const after = Date.now();
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    const research = parsed.research as Record<string, unknown>;
    const stamped = Date.parse(research.currentDate as string);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe('buildAskMessages', () => {
  it('uses the ASK system prompt, preserves question, and applies ASK boundary', () => {
    const messages = buildAskMessages(
      { question: 'is this safe?', plan: { intent: 'swap' } },
      FIXED_NOW,
    );
    expect(messages.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.ASK);
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.question).toBe('is this safe?');
    expect(parsed.requiredBoundary).toBe(DEVICE_AGENT_BOUNDARIES.ASK);
    const research = parsed.research as Record<string, unknown>;
    expect(research.needed).toBe(false);
    expect(research.mode).toBe('not_required');
    expect(research.currentDate).toBe(FIXED_CURRENT_DATE);
    expect(research.maxSearches).toBe(3);
  });

  it('defaults question, plan, walletAddress, and cluster when payload is empty', () => {
    const messages = buildAskMessages({}, FIXED_NOW);
    const parsed = JSON.parse(messages.userContent) as Record<string, unknown>;
    expect(parsed.question).toBe('');
    expect(parsed.plan).toEqual({});
    expect(parsed.walletAddress).toBe('not_connected');
    expect(parsed.cluster).toBe('unknown');
  });
});
