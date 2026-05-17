import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    vi.stubEnv('AGENTIC_AI_ALLOW_CUSTOM_BASE_URL', '1');
    // Opt out of the (now default-on) LLM atom extractor in this suite — these tests
    // count exact fetch calls and would otherwise see an extra atom-extraction call on
    // NOTEs the regex doesn't cover. Tests that explicitly want the fallback can override.
    vi.stubEnv('AGENTIC_AI_ATOM_LLM_FALLBACK', '0');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    const planFormat = (calls[0]?.body.text as { format?: { schema?: unknown } } | undefined)?.format;
    const planSchema = (planFormat as { schema?: unknown } | undefined)?.schema;
    expect(planSchema, 'expected agentic_ai_plan schema to be present on the request').toBeDefined();
    expectAdditionalPropertiesClosed(planSchema, 'agentic_ai_plan root');
  });

  it('sends the OpenAI Responses review request with strict:false to allow open-shaped evidence', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        output: [{
          type: 'message',
          status: 'completed',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              decision: 'approve',
              reason: 'Plan rate $16.79 is under $20.',
              summary: 'Approved.',
              evidence: { findings: [{ label: 'Plan rate', value: '$16.79', tone: 'good' }] },
            }),
          }],
        }],
        status: 'completed',
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai-strict-review',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'No outside facts needed; just verify the draft.',
    });

    expect(review.decision).toBe('approve');
    const reviewCall = calls.find((call) => {
      const text = (call.body.text ?? {}) as Record<string, unknown>;
      const format = (text.format ?? {}) as Record<string, unknown>;
      return format.name === 'agentic_ai_review';
    });
    expect(reviewCall, 'expected an OpenAI Responses /responses call with agentic_ai_review schema').toBeDefined();
    expect(reviewCall?.url).toBe('https://api.openai.com/v1/responses');
    expect(reviewCall?.body.text).toMatchObject({
      format: {
        type: 'json_schema',
        name: 'agentic_ai_review',
        strict: false,
      },
    });
    const reviewFormat = (reviewCall?.body.text as { format?: { schema?: unknown } } | undefined)?.format;
    const reviewSchema = (reviewFormat as { schema?: unknown } | undefined)?.schema;
    expect(reviewSchema, 'expected agentic_ai_review schema to be present on the request').toBeDefined();
    expectAdditionalPropertiesClosed(reviewSchema, 'agentic_ai_review root');
  });

  it('removes hidden separators from bridge session keys before building provider headers', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ headers: init?.headers as Record<string, string> });
      return jsonResponse({ output_text: planJson('Sanitized key intent') });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test\u2028-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const plan = await planner.generatePlan(request);

    expect(plan.intent).toBe('Sanitized key intent');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test-openai');
  });

  it('updates bridge session model settings without re-entering the API key', () => {
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const status = planner.setSessionKey({
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
    });

    expect(status).toMatchObject({
      available: true,
      configured: true,
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-5.5',
      source: 'session',
    });
  });

  it('adds plain-English help for bridge provider HTTP status failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 503)));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openrouter',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
    });

    await expect(planner.generatePlan(request)).rejects.toThrow('AI provider returned HTTP 503. That means the provider is temporarily unavailable or overloaded.');
  });

  it('rejects non-ASCII bridge session keys before provider fetch can throw a ByteString error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const planner = new BridgeAiPlanner();

    expect(() => planner.setSessionKey({
      apiKey: 'sk-test-é-openai',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    })).toThrow('AI API key contains unsupported characters');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('adds MCP connector registry context to plan prompts by default', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{ message: { content: planJson('Connector-aware intent') } }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-connectors',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const plan = await planner.generatePlan({
      ...request,
      prompt: 'Can you supply 0.1 SOL to Kamino?',
      connectorContext: undefined,
    });

    expect(plan.intent).toBe('Connector-aware intent');
    const messages = calls[0]?.body.messages as Array<{ role: string; content: string }>;
    const userMessage = messages.find((entry) => entry.role === 'user');
    expect(userMessage?.content).toContain('Kamino Finance');
    expect(userMessage?.content).toContain('solana_prepare_kamino_deposit');
    expect(userMessage?.content).toContain('Jupiter');
    expect(userMessage?.content).toContain('first_class_prepare');
    expect(userMessage?.content).toContain('does not sign');
  });

  it('reviews plans with an approve or deny decision', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: 'deny',
              reason: 'Denied: requested slippage is higher than the user policy.',
              summary: 'Slippage policy did not pass.',
              evidence: {},
            }),
          },
        }],
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

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Swap SOL to USDC',
        route: 'SOL -> USDC',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check quote.'],
      },
      instruction: 'Check route and slippage before approval.',
    });

    expect(review).toMatchObject({
      decision: 'deny',
      reason: 'Denied: requested slippage is higher than the user policy.',
      summary: 'Slippage policy did not pass.',
      source: 'ai',
    });
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user' }),
    ]));
  });

  it('returns needs_input with questions when the model asks for clarification', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'needs_input',
            reason: 'I need to know which recipient you mean before approving.',
            summary: 'Agent has follow-up questions.',
            evidence: { recipientAmbiguous: true },
            questions: [
              { id: 'recipient', prompt: 'Which recipient is correct?', inputKind: 'text', required: true },
              { id: 'amount', prompt: 'Is the amount in SOL or USDC?', inputKind: 'select', options: ['SOL', 'USDC'], required: true },
            ],
          }),
        },
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-needs-input',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Send SOL to alice',
        route: 'Send 1 SOL.',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'ai',
        category: 'payments',
        actionType: 'transfer_sol',
        templateTitle: 'Send SOL',
        parameters: { recipient: 'alice', amount: '1' },
        fields: [{ label: 'Recipient', value: 'alice' }],
        safeguards: ['Confirm recipient.'],
      },
      instruction: 'Review this send before approval.',
    });

    expect(review.decision).toBe('needs_input');
    expect(review.summary).toBe('Agent has follow-up questions.');
    expect(review.questions).toHaveLength(2);
    expect(review.questions?.[0]).toMatchObject({ id: 'recipient', inputKind: 'text', required: true });
    expect(review.questions?.[1]).toMatchObject({ id: 'amount', inputKind: 'select', options: ['SOL', 'USDC'] });
  });

  it('forwards user policies in the review request context to the provider', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: 'approve',
              reason: 'Approved with policy in mind.',
              summary: 'Within slippage policy.',
              evidence: { policiesApplied: ['policy-slip'] },
            }),
          },
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-policies',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Swap SOL to USDC',
        route: 'SOL -> USDC',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check quote.'],
      },
      instruction: 'Review swap with active user policies.',
      context: {
        userPolicies: [
          { id: 'policy-slip', label: 'No swaps over 1% slippage', kind: 'slippage_max', detail: '', params: { value: '1' } },
        ],
      },
    });

    expect(review.decision).toBe('approve');
    const messages = (calls[0]?.body.messages ?? []) as Array<{ role: string; content: string }>;
    const userMessage = messages.find((entry) => entry.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage?.content).toContain('userPolicies');
    expect(userMessage?.content).toContain('policy-slip');
    expect(userMessage?.content).toContain('slippage_max');
  });

  it('preserves flexible findings evidence without requiring fixed review rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'approve',
            reason: 'Reserve facts are adequate and the amount is modest.',
            summary: 'Kamino deposit can be sent for wallet approval.',
            evidence: {
              findings: [
                { label: 'Reserve', value: 'SOL supply APY 5.4%', tone: 'good' },
                { label: 'Deposit cap', value: '1000 SOL remaining', tone: 'good' },
              ],
            },
          }),
        },
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-findings',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Supply 0.1 SOL to Kamino',
        route: 'Kamino SOL reserve deposit',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'ai',
        category: 'defi',
        actionType: 'kamino_deposit',
        templateTitle: 'Supply to Kamino',
        parameters: { token: 'SOL', amount: '0.1' },
        fields: [{ label: 'Amount', value: '0.1 SOL' }],
        safeguards: ['Check reserve facts.'],
      },
      instruction: 'Use connector facts and return user-facing findings.',
      context: {
        facts: [
          { connectorId: 'kamino', label: 'Supply APY', value: '5.4%', tone: 'good' },
          { connectorId: 'kamino', label: 'Deposit capacity', value: '1000 SOL remaining', tone: 'good' },
        ],
      },
    });

    expect(review.decision).toBe('approve');
    expect(review.evidence.findings).toEqual([
      { label: 'Reserve', value: 'SOL supply APY 5.4%', tone: 'good' },
      { label: 'Deposit cap', value: '1000 SOL remaining', tone: 'good' },
    ]);
  });

  it('caps questions at three and drops malformed entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'needs_input',
            reason: 'Several open questions.',
            summary: 'Multiple clarifications needed.',
            evidence: {},
            questions: [
              { id: 'q1', prompt: 'Question one?', inputKind: 'text', required: true },
              { id: 'q2', prompt: 'Question two?', inputKind: 'text', required: false },
              { id: 'q3', prompt: 'Question three?', inputKind: 'text', required: true },
              { id: 'q4', prompt: 'Question four?', inputKind: 'text', required: true },
              { id: 'bad' /* missing prompt */ },
            ],
          }),
        },
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-multi',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Generic transfer review',
        route: 'Review and decide.',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'ai',
        category: 'payments',
        actionType: 'transfer_sol',
        templateTitle: 'Send SOL',
        parameters: { recipient: 'x', amount: '1' },
        fields: [{ label: 'Recipient', value: 'x' }],
        safeguards: ['Confirm.'],
      },
      instruction: 'Review before approval.',
    });

    expect(review.questions).toHaveLength(3);
    expect(review.questions?.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
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

  it('captures reviewers and aggregates deny > needs_input > approve in multi-mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'approve',
            reason: 'Aggregate not trustworthy; client should recompute.',
            summary: 'Mixed reviewer verdicts.',
            evidence: {},
            reviewers: [
              { id: 'risk', decision: 'approve', reason: 'No authority changes.' },
              { id: 'quote', decision: 'approve', reason: 'Slippage looks fine.' },
              { id: 'policy', decision: 'deny', reason: 'Slippage exceeds saved policy.' },
              { id: 'protocol', decision: 'needs_input', reason: 'Unknown aggregator.' },
            ],
          }),
        },
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-multi-agg',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Swap with mixed verdicts',
        route: 'SOL -> USDC',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '150' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check quote.'],
      },
      instruction: 'Review with multi-agent perspectives.',
      mode: 'multi',
    });

    expect(review.decision).toBe('deny');
    expect(review.reviewers).toHaveLength(4);
    expect(review.reviewers?.map((r) => r.id)).toEqual(['risk', 'quote', 'policy', 'protocol']);
    expect(review.reviewers?.find((r) => r.id === 'policy')?.label).toBe('Policy reviewer');
  });

  it('drops duplicate and unknown reviewer roles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            decision: 'approve',
            reason: 'All approved.',
            summary: 'OK.',
            evidence: {},
            reviewers: [
              { id: 'risk', decision: 'approve', reason: 'Looks safe.' },
              { id: 'risk', decision: 'deny', reason: 'Duplicate role.' },
              { id: 'unknown', decision: 'deny', reason: 'Bogus role.' },
              { id: 'quote', decision: 'approve', reason: 'Quote fine.' },
            ],
          }),
        },
      }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-multi-dedupe',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: {
        intent: 'Generic',
        route: 'A -> B',
        risk: 'Low',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.1', slippageBps: '50' },
        fields: [{ label: 'Amount', value: '0.1' }],
        safeguards: ['Check.'],
      },
      mode: 'multi',
    });

    expect(review.reviewers?.map((r) => r.id)).toEqual(['risk', 'quote']);
    expect(review.decision).toBe('approve');
  });

  it('returns a concise answer for askAboutPlan with OpenAI-compatible gateway', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        choices: [{
          message: { content: 'This is a Jupiter v6 swap via the Phoenix aggregator. Slippage cap is 0.5%.' },
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-ask',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const askResult = await planner.askAboutPlan({
      plan: {
        intent: 'Swap SOL to USDC',
        route: 'SOL -> USDC',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check quote.'],
      },
      question: 'What protocol is this?',
    });

    expect(askResult.source).toBe('ai');
    expect(askResult.answer).toContain('Jupiter');
    expect(askResult.answer.length).toBeLessThanOrEqual(802);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const messages = calls[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages?.[0]?.role).toBe('system');
    expect(messages?.[0]?.content).toContain('Solana wallet action plan');
    expect(messages?.[1]?.content).toContain('What protocol is this?');
    expect(messages?.[1]?.content).toContain('Kamino Finance');
  });

  it('rejects askAboutPlan with an empty question', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-ask-empty',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    await expect(planner.askAboutPlan({
      plan: {
        intent: 'Anything',
        route: 'A -> B',
        risk: 'Low',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { amount: '0.01' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check.'],
      },
      question: '   ',
    })).rejects.toThrow('a question is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enables OpenAI web search for current-fact approval reviews and preserves source citations', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      if (calls.length === 1) {
        return jsonResponse({
          output: [{
            type: 'message',
            content: [{
              type: 'output_text',
              text: 'Official Helium Mobile support lists the Air Plan at $15/month plus taxes and fees.',
              annotations: [{
                type: 'url_citation',
                url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
                title: 'All Things Helium Mobile FAQ',
              }],
            }],
          }],
        });
      }
      return jsonResponse({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              decision: 'approve',
              reason: 'Helium Mobile Air is currently $15/month before taxes and fees, which is under the $20 rule.',
              summary: 'Current Helium Mobile Air price is under $20.',
              evidence: {
                research: { status: 'checked' },
                findings: [
                  { label: 'Current price', value: 'Air Plan: $15/month plus taxes and fees', tone: 'good' },
                  { label: 'Threshold rule', value: '$15 is less than $20, so the agent approves sending for wallet approval.', tone: 'good' },
                ],
              },
            }),
            annotations: [{
              type: 'url_citation',
              url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
              title: 'All Things Helium Mobile FAQ',
            }],
          }],
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai-research',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'Can you check how much $ per month helium mobile phone plan is currently? If it is less than $20 approve payment and if more then deny.',
    });

    expect(review.decision).toBe('approve');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
    ]));
    expect(calls[0]?.body.include).toEqual(['web_search_call.action.sources']);
    expect(calls[1]?.body.tools).toBeUndefined();
    expect(calls[1]?.body.text).toMatchObject({
      format: { type: 'json_schema', name: 'agentic_ai_review' },
    });
    expect(review.evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
        title: 'All Things Helium Mobile FAQ',
      }),
    ]));
  });

  it('returns needs_input without calling unsupported gateways when current-fact review needs research', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openrouter-research',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/auto',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'Check the current monthly Helium Mobile price and approve if under $20, deny if over $20.',
    });

    expect(review.decision).toBe('needs_input');
    expect(review.reason).toContain('native web-search path');
    expect(review.evidence).toMatchObject({
      research: { status: 'unavailable', required: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enables Anthropic web search for current-fact approval reviews', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (calls.length === 1) {
        return jsonResponse({
          content: [{
            type: 'text',
            text: 'Official Helium Mobile support lists the Infinity Plan at $30/month plus taxes and fees.',
            citations: [{
              url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
              title: 'All Things Helium Mobile FAQ',
            }],
          }],
        });
      }
      return jsonResponse({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: 'deny',
            reason: 'The researched monthly price is $30, which is over the $20 rule.',
            summary: 'Price is over the user threshold.',
            evidence: {
              research: { status: 'checked' },
              findings: [{ label: 'Current price', value: 'Infinity Plan: $30/month plus taxes and fees', tone: 'fail' }],
              sources: [{ title: 'All Things Helium Mobile FAQ', url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq' }],
            },
          }),
          citations: [{
            url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
            title: 'All Things Helium Mobile FAQ',
          }],
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-anthropic-research',
      provider: 'anthropic',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'Check the current monthly Helium Mobile price and approve if under $20, deny if over $20.',
    });

    expect(review.decision).toBe('deny');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.tools).toEqual([expect.objectContaining({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3,
    })]);
    expect(calls[1]?.body.tools).toBeUndefined();
    expect(JSON.stringify(calls[1]?.body.messages)).toContain('researchEvidence');
    expect(review.evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq' }),
    ]));
  });

  it('does not convert malformed researched reviews into fallback denials', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (calls.length === 1) {
        return jsonResponse({
          content: [{
            type: 'text',
            text: 'Official Helium Mobile support lists the Air Plan at $15/month plus taxes and fees.',
            citations: [{
              url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
              title: 'All Things Helium Mobile FAQ',
            }],
          }],
        });
      }
      return jsonResponse({
        content: [{
          type: 'text',
          text: 'The current price appears to be under $20.',
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-anthropic-research-malformed',
      provider: 'anthropic',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'Check the current monthly Helium Mobile price and approve if under $20, deny if over $20.',
    });

    expect(review.decision).toBe('needs_input');
    expect(review.reason).toContain('structured approval decision');
    expect(review.reason).not.toContain('Denied by the configured agent review');
    expect(review.evidence).toMatchObject({
      parseError: 'missing_or_invalid_review_json',
    });
    expect(review.evidence.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq' }),
    ]));
  });

  it('corrects internally contradictory threshold decisions after model review', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (calls.length === 1) {
        return jsonResponse({
          content: [{
            type: 'text',
            text: 'Helium Mobile Air Plan costs $16.79 including taxes/fees.',
            citations: [{
              url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
              title: 'All Things Helium Mobile FAQ',
            }],
          }],
        });
      }
      return jsonResponse({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: 'deny',
            reason: 'Helium Mobile\'s cheapest monthly plan (Air Plan) costs $16.79 including taxes/fees, which exceeds the $20 threshold when total cost is considered.',
            summary: 'The model denied even though it found a price below the threshold.',
            evidence: {
              research: { status: 'checked' },
              findings: [
                { label: 'Current price', value: 'Air Plan: $16.79 including taxes/fees', tone: 'neutral' },
                { label: 'Threshold rule', value: '$16.79 exceeds $20, so deny.', tone: 'fail' },
              ],
            },
          }),
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-anthropic-threshold-correction',
      provider: 'anthropic',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-1',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: 'Check if helium mobile monthly plan is under $20. If it is approve swap. if it isn\'t deny it with reason. Regardless return monthly plan rate.',
    });

    expect(calls).toHaveLength(2);
    expect(review.decision).toBe('approve');
    // The reconciler now includes the source sentence in the corrected reason; assert on
    // the load-bearing tokens (the figure and the relation) rather than the boilerplate.
    expect(review.reason).toContain('$16.79');
    expect(review.reason).toContain('under $20');
    expect(review.evidence.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Threshold check',
        value: expect.stringContaining('Original decision was deny'),
        tone: 'good',
      }),
    ]));
  });

  it('uses OpenAI Responses web search for current-fact ask questions', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return jsonResponse({
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Helium Mobile lists the Air Plan at $15/month plus taxes and fees.',
            annotations: [{
              type: 'url_citation',
              url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
              title: 'All Things Helium Mobile FAQ',
            }],
          }],
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openai-ask-research',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });

    const result = await planner.askAboutPlan({
      plan: transferPlan(),
      question: 'How much does Helium Mobile cost per month currently?',
    });

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
    ]));
    expect(result.answer).toContain('$15/month');
    expect(result.citations?.[0]).toMatchObject({
      kind: 'url',
      ref: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
      title: 'All Things Helium Mobile FAQ',
    });
  });

  it('caps askAboutPlan answers at 800 characters', async () => {
    const longText = 'x '.repeat(1200);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: longText } }],
    })));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-ask-cap',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
    });

    const askResult = await planner.askAboutPlan({
      plan: {
        intent: 'Swap SOL to USDC',
        route: 'SOL -> USDC',
        risk: 'Medium',
        approval: 'Wallet approval required.',
        source: 'template',
        category: 'trading',
        actionType: 'swap',
        templateTitle: 'Swap tokens',
        parameters: { inputToken: 'SOL', outputToken: 'USDC', amount: '0.01', slippageBps: '50' },
        fields: [{ label: 'Amount', value: '0.01' }],
        safeguards: ['Check quote.'],
      },
      question: 'Why is this risky?',
    });

    expect(askResult.answer.length).toBeLessThanOrEqual(802);
    expect(askResult.answer.endsWith('...')).toBe(true);
  });
});

