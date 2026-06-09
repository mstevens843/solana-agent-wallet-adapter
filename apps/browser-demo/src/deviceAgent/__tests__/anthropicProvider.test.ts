// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/AnthropicProviderTest.kt
// with one inverted assertion: the browser-native provider MUST send
// anthropic-dangerous-direct-browser-access: 'true' (Kotlin asserts its
// absence; we assert its presence because Anthropic's CORS policy blocks
// browser requests without it).

import { describe, expect, it } from 'vitest';

import { buildPlanMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { AnthropicProvider } from '../provider/anthropicProvider.js';
import { ProviderHttpError } from '../provider/errorCodes.js';

import { FakeHttpExecutor } from './fakeHttpExecutor.helper.js';

function config(model = 'claude-opus-4-5'): RuntimeConfig {
  return {
    provider: 'anthropic',
    apiFormat: 'anthropic',
    model,
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test-ABCDEFGHIJKLMNOP',
  };
}

describe('AnthropicProvider.generatePlan', () => {
  it('sends the system + user roles, anthropic-version, x-api-key, and the browser-direct header', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        content: [
          {
            type: 'text',
            text:
              '{"intent":"swap","route":"jupiter","risk":"low","approval":"once","safeguards":["check slippage"]}',
          },
        ],
      }),
    );
    const provider = new AnthropicProvider(config(), http);
    const result = await provider.generatePlan({ userPrompt: 'swap 1 SOL' });

    expect(result.intent).toBe('swap');
    expect(http.calls.length).toBe(1);
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test-ABCDEFGHIJKLMNOP');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    // The deliberate browser divergence — Kotlin asserts the absence; we assert presence.
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-4-5');
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.PLAN);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0]!.role).toBe('user');
    expect('tools' in body).toBe(false);
    expect('response_format' in body).toBe(false);
  });

  it('user content matches the Phase 4 message assembler output exactly', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ content: [{ type: 'text', text: '{"intent":"x"}' }] }));
    const provider = new AnthropicProvider(config(), http);
    const payload = { userPrompt: 'swap 1 SOL', userNotes: 'make it fast' };
    await provider.generatePlan(payload);

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe(buildPlanMessages(payload).userContent);
  });

  it('429 → ProviderHttpError(provider_rate_limited)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(429, '{"error":{"message":"rate limit"}}');
    const provider = new AnthropicProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_rate_limited');
  });

  it('403 surfaces the upstream message intact (executor handles redaction)', async () => {
    const http = new FakeHttpExecutor();
    const key = 'sk-ant-test-ABCDEFGHIJKLMNOP';
    http.queueResponse(
      403,
      `{"type":"error","error":{"type":"forbidden","message":"key ${key} not allowed"}}`,
    );
    const provider = new AnthropicProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_auth');
    expect(err.message.includes('not allowed')).toBe(true);
  });
});

describe('AnthropicProvider.reviewPlan', () => {
  it('uses REVIEW max_tokens and sends the REVIEW system prompt verbatim', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: '{"decision":"approve","reason":"ok","summary":"go","evidence":{}}',
          },
        ],
      }),
    );
    const provider = new AnthropicProvider(config(), http);
    const result = await provider.reviewPlan({ plan: {} });

    expect(result.decision).toBe('approve');
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1800);
    expect(body.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW);
  });

  it('runs the two-pass flow when review research is needed: research call with web_search, then structured review without it', async () => {
    const http = new FakeHttpExecutor();
    // First response: research pass (web_search tool emits a research summary + citations).
    http.queueResponse(
      200,
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: 'Helium Mobile Air Plan costs $15/month per the official Helium Mobile site.',
            citations: [{ url: 'https://heliummobile.com/plans', title: 'Helium Mobile - Plans' }],
          },
        ],
      }),
    );
    // Second response: structured review consuming the research evidence.
    http.queueResponse(
      200,
      JSON.stringify({
        content: [
          {
            type: 'text',
            text: '{"decision":"approve","reason":"$15/month is under $20.","summary":"ok","evidence":{"findings":[{"label":"Monthly rate","value":"$15/month","tone":"good"}]}}',
          },
        ],
      }),
    );
    const provider = new AnthropicProvider(config(), http);
    const payload = {
      plan: {},
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-16T03:00:00.000Z', maxSearches: 2 },
    };
    const result = await provider.reviewPlan(payload);

    expect(result.decision).toBe('approve');
    expect(result.evidence).toMatchObject({
      research: { status: 'checked' },
      findings: expect.arrayContaining([
        { label: 'Current research', value: expect.stringContaining('Helium Mobile Air Plan'), tone: 'neutral' },
      ]),
      sources: expect.arrayContaining([
        { url: 'https://heliummobile.com/plans', title: 'Helium Mobile - Plans' },
      ]),
    });
    expect(http.calls).toHaveLength(2);

    // First call: research pass — web_search tool bound.
    const researchBody = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const researchTools = researchBody.tools as Array<Record<string, unknown>>;
    expect(researchTools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search', max_uses: 2 });

    // Second call: structured review — NO web_search bound (research already done).
    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    expect(reviewBody.tools).toBeUndefined();
    const reviewMessages = reviewBody.messages as Array<{ role: string; content: string }>;
    const reviewUserContent = JSON.parse(reviewMessages[0]!.content) as Record<string, unknown>;
    // Research evidence has been embedded into context for the review pass.
    expect((reviewUserContent.context as Record<string, unknown>).researchEvidence).toBeDefined();
    expect((reviewUserContent.research as Record<string, unknown>).needed).toBe(false);
    expect((reviewUserContent.research as Record<string, unknown>).mode).toBe('provided_current_facts');
  });
});

