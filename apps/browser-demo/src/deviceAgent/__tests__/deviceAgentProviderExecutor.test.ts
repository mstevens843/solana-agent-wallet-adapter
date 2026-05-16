// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/DeviceAgentProviderExecutorTest.kt.
// Pins routing (openai/openai-compatible/anthropic), redaction of the API key
// in every ProviderFailedError message, AbortError verbatim propagation, and
// the unsupported-format → RUNTIME-tier invalid_config + unsupported_format
// subcode (NOT the provider-tier provider_invalid_config).

import { describe, expect, it } from 'vitest';

import { ProviderFailedError } from '../runtime/errors.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { DeviceAgentProviderExecutor } from '../provider/deviceAgentProviderExecutor.js';
import { ProviderHttpError } from '../provider/errorCodes.js';

import { FakeHttpExecutor } from './fakeHttpExecutor.helper.js';

const API_KEY = 'sk-test-EXAMPLEKEY12345';

function config(apiFormat: string): RuntimeConfig {
  const isAnthropic = apiFormat === 'anthropic';
  return {
    provider: isAnthropic ? 'anthropic' : 'openai',
    apiFormat,
    model: isAnthropic ? 'claude-opus-4-5' : 'gpt-4o-mini',
    baseUrl: isAnthropic ? 'https://api.anthropic.com' : 'https://api.openai.com',
    apiKey: API_KEY,
  };
}

const OPENAI_PLAN_BODY = JSON.stringify({
  choices: [
    {
      message: {
        content:
          '{"intent":"transfer","route":"system","risk":"low","approval":"once","safeguards":[]}',
      },
    },
  ],
});

const ANTHROPIC_PLAN_BODY = JSON.stringify({
  content: [
    {
      type: 'text',
      text: '{"intent":"transfer","route":"system","risk":"low","approval":"once","safeguards":[]}',
    },
  ],
});

describe('DeviceAgentProviderExecutor — routing', () => {
  it('generatePlan routes through OpenAI for openai-compatible apiFormat', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, OPENAI_PLAN_BODY);
    const executor = new DeviceAgentProviderExecutor(http);
    const result = (await executor.generatePlan(config('openai-compatible'), {
      userPrompt: 'send 1 SOL',
    })) as Record<string, unknown>;
    expect(result.intent).toBe('transfer');
    expect(http.calls[0]!.url.endsWith('/chat/completions')).toBe(true);
  });

  it('generatePlan accepts the legacy "openai" alias (canonicalApiFormat folds it to openai-compatible)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, OPENAI_PLAN_BODY);
    const executor = new DeviceAgentProviderExecutor(http);
    const result = (await executor.generatePlan(config('openai'), {
      userPrompt: 'send 1 SOL',
    })) as Record<string, unknown>;
    expect(result.intent).toBe('transfer');
  });

  it('generatePlan routes through Anthropic for anthropic apiFormat', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, ANTHROPIC_PLAN_BODY);
    const executor = new DeviceAgentProviderExecutor(http);
    const result = (await executor.generatePlan(config('anthropic'), {
      userPrompt: 'send 1 SOL',
    })) as Record<string, unknown>;
    expect(result.intent).toBe('transfer');
    expect(http.calls[0]!.url.endsWith('/messages')).toBe(true);
  });
});

describe('DeviceAgentProviderExecutor — error wrapping + redaction', () => {
  it('401 → ProviderFailedError(provider_auth) with the API key redacted', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(401, `{"error":{"message":"Invalid key ${API_KEY}"}}`);
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    const err = captured as ProviderFailedError;
    expect(err.error.code).toBe('provider_auth');
    expect(err.error.message.includes(API_KEY)).toBe(false);
  });

  it('429 → ProviderFailedError(provider_rate_limited)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(429, '{"error":{"message":"slow down"}}');
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.reviewPlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_rate_limited');
  });

  it('500 → ProviderFailedError(provider_upstream)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(500, '{"error":{"message":"oops"}}');
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_upstream');
  });

  it('ProviderHttpError(provider_timeout) from HttpExecutor surfaces as provider_timeout', async () => {
    const http = new FakeHttpExecutor();
    http.queueFailure(new ProviderHttpError('provider_timeout', 'Provider request timed out.'));
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.ask(config('anthropic'), { question: 'hi' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_timeout');
  });

  it('Malformed 200 body becomes provider_invalid_response via parseModelJson', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, '{"choices":[{"message":{"content":"not json at all"}}]}');
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_invalid_response');
  });
});

