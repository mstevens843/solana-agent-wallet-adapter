import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentAiRouteLabel,
  agentAiSetupHint,
  chooseAgentAiRoute,
  type AgentAiConfig,
} from '../ai/hosted.js';

const codexConnectorConfig: AgentAiConfig = {
  apiKey: '',
  path: 'bridge',
  provider: 'connector:codex',
  apiFormat: 'openai-compatible',
  baseUrl: '',
  model: '',
  engine: 'connector',
  connector: 'codex',
};

test('connector bridge status is a runnable agent route when signed in', () => {
  const route = chooseAgentAiRoute({
    hosted: null,
    signedIn: false,
    config: codexConnectorConfig,
    bridge: {
      available: true,
      configured: true,
      source: 'session',
      engine: 'connector',
      connector: 'codex',
      connectorLabel: 'Codex (ChatGPT plan)',
      connectorAuthStatus: 'connected',
    },
  });

  assert.equal(route.kind, 'bridge');
  assert.equal(agentAiRouteLabel(route), 'Connector · Codex (ChatGPT plan)');
});

test('configured connector does not fall back to hosted AI when the CLI is missing', () => {
  const route = chooseAgentAiRoute({
    hosted: { available: true, managed: { available: true, provider: 'Agentic', model: 'hosted' } },
    signedIn: true,
    config: {
      ...codexConnectorConfig,
      provider: 'connector:gemini',
      connector: 'gemini',
    },
    bridge: {
      available: false,
      configured: true,
      source: 'session',
      engine: 'connector',
      connector: 'gemini',
      connectorLabel: 'Gemini (Google AI Pro/Ultra)',
      connectorAuthStatus: 'binary-not-found',
    },
  });

  assert.equal(route.kind, 'none');
  assert.match(agentAiRouteLabel(route), /CLI not installed/);
  assert.match(agentAiSetupHint(route), /Gemini .*CLI is not installed/);
});
