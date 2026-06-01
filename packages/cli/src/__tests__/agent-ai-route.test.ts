import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chooseAgentAiRoute, type AgentAiConfig } from '../ai/hosted.js';

const config: AgentAiConfig = {
  apiKey: 'sk-test',
  path: 'hosted-byok',
  provider: 'openai',
  apiFormat: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
};

test('chooseAgentAiRoute falls back to hosted-managed when signed in and bridge is unavailable', () => {
  const route = chooseAgentAiRoute({
    hosted: {
      available: true,
      managed: { available: true, provider: 'OpenAI', model: 'gpt-5' },
    },
    bridge: { available: false },
    signedIn: true,
    config: null,
  });

  assert.equal(route.kind, 'hosted-managed');
});

test('chooseAgentAiRoute keeps local bridge ahead of hosted-managed', () => {
  const route = chooseAgentAiRoute({
    hosted: {
      available: true,
      managed: { available: true, provider: 'OpenAI', model: 'gpt-5' },
    },
    bridge: { available: true, configured: true, provider: 'local', model: 'local-model' },
    signedIn: true,
    config: null,
  });

  assert.equal(route.kind, 'bridge');
});

test('chooseAgentAiRoute requires sign-in for hosted BYOK', () => {
  const route = chooseAgentAiRoute({
    hosted: { available: true },
    bridge: { available: true },
    signedIn: false,
    config,
  });

  assert.equal(route.kind, 'none');
});