describe('AnthropicProvider.ask', () => {
  it('uses ASK max_tokens, ASK temperature, and wraps response as { output_text }', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({ content: [{ type: 'text', text: 'It swaps SOL for USDC.' }] }),
    );
    const provider = new AnthropicProvider(config(), http);
    const result = await provider.ask({ question: 'what happens?' });

    expect(result.output_text).toBe('It swaps SOL for USDC.');
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(800);
    expect(body.temperature).toBe(0.3);
    expect(body.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.ASK);
  });
});

describe('AnthropicProvider via OpenRouter (browser CORS)', () => {
  function openRouterConfig(model = 'anthropic/claude-sonnet-4.5'): RuntimeConfig {
    return {
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      model,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test-ABCDEFGHIJKLMNOP',
    };
  }

  it('sends Bearer + OpenRouter attribution headers but OMITS X-OpenRouter-Metadata for the browser CORS preflight', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ content: [{ type: 'text', text: '{"intent":"x"}' }] }));
    const provider = new AnthropicProvider(openRouterConfig(), http);
    await provider.generatePlan({ userPrompt: 'swap 1 SOL' });

    const call = http.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/messages');
    expect(call.headers.Authorization).toBe('Bearer sk-or-test-ABCDEFGHIJKLMNOP');
    // Documented OpenRouter browser headers ARE sent...
    expect(call.headers['HTTP-Referer']).toBeTruthy();
    expect(call.headers['X-Title']).toBeTruthy();
    // ...but the undocumented metadata header is omitted so it can't break the CORS preflight.
    expect('X-OpenRouter-Metadata' in call.headers).toBe(false);
    // Anthropic-direct headers are NOT sent on the OpenRouter route.
    expect('x-api-key' in call.headers).toBe(false);
    expect('anthropic-dangerous-direct-browser-access' in call.headers).toBe(false);
  });

  it('research pass binds Anthropic NATIVE web_search (NOT openrouter:web_search) on the /messages skin', async () => {
    const http = new FakeHttpExecutor();
    // Research pass: official citation present → grounded $15 answer flows through.
    http.queueResponse(200, JSON.stringify({
      content: [{
        type: 'text',
        text: 'Helium Mobile Air Plan is $15/month per the official Helium Mobile site.',
        citations: [{ url: 'https://heliummobile.com/plans', title: 'Helium Mobile - Plans' }],
      }],
    }));
    // Structured review pass.
    http.queueResponse(200, JSON.stringify({
      content: [{ type: 'text', text: '{"decision":"approve","reason":"$15 < $20","summary":"ok","evidence":{}}' }],
    }));
    const provider = new AnthropicProvider(openRouterConfig(), http);
    const result = await provider.reviewPlan({
      instruction: 'Approve only if the lowest helium monthly phone plan is less than $20',
      plan: {},
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-06-09T00:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('approve');
    expect(http.calls).toHaveLength(2);
    const researchCall = http.calls[0]!;
    expect(researchCall.url).toBe('https://openrouter.ai/api/v1/messages');
    const researchBody = JSON.parse(researchCall.body) as Record<string, unknown>;
    const tools = researchBody.tools as Array<Record<string, unknown>>;
    // The fix: native Anthropic server tool, which OpenRouter's Anthropic skin forwards to
    // Anthropic 1P. The old `openrouter:web_search` was silently dropped on /messages, leaving
    // Claude to answer ungrounded from training (the Helium "$0" bug).
    expect(tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
    expect(researchCall.body).not.toContain('openrouter:web_search');
  });

  it('pricing research with NO citations falls back to "could not be verified" (never a fabricated price)', async () => {
    const http = new FakeHttpExecutor();
    // Research pass: model produced a price from training but returned ZERO citations — exactly
    // what happens when a web-search tool silently never runs (the OpenRouter+Claude "$0").
    http.queueResponse(200, JSON.stringify({
      content: [{ type: 'text', text: "Helium's Zero Plan is $0/month." }],
    }));
    // Structured review pass.
    http.queueResponse(200, JSON.stringify({
      content: [{ type: 'text', text: '{"decision":"needs_input","reason":"confirm price","summary":"verify","evidence":{}}' }],
    }));
    const provider = new AnthropicProvider(openRouterConfig(), http);
    await provider.reviewPlan({
      instruction: 'Approve only if the lowest helium monthly phone plan is less than $20',
      plan: {},
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-06-09T00:00:00.000Z', maxSearches: 3 },
    });

    expect(http.calls).toHaveLength(2);
    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    const reviewMessages = reviewBody.messages as Array<{ role: string; content: string }>;
    const reviewUserContent = JSON.parse(reviewMessages[0]!.content) as Record<string, unknown>;
    const evidence = (reviewUserContent.context as Record<string, unknown>).researchEvidence as Record<string, unknown>;
    expect(evidence).toBeDefined();
    expect(String(evidence.summary)).toContain('could not be verified');
    // The ungrounded "$0" never reaches the review pass as a researched fact.
    expect(String(evidence.summary)).not.toContain('$0');
    expect(evidence.sources).toEqual([]);
  });
});