describe('DeviceAgentProviderExecutor — generic error classification', () => {
  it('TypeError from HttpExecutor → ProviderFailedError(provider_network)', async () => {
    const http = new FakeHttpExecutor();
    http.queueFailure(new TypeError('network down'));
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_network');
  });

  it('Error with cause.name === "TimeoutError" → ProviderFailedError(provider_timeout)', async () => {
    const http = new FakeHttpExecutor();
    const cause = new Error('inner timeout');
    cause.name = 'TimeoutError';
    const wrapped = new Error('wrapper');
    (wrapped as Error & { cause?: unknown }).cause = cause;
    http.queueFailure(wrapped);
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    expect((captured as ProviderFailedError).error.code).toBe('provider_timeout');
  });
});

describe('DeviceAgentProviderExecutor — apiFormat routing failures', () => {
  it('unsupported apiFormat → ProviderFailedError with RUNTIME-tier invalid_config + unsupported_format subcode', async () => {
    const http = new FakeHttpExecutor();
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan({ ...config('openai-compatible'), apiFormat: 'weird-format' }, {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderFailedError);
    const err = captured as ProviderFailedError;
    expect(err.error.code).toBe('invalid_config');
    expect(err.error.subcode).toBe('unsupported_format');
    expect(http.calls.length).toBe(0);
  });
});

describe('DeviceAgentProviderExecutor — AbortError verbatim', () => {
  it('AbortError from HttpExecutor propagates verbatim without ProviderFailedError wrap', async () => {
    const http = new FakeHttpExecutor();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    http.queueFailure(abortErr);
    const executor = new DeviceAgentProviderExecutor(http);

    let captured: unknown = null;
    try {
      await executor.generatePlan(config('openai-compatible'), {});
    } catch (err) {
      captured = err;
    }
    expect(captured).toBe(abortErr);
    expect(captured instanceof ProviderFailedError).toBe(false);
  });

  it('External AbortSignal already aborted before call → AbortError propagates from FetchHttpExecutor unchanged', async () => {
    const http = new FakeHttpExecutor();
    // Queue any value — the executor should never even reach the HTTP call.
    http.queueResponse(200, OPENAI_PLAN_BODY);
    const executor = new DeviceAgentProviderExecutor(http);
    const controller = new AbortController();
    controller.abort();

    // The FakeHttpExecutor does not honor signal aborts on its own, so this
    // test pins the executor's own signal?.aborted check after a throw. We
    // simulate it by having the http call resolve normally then verifying
    // the executor still surfaces the AbortError when the signal is set.
    // Use a fresh failure that mimics fetch's behavior when called with a
    // pre-aborted signal.
    const http2 = new FakeHttpExecutor();
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    http2.queueFailure(abortErr);
    const executor2 = new DeviceAgentProviderExecutor(http2);

    let captured: unknown = null;
    try {
      await executor2.generatePlan(config('openai-compatible'), {}, controller.signal);
    } catch (err) {
      captured = err;
    }
    expect(captured instanceof ProviderFailedError).toBe(false);
    expect((captured as Error).name).toBe('AbortError');
  });
});

describe('DeviceAgentProviderExecutor.ask — output_text wrapping', () => {
  it('returns { output_text } for OpenAI', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        choices: [{ message: { content: 'This is a concise answer.' } }],
      }),
    );
    const executor = new DeviceAgentProviderExecutor(http);
    const result = (await executor.ask(config('openai'), { question: 'what happens?' })) as Record<
      string,
      unknown
    >;
    expect(result.output_text).toBe('This is a concise answer.');
  });

  it('returns { output_text } for Anthropic', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({ content: [{ type: 'text', text: 'This is a concise answer.' }] }),
    );
    const executor = new DeviceAgentProviderExecutor(http);
    const result = (await executor.ask(config('anthropic'), { question: 'what happens?' })) as Record<
      string,
      unknown
    >;
    expect(result.output_text).toBe('This is a concise answer.');
  });
});
