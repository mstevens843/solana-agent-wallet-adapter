import { describe, expect, it } from 'vitest';

import {
  agentReviewDisplayPath,
  agentReviewDisplayPathLabel,
} from '../agentReviewPathDisplay.js';

describe('agent review display path', () => {
  it('shows paired Device Agent transport as Plan Connector', () => {
    expect(agentReviewDisplayPath({
      source: 'device-agent',
      provider: 'Plan Connector - Codex',
      model: 'ChatGPT plan',
    })).toBe('plan-connector');
  });

  it('keeps real Device Agent API-key reviews as Device Agent', () => {
    expect(agentReviewDisplayPath({
      source: 'device-agent',
      provider: 'Claude / Anthropic',
      model: 'claude-opus-4-1',
    })).toBe('device-agent');
  });

  it('keeps Hosted BYOK reviews as Hosted BYOK', () => {
    const path = agentReviewDisplayPath({
      source: 'hosted',
      provider: 'Claude / Anthropic',
      model: 'claude-opus-4-1',
    });
    expect(path).toBe('hosted');
    expect(agentReviewDisplayPathLabel(path)).toBe('Hosted BYOK');
  });

  it('shows local bridge connector engine reviews as Plan Connector', () => {
    expect(agentReviewDisplayPath({
      source: 'bridge',
      provider: 'Plan Connector - Claude',
      model: 'Agent-SDK credits',
    })).toBe('plan-connector');
  });

  it('backfills old paired-bridge placeholder records as Plan Connector', () => {
    expect(agentReviewDisplayPath({
      source: 'device-agent',
      provider: 'paired-bridge',
      model: 'connector',
    })).toBe('plan-connector');
  });
});
