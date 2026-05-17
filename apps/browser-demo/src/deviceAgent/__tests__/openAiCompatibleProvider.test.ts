// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/OpenAiCompatibleProviderTest.kt.
// Pins the OpenAI-compatible request shape (URL, Bearer header, json_object
// mode for plan/review only, gpt-5 / o-series temperature drop), and verifies
// system / user messages on the wire match the Phase 4 assembler output.

import { describe, expect, it } from 'vitest';

import { buildPlanMessages } from '../prompts/messageAssembler.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { ProviderHttpError } from '../provider/errorCodes.js';
import { OpenAiCompatibleProvider } from '../provider/openAiCompatibleProvider.js';

import { FakeHttpExecutor } from './fakeHttpExecutor.helper.js';

function config(model = 'gpt-4o-mini'): RuntimeConfig {
  return {
    provider: 'openai',
    apiFormat: 'openai-compatible',
    model,
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test-ABCDEFGHIJKLMNOP',
  };
}

describe('OpenAiCompatibleProvider.generatePlan', () => {
  it('sends json_object mode and PLAN temperature, with the system prompt verbatim', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"intent":"swap","route":"jupiter","risk":"low","approval":"once","safeguards":["check slippage"]}',
            },
          },
        ],
      }),
    );
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.generatePlan({ userPrompt: 'swap 1 SOL for USDC' });

    expect(result.intent).toBe('swap');
    expect(http.calls.length).toBe(1);
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer sk-test-ABCDEFGHIJKLMNOP');
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1024);
    const responseFormat = body.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe('json_object');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.PLAN);
    expect(messages[1]!.role).toBe('user');
  });

  it('user content matches the Phase 4 message assembler output exactly', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ choices: [{ message: { content: '{"intent":"x"}' } }] }));
    const provider = new OpenAiCompatibleProvider(config(), http);
    const payload = { userPrompt: 'swap 1 SOL', userNotes: 'make it fast' };
    await provider.generatePlan(payload);

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }>;
    const expected = buildPlanMessages(payload).userContent;
    expect(messages[1]!.content).toBe(expected);
  });

  it('omits temperature for gpt-5 family', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ choices: [{ message: { content: '{"intent":"x"}' } }] }));
    const provider = new OpenAiCompatibleProvider(config('gpt-5-turbo'), http);
    await provider.generatePlan({ userPrompt: 'hi' });

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });

  it('omits temperature for o-series', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ choices: [{ message: { content: '{"intent":"x"}' } }] }));
    const provider = new OpenAiCompatibleProvider(config('o3-mini'), http);
    await provider.generatePlan({ userPrompt: 'hi' });

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });

  it('surfaces an upstream 401 as ProviderHttpError(provider_auth) with the key still present in the raw message', async () => {
    const http = new FakeHttpExecutor();
    const key = 'sk-test-ABCDEFGHIJKLMNOP';
    http.queueResponse(401, `{"error":{"message":"Invalid key ${key} supplied"}}`);
    const provider = new OpenAiCompatibleProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_auth');
    // Redaction is the executor's job — the provider must surface the raw upstream
    // message intact so executor-layer redaction has something to scrub.
    expect(err.message.includes('Invalid key')).toBe(true);
  });

  it('maps a malformed 200 body to ProviderHttpError(provider_invalid_response)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, '{not even json');
    const provider = new OpenAiCompatibleProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });
});

describe('OpenAiCompatibleProvider.reviewPlan', () => {
  it('sends json_object mode', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"decision":"approve","reason":"ok","summary":"go","evidence":{}}',
            },
          },
        ],
      }),
    );
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.reviewPlan({ plan: { intent: 'swap' } });

    expect(result.decision).toBe('approve');
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect((body.response_format as Record<string, unknown>).type).toBe('json_object');
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW);
  });

  it('fails closed without calling provider when current research is required', async () => {
    const http = new FakeHttpExecutor();
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.reviewPlan({
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-16T03:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('needs_input');
    expect((result.evidence as Record<string, unknown>).research).toMatchObject({ status: 'unavailable', required: true });
    expect(http.calls).toHaveLength(0);
  });
});

describe('OpenAiCompatibleProvider.ask', () => {
  it('omits response_format, uses ASK temperature, wraps as { output_text }', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        choices: [{ message: { content: 'It will swap SOL for USDC via Jupiter.' } }],
      }),
    );
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.ask({ question: 'what happens?' });

    expect((result.output_text as string).startsWith('It will swap')).toBe(true);
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect('response_format' in body).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(800);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.ASK);
  });

  it('returns Responses-API style output_text when present', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, '{"output_text":"answer here from responses api"}');
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.ask({ question: 'what happens?' });

    expect(result.output_text).toBe('answer here from responses api');
  });

  it('fails closed without calling provider when current research ask is required', async () => {
    const http = new FakeHttpExecutor();
    const provider = new OpenAiCompatibleProvider(config(), http);
    const result = await provider.ask({
      question: 'what is the current price?',
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-16T03:00:00.000Z', maxSearches: 3 },
    });

    expect(result.output_text).toContain('cannot fetch current outside facts');
    expect(http.calls).toHaveLength(0);
  });
});

describe('OpenAiCompatibleProvider OpenRouter headers', () => {
  function openRouterConfig(): RuntimeConfig {
    return {
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      model: 'meta-llama/llama-3.1-70b-instruct',
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'sk-or-test-ABCDEFGHIJKLMNOP',
    };
  }

  it('sends HTTP-Referer and X-Title when provider is openrouter', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ choices: [{ message: { content: '{"intent":"x"}' } }] }));
    const provider = new OpenAiCompatibleProvider(openRouterConfig(), http);
    await provider.generatePlan({ userPrompt: 'hi' });

    const headers = http.calls[0]!.headers;
    expect(headers['HTTP-Referer']).toBeDefined();
    expect(String(headers['HTTP-Referer'])).toMatch(/^https?:\/\//);
    expect(headers['X-Title']).toBe('Agentic Browser Device Agent');
  });

  it('does NOT send HTTP-Referer or X-Title for non-openrouter providers (no origin leakage)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ choices: [{ message: { content: '{"intent":"x"}' } }] }));
    const provider = new OpenAiCompatibleProvider(config(), http);
    await provider.generatePlan({ userPrompt: 'hi' });

    const headers = http.calls[0]!.headers;
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();
  });
});