describe('threshold reconciliation across providers and phrasings', () => {
  beforeEach(() => {
    vi.stubEnv('AGENTIC_AI_ALLOW_CUSTOM_BASE_URL', '1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  type ThresholdFixture = {
    name: string;
    instruction: string;
    research: string;
    reviewJson: Record<string, unknown>;
    expectedDecision: 'approve' | 'deny' | 'needs_input';
    expectedFactValue?: string;
  };

  const HELIUM_INSTRUCTION =
    "Check if helium mobile monthly plan is under $20. If it is approve swap. if it isn't deny it with reason. Regardless return monthly plan rate.";

  const fixtures: ThresholdFixture[] = [
    {
      name: 'air-plan phrasing (model denies wrongly)',
      instruction: HELIUM_INSTRUCTION,
      research: 'Helium Mobile Air Plan costs $16.79 including taxes/fees.',
      reviewJson: {
        decision: 'deny',
        reason: 'Air Plan: $16.79 monthly. Above threshold.',
        summary: 'Model thinks above threshold.',
        evidence: {
          findings: [
            { label: 'Air Plan', value: '$16.79 monthly', tone: 'neutral' },
          ],
        },
      },
      expectedDecision: 'approve',
      expectedFactValue: '$16.79',
    },
    {
      name: 'slash-mo phrasing in research summary',
      instruction: HELIUM_INSTRUCTION,
      research: 'Helium Mobile starts at $16.79/mo for the entry-level plan.',
      reviewJson: {
        decision: 'deny',
        reason: 'Pricing seems too high.',
        summary: 'Above threshold.',
        evidence: {
          findings: [
            { label: 'Plan rate', value: '$16.79', tone: 'neutral' },
          ],
        },
      },
      expectedDecision: 'approve',
      expectedFactValue: '$16.79',
    },
    {
      name: 'rate-word phrasing without structured finding',
      instruction: HELIUM_INSTRUCTION,
      research: 'The current rate is $16.79 for monthly service.',
      reviewJson: {
        decision: 'deny',
        reason: 'Current rate is $16.79 monthly.',
        summary: 'Looks like it goes over the rule.',
        evidence: {
          findings: [],
        },
      },
      expectedDecision: 'approve',
      expectedFactValue: '$16.79',
    },
    {
      name: 'subscription-word phrasing',
      instruction: HELIUM_INSTRUCTION,
      research: 'Subscription costs $16.79 monthly.',
      reviewJson: {
        decision: 'deny',
        reason: 'Subscription costs $16.79 monthly. Exceeds threshold.',
        summary: 'Above threshold.',
        evidence: { findings: [] },
      },
      expectedDecision: 'approve',
      expectedFactValue: '$16.79',
    },
    {
      name: 'structured finding has price (label-only price)',
      instruction: HELIUM_INSTRUCTION,
      research: 'Helium Mobile entry-level plan.',
      reviewJson: {
        decision: 'deny',
        reason: 'Above threshold in my view.',
        summary: 'Denied.',
        evidence: {
          findings: [
            { label: 'Plan rate', value: '$16.79/month', tone: 'neutral' },
          ],
        },
      },
      expectedDecision: 'approve',
      expectedFactValue: '$16.79',
    },
    {
      name: 'over-threshold model approves wrongly',
      instruction: HELIUM_INSTRUCTION,
      research: 'Helium Mobile current plan is $29.99 per month.',
      reviewJson: {
        decision: 'approve',
        reason: 'Looks fine.',
        summary: 'Approving.',
        evidence: {
          findings: [
            { label: 'Plan rate', value: '$29.99/month', tone: 'neutral' },
          ],
        },
      },
      expectedDecision: 'deny',
      expectedFactValue: '$29.99',
    },
    {
      name: 'no extractable price demotes to needs_input',
      instruction: HELIUM_INSTRUCTION,
      research: 'Helium Mobile offers multiple plans depending on usage.',
      reviewJson: {
        decision: 'deny',
        reason: 'Insufficient information about pricing tier.',
        summary: 'Cannot decide.',
        evidence: { findings: [] },
      },
      expectedDecision: 'needs_input',
    },
  ];

  type ProviderConfig = {
    label: string;
    provider: string;
    apiFormat: 'anthropic' | 'openai-compatible';
    baseUrl: string;
    model: string;
    buildResponses: (fixture: ThresholdFixture) => Array<unknown>;
  };

  const heliumCitation = {
    url: 'https://support.hellohelium.com/en/articles/7039213-all-things-helium-mobile-faq',
    title: 'All Things Helium Mobile FAQ',
  };

  const providers: ProviderConfig[] = [
    {
      label: 'anthropic',
      provider: 'anthropic',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-1',
      buildResponses: (fixture) => [
        {
          content: [{
            type: 'text',
            text: fixture.research,
            citations: [heliumCitation],
          }],
        },
        {
          content: [{
            type: 'text',
            text: JSON.stringify(fixture.reviewJson),
          }],
        },
      ],
    },
    {
      label: 'openai-responses (gpt-5)',
      provider: 'openai',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      buildResponses: (fixture) => [
        {
          output: [{
            type: 'message',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: fixture.research,
              annotations: [{ type: 'url_citation', ...heliumCitation }],
            }],
          }],
          status: 'completed',
        },
        {
          output: [{
            type: 'message',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: JSON.stringify(fixture.reviewJson),
            }],
          }],
          status: 'completed',
        },
      ],
    },
  ];

  for (const provider of providers) {
    for (const fixture of fixtures) {
      it(`${provider.label}: ${fixture.name}`, async () => {
        const responses = provider.buildResponses(fixture);
        let callIndex = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
          const body = responses[callIndex] ?? responses[responses.length - 1];
          callIndex += 1;
          return jsonResponse(body);
        }));

        const planner = new BridgeAiPlanner();
        planner.setSessionKey({
          apiKey: 'sk-test-threshold',
          provider: provider.provider,
          apiFormat: provider.apiFormat,
          baseUrl: provider.baseUrl,
          model: provider.model,
        });

        const review = await planner.reviewPlan({
          plan: transferPlan(),
          instruction: fixture.instruction,
        });

        expect(review.decision).toBe(fixture.expectedDecision);

        const findings = Array.isArray(review.evidence?.findings) ? review.evidence.findings : [];
        const labels = findings
          .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
          .map((entry) => String(entry.label ?? ''));

        if (fixture.expectedDecision === 'needs_input' && !fixture.expectedFactValue) {
          expect(labels).toContain('Threshold check');
          expect(review.questions ?? []).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: 'agent_review_threshold_fact' }),
            ]),
          );
          return;
        }

        const factEntry = findings.find((entry): entry is Record<string, unknown> => {
          if (!entry || typeof entry !== 'object') return false;
          const value = typeof (entry as Record<string, unknown>).value === 'string'
            ? (entry as Record<string, unknown>).value as string
            : '';
          return Boolean(fixture.expectedFactValue && value.includes(fixture.expectedFactValue));
        });
        expect(factEntry, `expected a finding containing ${fixture.expectedFactValue}`).toBeDefined();
        expect(labels).toContain('Threshold check');
      });
    }
  }

  it('openai-compatible (gemini/openrouter) without native research pre-empts with needs_input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-openrouter',
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: HELIUM_INSTRUCTION,
    });

    expect(review.decision).toBe('needs_input');
    expect(review.evidence?.research).toMatchObject({ status: 'unavailable' });
  });

  it('always appends the Plan rate finding even when model already had a matching decision', async () => {
    let anthropicCall = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      anthropicCall += 1;
      if (anthropicCall === 1) {
        return jsonResponse({
          content: [{ type: 'text', text: 'Plan rate is $16.79/month from official site.' }],
        });
      }
      return jsonResponse({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision: 'approve',
            reason: 'Plan rate is $16.79 which is under the $20 rule.',
            summary: 'Approved by model.',
            evidence: {
              findings: [
                { label: 'Plan rate', value: '$16.79/month', tone: 'good' },
              ],
            },
          }),
        }],
      });
    }));
    const planner = new BridgeAiPlanner();
    planner.setSessionKey({
      apiKey: 'sk-test-already-correct',
      provider: 'anthropic',
      apiFormat: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-opus-4-1',
    });

    const review = await planner.reviewPlan({
      plan: transferPlan(),
      instruction: HELIUM_INSTRUCTION,
    });

    expect(review.decision).toBe('approve');
    const findings = Array.isArray(review.evidence?.findings) ? review.evidence.findings : [];
    const planRateEntries = findings.filter((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== 'object') return false;
      return String((entry as Record<string, unknown>).label ?? '').toLowerCase() === 'plan rate';
    });
    expect(planRateEntries).toHaveLength(1);
    expect(String((planRateEntries[0] as Record<string, unknown>).value ?? '')).toContain('$16.79');
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

