// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/AnthropicProviderTest.kt
// with one inverted assertion: the browser-native provider MUST send
// anthropic-dangerous-direct-browser-access: 'true' (Kotlin asserts its
// absence; we assert its presence because Anthropic's CORS policy blocks
// browser requests without it).

import { describe, expect, it } from 'vitest';

import { buildPlanMessages } from '../prompts/messageAssembler.js';
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
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW);
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
