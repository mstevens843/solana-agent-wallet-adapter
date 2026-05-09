import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aiRouteDiagnosticForSettings,
  confirmHostedAiPlanner,
  generateSessionAiPlan,
  redactSecrets,
  type AiPlanRequest,
  type AiSettings,
} from '../planner.js';

const planRequest: AiPlanRequest = {
  prompt: 'review transfer',
  userNotes: 'test only',
  template: {
    id: 'custom-request',
    category: 'custom',
    title: 'Custom request',
    description: 'Turn request into a plan.',
    actionType: 'custom',
    risk: 'medium',
  },
  parameters: {
    amount: '0.01',
  },
};

const sessionSettings: AiSettings = {
  mode: 'session',
  provider: 'openrouter',
  apiFormat: 'openai-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'openrouter/auto',
  apiKey: 'provider-secret-value-123456789',
};

describe('planner AI setup helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redacts exact browser-session provider keys from errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        message: `Bad key ${sessionSettings.apiKey}; Authorization: Bearer ${sessionSettings.apiKey}`,
      },
    }, 401)));

    let message = '';
    try {
      await generateSessionAiPlan(sessionSettings, planRequest);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('[redacted]');
    expect(message).not.toContain(sessionSettings.apiKey);
  });

  it('confirms Hosted BYOK through the status route without generating a plan', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('/api/ai/status');
      return jsonResponse({ available: true, mode: 'hosted-byok' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const diagnostics = await confirmHostedAiPlanner({
      ...sessionSettings,
      mode: 'hosted',
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AI_PLAN_READY',
        method: 'GET',
        path: '/api/ai/status',
      }),
    ]));
  });

  it('reports bridge planner confirmation as the status route', () => {
    expect(aiRouteDiagnosticForSettings(
      { mode: 'bridge', provider: 'openai', model: 'gpt-5' },
      { method: 'GET', path: '/bridge/ai/status', bridgeBaseUrl: 'http://127.0.0.1:8787/' },
    )).toMatchObject({
      code: 'AI_ROUTE',
      method: 'GET',
      path: '/bridge/ai/status',
      detail: 'http://127.0.0.1:8787/bridge/ai/status',
    });
  });

  it('redacts exact nonstandard keys in the generic redaction helper', () => {
    const apiKey = 'provider-secret-value-abcdef123456';

    expect(redactSecrets(`bad ${apiKey}`, apiKey)).toBe('bad [redacted]');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