function transferPlan() {
  return {
    intent: 'Send 0.01 SOL if the user rule passes',
    route: '0.01 SOL to 6QcqZJBYxuwu1i6A.',
    risk: 'Medium',
    approval: 'Wallet approval required after agent review.',
    source: 'ai' as const,
    category: 'payments',
    actionType: 'transfer_sol',
    templateTitle: 'Send SOL',
    parameters: { recipient: '6QcqZJBYxuwu1i6A', amount: '0.01' },
    fields: [{ label: 'Amount', value: '0.01 SOL' }],
    safeguards: ['Confirm recipient.'],
  };
}

function expectAdditionalPropertiesClosed(node: unknown, path: string): void {
  if (!node || typeof node !== 'object') return;
  const schema = node as Record<string, unknown>;
  if (schema.type === 'object') {
    expect(
      schema.additionalProperties,
      `${path}: every object node must declare additionalProperties: false for OpenAI strict structured output`,
    ).toBe(false);
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      expectAdditionalPropertiesClosed(child, `${path}.${key}`);
    }
  }
  if (schema.items) {
    expectAdditionalPropertiesClosed(schema.items, `${path}[]`);
  }
  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        expectAdditionalPropertiesClosed(branch, `${path}.${combinator}[${index}]`);
      });
    }
  }
}
