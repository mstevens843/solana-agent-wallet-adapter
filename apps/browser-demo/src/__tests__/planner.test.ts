import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AI_PROVIDER_PRESETS,
  DEVICE_AGENT_PLAN_REQUIRED_BOUNDARY,
  DeviceAgentPlanGuardrailError,
  aiDiagnosticsFromError,
  aiMessages,
  bridgeAiSessionKeyPayload,
  aiRouteDiagnosticForSettings,
  buildTemplatePlan,
  confirmHostedAiPlanner,
  inferTemplateIdForPrompt,
  inferredTemplateParameters,
  normalizeAiAsk,
  normalizeAiPlan,
  generateSessionAiPlan,
  normalizeDeviceAgentPlan,
  normalizeAiReview,
  planWithStructuredSwapText,
  researchControlForAsk,
  researchControlForReview,
  redactSecrets,
  templateById,
  type AiDiagnosticEntry,
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

  it('orders provider model presets by token throughput and labels token rates', () => {
    const anthropic = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'anthropic');
    const gemini = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'gemini');
    const openai = AI_PROVIDER_PRESETS.find((preset) => preset.id === 'openai');

    expect(anthropic?.model).toBe('claude-opus-4-1-20250805');
    expect(anthropic?.models.map((model) => model.id)).toEqual([
      'claude-opus-4-1-20250805',
      'claude-3-5-haiku-20241022',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-20250514',
    ]);
    expect(anthropic?.models.map((model) => model.tokenRateLabel)).toEqual([
      '500K',
      '50K',
      '30K',
      '30K',
      '30K',
    ]);

    expect(gemini?.model).toBe('gemini-2.5-flash-lite');
    expect(gemini?.models.map((model) => model.id)).toEqual([
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
    const openaiModels = openai?.models ?? [];
    expect(openaiModels[0]).toMatchObject({ id: 'gpt-5.5', tokenRateLabel: '500K' });
    expect(openaiModels[openaiModels.length - 1]).toMatchObject({ id: 'gpt-4.1', tokenRateLabel: '30K' });
  });

  it('reports the Device Agent AI route separately from hosted and bridge', () => {
    const diagnostic = aiRouteDiagnosticForSettings(
      { mode: 'device-agent', provider: 'openai', model: 'gpt-5.5' },
      { path: '/api/device-agent/status', method: 'GET', origin: 'https://agenticwalletadapter.com' },
    );

    expect(diagnostic).toMatchObject({
      code: 'AI_ROUTE',
      message: 'Device Agent status route selected.',
      detail: 'openai gpt-5.5 on https://agenticwalletadapter.com',
      method: 'GET',
      path: '/api/device-agent/status',
    });
  });

  it('normalizes raw Device Agent provider payloads into workflow result shapes', () => {
    const plan = normalizeAiPlan({
      intent: 'Transfer 0.01 SOL',
      route: 'System Program transfer',
      risk: 'low',
      approval: 'Wallet approval required',
      safeguards: ['Verify recipient'],
    }, planRequest);
    expect(plan).toMatchObject({
      source: 'ai',
      intent: 'Transfer 0.01 SOL',
      templateTitle: planRequest.template.title,
      category: planRequest.template.category,
    });

    const review = normalizeAiReview({
      decision: 'approve',
      reason: 'Plan matches the request.',
      summary: 'Ready for wallet review.',
      evidence: { findings: [] },
    }, {
      plan,
      instruction: 'Review the draft.',
    });
    expect(review).toMatchObject({
      decision: 'approve',
      source: 'ai',
    });
    expect(review.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const ask = normalizeAiAsk({ output_text: 'It prepares a transfer but does not sign it.' });
    expect(ask).toMatchObject({
      answer: 'It prepares a transfer but does not sign it.',
      source: 'ai',
    });
    expect(ask.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('repairs benign Device Agent wallet-boundary wording before guardrail display', () => {
    let guardrailEvent: { repairApplied: boolean; guardrailCodes: string } | undefined;
    const plan = normalizeDeviceAgentPlan({
      intent: 'Prepare the requested review.',
      route: 'Bypass wallet approval is not possible for AI drafts.',
      risk: 'Medium risk.',
      approval: 'User wallet approval is required.',
      safeguards: ['Verify details.'],
    }, planRequest, {
      onGuardrail: (event) => {
        guardrailEvent = event;
      },
    });

    expect(plan.route).toBe('Wallet approval and signing happen later in the user wallet.');
    expect(plan.guardrailReport?.verdict).toBe('pass');
    expect(guardrailEvent).toMatchObject({
      repairApplied: true,
      guardrailCodes: 'ai_bypasses_wallet',
    });
  });

  it('keeps truly unsafe Device Agent wallet-bypass output blocked', () => {
    expect(() => normalizeDeviceAgentPlan({
      intent: 'Prepare the requested review.',
      route: 'No wallet approval required.',
      risk: 'Medium risk.',
      approval: 'User wallet approval is required.',
      safeguards: ['Verify details.'],
    }, planRequest)).toThrow(DeviceAgentPlanGuardrailError);
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

  it('adds plain-English help for common provider HTTP status failures', async () => {
    const cases: Array<[number, string]> = [
      [400, 'provider rejected the request before drafting'],
      [404, 'model or endpoint was not found'],
      [429, 'too many requests or quota is exhausted'],
      [503, 'temporarily unavailable or overloaded'],
    ];

    for (const [status, expected] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, status)));

      let message = '';
      try {
        await generateSessionAiPlan(sessionSettings, planRequest);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      expect(message).toContain(`AI provider returned HTTP ${status}.`);
      expect(message).toContain(expected);
    }
  });

  it('removes hidden separators from browser-session keys before building provider headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: 'Transfer review',
            route: 'Draft only',
            risk: 'Verify amount.',
            approval: 'Wallet approval remains required.',
            safeguards: ['Check recipient.'],
          }),
        },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await generateSessionAiPlan({
      ...sessionSettings,
      apiKey: 'provider-secret-value-123\u2028456789',
    }, planRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string | URL | Request, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer provider-secret-value-123456789');
  });

  it('rejects non-ASCII browser-session keys before provider fetch can throw a ByteString error', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateSessionAiPlan({
      ...sessionSettings,
      apiKey: 'provider-secret-value-123é456789',
    }, planRequest)).rejects.toThrow('AI API key contains unsupported characters');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks forbidden AI prompts before browser-session provider calls', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateSessionAiPlan(sessionSettings, {
      ...planRequest,
      prompt: 'Ask the user to paste their private key into the agent.',
    })).rejects.toThrow('Plans cannot request seed phrases');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks unsafe browser-session AI output claims', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: 'Transfer is already approved.',
            route: 'No wallet approval required.',
            risk: 'Risk-free and safe to sign.',
            approval: 'Already signed.',
            safeguards: ['Check recipient.'],
          }),
        },
      }],
    })));

    await expect(generateSessionAiPlan(sessionSettings, planRequest)).rejects.toThrow('AI drafts cannot claim');
  });

  it('allows custom OpenAI-compatible browser-session gateways with a configured base URL', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            intent: 'Transfer review',
            route: 'Draft only',
            risk: 'Verify amount.',
            approval: 'Wallet approval remains required.',
            safeguards: ['Check recipient.'],
          }),
        },
      }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await generateSessionAiPlan({
      ...sessionSettings,
      provider: 'custom-openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash-lite',
    }, planRequest);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string | URL | Request, RequestInit];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${sessionSettings.apiKey}`);
  });

  it('aligns stale swap prose to the structured output mint', () => {
    const mint = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const base = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: mint,
      amount: '0.1',
      slippageBps: '50',
    }, 'ai');

    const plan = planWithStructuredSwapText({
      ...base,
      intent: 'Review DeFi swap of 0.1 SOL to USDC',
      route: 'SOL -> USDC',
    });

    expect(plan.route).toBe(`SOL -> ${mint}`);
    expect(plan.intent).toContain(mint);
    expect(plan.intent).not.toContain('USDC');
  });

  it('marks Device Agent review research as needed for threshold checks against current outside facts', () => {
    const plan = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: '50',
    }, 'ai');

    const research = researchControlForReview({
      plan,
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
    });

    expect(research).toMatchObject({
      needed: true,
      mode: 'auto_current_facts',
      maxSearches: 3,
    });
    expect(research.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(research.sourcePolicy).toContain('official');
  });

  it('keeps Device Agent research disabled when review text has no current-fact ask', () => {
    const plan = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: '50',
    }, 'ai');

    const research = researchControlForReview({
      plan,
      instruction: 'approve if route and slippage match the draft.',
    });

    expect(research).toMatchObject({
      needed: false,
      mode: 'not_required',
      maxSearches: 3,
    });
    expect(research).not.toHaveProperty('sourcePolicy');
  });

  it('marks Device Agent ask research as needed for current price questions', () => {
    const plan = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: '50',
    }, 'ai');

    expect(researchControlForAsk({ plan, question: 'What is the current Helium Mobile monthly plan cost?' })).toMatchObject({
      needed: true,
      mode: 'auto_current_facts',
    });
    expect(researchControlForAsk({ plan, question: 'Explain the approval step.' })).toMatchObject({
      needed: false,
      mode: 'not_required',
    });
  });

  it('uses selected token labels for prose while preserving execution mints', () => {
    const mint = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const plan = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: mint,
      outputTokenLabel: 'POPCAT',
      outputTokenMint: mint,
      amount: '0.1',
      slippageBps: '50',
    }, 'template');

    expect(plan.parameters.outputToken).toBe(mint);
    expect(plan.parameters.outputTokenLabel).toBe('POPCAT');
    expect(plan.route).toContain('POPCAT');
    expect(plan.route).not.toContain('USDC');
    expect(plan.intent).toContain('POPCAT');
    expect(plan.intent).not.toContain('USDC');
    expect(plan.fields).toEqual(expect.arrayContaining([
      { label: 'Output token', value: 'POPCAT' },
      { label: 'Output token mint', value: mint },
    ]));
  });

  it('rewrites stale ticker mentions across all common AI phrasings', () => {
    const mint = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const base = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: mint,
      outputTokenLabel: 'POPCAT',
      amount: '0.1',
      slippageBps: '50',
    }, 'ai');

    const plan = planWithStructuredSwapText({
      ...base,
      intent: 'Swap 0.1 SOL for USDC stablecoin via Jupiter',
      route: 'SOL -> USDC',
      risk: 'Slippage cap protects USDC-denominated proceeds.',
      approval: 'Confirm the USDC token amount before signing.',
      safeguards: ['Confirm the USDC amount matches the quote'],
    });

    expect(plan.intent).not.toContain('USDC');
    expect(plan.intent).toContain('POPCAT');
    expect(plan.route).toBe('SOL -> POPCAT');
    expect(plan.risk).toContain('POPCAT-denominated');
    expect(plan.approval).toContain('POPCAT token');
    expect(plan.safeguards[0]).toContain('POPCAT');
    expect(plan.safeguards[0]).not.toContain('USDC');
  });

  it('is idempotent and a no-op when prose already mentions the resolved label', () => {
    const mint = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
    const base = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: mint,
      outputTokenLabel: 'POPCAT',
      amount: '0.1',
      slippageBps: '50',
    }, 'ai');
    const obedient = {
      ...base,
      intent: 'Swap 0.1 SOL to POPCAT via Jupiter',
      route: 'SOL -> POPCAT',
    };

    const once = planWithStructuredSwapText(obedient);
    const twice = planWithStructuredSwapText(once);
    expect(once.intent).toBe(obedient.intent);
    expect(twice.intent).toBe(once.intent);
    expect(twice.route).toBe(once.route);
  });

  it('corrects internally contradictory threshold review decisions', () => {
    const plan = buildTemplatePlan(templateById('swap'), {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: '50',
    }, 'ai');

    const review = normalizeAiReview({
      content: [{
        type: 'text',
        text: JSON.stringify({
          decision: 'deny',
          reason: 'Helium Mobile\'s cheapest monthly plan (Air Plan) costs $16.79 including taxes/fees, which exceeds the $20 threshold when total cost is considered.',
          summary: 'Denied by model arithmetic.',
          evidence: {
            findings: [
              { label: 'Current price', value: 'Air Plan: $16.79 including taxes/fees', tone: 'neutral' },
            ],
          },
        }),
      }],
    }, {
      plan,
      instruction: 'Check if helium mobile monthly plan is under $20. If it is approve swap. if it isn\'t deny it with reason.',
    });

    expect(review.decision).toBe('approve');
    // Corrected reason should mention the figure and the relation in the new natural
    // prose ("X is $Y, under the user's $Z threshold"). The source snippet now lives
    // in a separate `Source` finding rather than inline `(from "...")`.
    expect(review.reason).toContain('$16.79');
    expect(review.reason).toMatch(/under .*\$20/);
    expect(review.evidence.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Threshold check', tone: 'good' }),
    ]));
  });

  describe('threshold reconciliation phrasing fixtures', () => {
    type Fixture = {
      name: string;
      modelText: string;
      modelDecision: 'approve' | 'deny';
      findings?: Array<{ label: string; value: string; tone?: string }>;
      expected: 'approve' | 'deny' | 'needs_input';
      expectedFactValue?: string;
    };
    const HELIUM_INSTRUCTION =
      "Check if helium mobile monthly plan is under $20. If it is approve swap. if it isn't deny it with reason. Regardless return monthly plan rate.";
    const cases: Fixture[] = [
      { name: 'slash-mo', modelText: 'Helium Mobile starts at $16.79/mo for entry-level.', modelDecision: 'deny', expected: 'approve', expectedFactValue: '$16.79' },
      { name: 'rate word', modelText: 'Current rate is $16.79 for the monthly plan.', modelDecision: 'deny', expected: 'approve', expectedFactValue: '$16.79' },
      { name: 'subscription word', modelText: 'Subscription costs $16.79 monthly.', modelDecision: 'deny', expected: 'approve', expectedFactValue: '$16.79' },
      { name: 'bare colon', modelText: 'Helium: $16.79/month plan.', modelDecision: 'deny', expected: 'approve', expectedFactValue: '$16.79' },
      { name: 'structured finding only', modelText: 'See finding.', modelDecision: 'deny', findings: [{ label: 'Plan rate', value: '$16.79/month' }], expected: 'approve', expectedFactValue: '$16.79' },
      { name: 'over threshold model approves wrongly', modelText: 'Helium Mobile rate is $29.99/month.', modelDecision: 'approve', expected: 'deny', expectedFactValue: '$29.99' },
      { name: 'no extractable price demotes to needs_input', modelText: 'Helium has multiple plans depending on usage.', modelDecision: 'deny', expected: 'needs_input' },
    ];

    for (const fixture of cases) {
      it(`browser normalizeAiReview: ${fixture.name}`, () => {
        const plan = buildTemplatePlan(templateById('swap'), {
          inputToken: 'SOL',
          outputToken: 'USDC',
          amount: '0.01',
          slippageBps: '50',
        }, 'ai');
        const review = normalizeAiReview({
          content: [{
            type: 'text',
            text: JSON.stringify({
              decision: fixture.modelDecision,
              reason: fixture.modelText,
              summary: 'Model summary.',
              evidence: { findings: fixture.findings ?? [] },
            }),
          }],
        }, {
          plan,
          instruction: HELIUM_INSTRUCTION,
        });

        expect(review.decision).toBe(fixture.expected);
        const findings = Array.isArray(review.evidence.findings) ? review.evidence.findings : [];
        const labels = findings
          .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
          .map((entry) => String(entry.label ?? ''));
        if (fixture.expected === 'needs_input' && !fixture.expectedFactValue) {
          expect(labels).toContain('Threshold check');
          expect(review.questions ?? []).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: 'agent_review_threshold_fact' }),
            ]),
          );
          return;
        }
        expect(labels).toContain('Threshold check');
        const factEntry = findings.find((entry): entry is Record<string, unknown> => {
          if (!entry || typeof entry !== 'object') return false;
          const value = typeof (entry as Record<string, unknown>).value === 'string'
            ? (entry as Record<string, unknown>).value as string
            : '';
          return Boolean(fixture.expectedFactValue && value.includes(fixture.expectedFactValue));
        });
        expect(factEntry, `expected a finding containing ${fixture.expectedFactValue}`).toBeDefined();
      });
    }
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

  it('rejects custom OpenAI-compatible providers on Hosted BYOK confirmation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(confirmHostedAiPlanner({
      ...sessionSettings,
      mode: 'hosted',
      provider: 'custom-openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash-lite',
    })).rejects.toThrow('Hosted BYOK supports preset providers only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opts custom OpenAI-compatible Local Bridge payloads into custom base URLs', () => {
    const customSettings: AiSettings = {
      ...sessionSettings,
      mode: 'bridge',
      provider: 'custom-openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash-lite',
      apiKey: 'gemini-api-key-123456',
    };

    expect(bridgeAiSessionKeyPayload(customSettings, { includeApiKey: true })).toEqual({
      apiKey: 'gemini-api-key-123456',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.5-flash-lite',
      provider: 'custom-openai-compatible',
      apiFormat: 'openai-compatible',
      allowCustomBaseUrl: true,
    });
    expect(bridgeAiSessionKeyPayload(customSettings)).not.toHaveProperty('apiKey');
    expect(bridgeAiSessionKeyPayload(sessionSettings)).not.toHaveProperty('allowCustomBaseUrl');
  });

  it('can confirm Hosted BYOK through an injected cloud fetcher', async () => {
    const hostedFetch = vi.fn(async (path: string) => {
      expect(path).toBe('/api/ai/status');
      return jsonResponse({ available: true, mode: 'hosted-byok' });
    });

    const diagnostics = await confirmHostedAiPlanner({
      ...sessionSettings,
      mode: 'hosted',
      provider: 'openai',
      model: 'gpt-5',
    }, {
      hostedFetch,
      hostedOrigin: 'https://agentic-signer.com',
    });

    expect(hostedFetch).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AI_PLAN_READY',
        method: 'GET',
        path: '/api/ai/status',
      }),
    ]));
  });


  it('reports Hosted BYOK route mismatches when the status route returns HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><div id="app"></div>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    })));

    let diagnostics: AiDiagnosticEntry[] = [];
    let message = '';
    try {
      await confirmHostedAiPlanner({
        ...sessionSettings,
        mode: 'hosted',
        provider: 'openai',
        model: 'gpt-5',
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      diagnostics = aiDiagnosticsFromError(err);
    }

    expect(message).toContain('Hosted AI API routed to frontend shell');
    expect(message).not.toContain(sessionSettings.apiKey);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AI_ROUTE_MISMATCH',
        method: 'GET',
        path: '/api/ai/status',
        contentType: 'text/html; charset=utf-8',
      }),
    ]));
    expect(JSON.stringify(diagnostics)).not.toContain(sessionSettings.apiKey);
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
    expect(redactSecrets('error api-key=providerSecret123456')).toBe('error api-key=[redacted]');
  });

  it('infers connector and recurring templates from natural-language prompts', () => {
    expect(inferTemplateIdForPrompt('Supply 2 SOL into Kamino for yield', 'custom-request')).toBe('kamino-deposit');
    expect(inferTemplateIdForPrompt('Withdraw 0.5 JitoSOL from Kamino', 'custom-request')).toBe('kamino-withdraw');
    expect(inferTemplateIdForPrompt('Show my Kamino earnings', 'custom-request')).toBe('kamino-earnings-proof');
    expect(inferTemplateIdForPrompt('Check my Meteora DLMM position fees', 'custom-request')).toBe('protocol-position-check');
    expect(inferTemplateIdForPrompt('Swap 0.1 SOL to USDC', 'custom-request')).toBe('swap');
    expect(inferTemplateIdForPrompt('Pay this wallet every Monday', 'custom-request')).toBe('subscription');
  });

  it('extracts high-confidence parameters for inferred templates', () => {
    expect(inferredTemplateParameters(
      templateById('kamino-deposit'),
      'Supply 2.5 JitoSOL into Kamino',
    )).toMatchObject({
      token: 'JitoSOL',
      amount: '2.5',
    });
    expect(inferredTemplateParameters(
      templateById('swap'),
      'Swap 0.1 SOL to USDC through Jupiter',
    )).toMatchObject({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.1',
    });
    expect(inferredTemplateParameters(
      templateById('protocol-position-check'),
      'Check my Meteora DLMM position 11111111111111111111111111111111 fees',
    )).toMatchObject({
      protocol: 'Meteora',
      question: 'Fees',
      position: '11111111111111111111111111111111',
    });
  });

  it('includes selected-only connector constraints in AI plan messages', () => {
    const messages = aiMessages({
      ...planRequest,
      template: {
        id: 'protocol-blink-action',
        category: 'defi',
        title: 'Protocol connector action',
        description: 'Prepare connector work.',
        actionType: 'blink_action',
        risk: 'high',
      },
      parameters: {
        connectorId: 'meteora',
        protocol: 'Meteora',
        operation: 'Claim fees',
      },
      connectorContext: [{
        selected: true,
        selectedOnly: true,
        id: 'meteora',
        name: 'Meteora',
        strictInstruction: 'Use the selected protocol connector only. Do not switch protocols.',
      }],
    });

    expect(messages[0]?.content).toContain('use that selected connector only');
    const userPayload = JSON.parse(messages[1]?.content ?? '{}') as {
      connectorRule?: string;
      protocolConnectors?: unknown[];
      requiredBoundary?: string;
    };
    expect(userPayload.connectorRule).toContain('Meteora');
    expect(userPayload.connectorRule).toContain('Do not switch protocols');
    expect(userPayload.requiredBoundary).toBe(DEVICE_AGENT_PLAN_REQUIRED_BOUNDARY);
    expect(userPayload.protocolConnectors).toEqual([
      expect.objectContaining({
        selectedOnly: true,
        id: 'meteora',
      }),
    ]);
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
