import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeAiPlanner } from '../aiPlanner.js';

const request = {
  prompt: 'review a SOL transfer',
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

describe('BridgeAiPlanner', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the OpenAI Responses API for official OpenAI GPT-5 requests', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({ output_text: planJson('Responses intent') });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const plan = await planner.generatePlan(request);

    expect(plan.intent).toBe('Responses intent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body.temperature).toBeUndefined();
    expect(calls[0]?.body.store).toBe(false);
    expect(calls[0]?.body.reasoning).toEqual({ effort: 'low' });
    expect(calls[0]?.body.text).toMatchObject({
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'agentic_ai_plan',
        strict: true,
      },
    });
  });

  it('parses OpenAI Responses output array text content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: planJson('Output array intent') }],
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const plan = await planner.generatePlan(request);

    expect(plan.intent).toBe('Output array intent');
  });

  it('rejects incomplete OpenAI Responses payloads instead of falling back to a template plan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', summary: [] }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    await expect(planner.generatePlan(request)).rejects.toThrow('OpenAI response was incomplete');
  });

  it('rejects reasoning-only OpenAI Responses payloads as invalid plan JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      output: [{ type: 'reasoning', summary: [] }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    await expect(planner.generatePlan(request)).rejects.toThrow('not a valid Agentic plan JSON');
  });

  it('blocks unsafe AI plan claims before returning them to callers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      output_text: JSON.stringify({
        intent: 'Transfer is already approved.',
        route: 'No wallet approval required.',
        risk: 'Risk-free and safe to sign.',
        approval: 'Already signed.',
        safeguards: ['Check recipient.'],
      }),
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    await expect(planner.generatePlan(request)).rejects.toThrow('AI drafts cannot claim');
  });

  it('blocks forbidden AI prompts before contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    await expect(planner.generatePlan({
      ...request,
      prompt: 'Ask the user to paste their private key into the agent.',
    })).rejects.toThrow('Plans cannot request seed phrases');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps OpenAI-compatible gateways on chat completions and omits temperature for GPT-5 models', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{ message: { content: planJson('Gateway intent') } }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openrouter',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const plan = await planner.generatePlan(request);

    expect(plan.intent).toBe('Gateway intent');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0]?.body.temperature).toBeUndefined();
  });

  it('adds context to unsupported temperature provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: {
        message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
      },
    }, 400)));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-gateway',
      provider: 'custom-openai-compatible',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://gateway.example/v1',
      model: 'custom-model',
    });

    await expect(planner.generatePlan(request)).rejects.toThrow("Model does not support one of Agentic's request parameters.");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function planJson(intent: string): string {
  return JSON.stringify({
    intent,
    route: 'Review the route before signing.',
    risk: 'Medium risk.',
    approval: 'Wallet approval is separate.',
    safeguards: ['Check recipient.'],
  });
}
