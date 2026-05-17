// Pins the Gemini native :generateContent wire shape for the new Device Agent path:
// URL is `${baseUrl}/models/${model}:generateContent` (with `/openai` stripped from
// the preset baseUrl), x-goog-api-key header (not Authorization), systemInstruction
// + contents[].parts[] body, responseMimeType: 'application/json' on plan/review only,
// and google_search tool attached only on the research pass (with responseMimeType
// removed in the same condition — Gemini rejects the combination). The Kotlin port
// for this class is a followup ticket.

import { describe, expect, it } from 'vitest';

import { buildPlanMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { ProviderHttpError } from '../provider/errorCodes.js';
import { GeminiNativeProvider } from '../provider/geminiNativeProvider.js';

import { FakeHttpExecutor } from './fakeHttpExecutor.helper.js';

function config(model = 'gemini-2.5-pro', baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'): RuntimeConfig {
  return {
    provider: 'gemini',
    apiFormat: 'openai-compatible',
    model,
    baseUrl,
    apiKey: 'AIzaTEST-ABCDEFGHIJKLMNOP',
  };
}

function geminiTextResponse(text: string): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  });
}

describe('GeminiNativeProvider.generatePlan', () => {
  it('POSTs to :generateContent with systemInstruction, x-goog-api-key, and responseMimeType for plan', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      geminiTextResponse(
        '{"intent":"swap","route":"jupiter","risk":"low","approval":"once","safeguards":["check slippage"]}',
      ),
    );
    const provider = new GeminiNativeProvider(config(), http);
    const result = await provider.generatePlan({ userPrompt: 'swap 1 SOL for USDC' });

    expect(result.intent).toBe('swap');
    const call = http.calls[0]!;
    // /openai suffix stripped from the preset baseUrl; model + :generateContent appended.
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(call.headers['x-goog-api-key']).toBe('AIzaTEST-ABCDEFGHIJKLMNOP');
    expect(call.headers.Authorization).toBeUndefined();

    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: DEVICE_AGENT_SYSTEM_PROMPTS.PLAN }] });
    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.role).toBe('user');
    expect(contents[0]!.parts[0]!.text).toBe(buildPlanMessages({ userPrompt: 'swap 1 SOL for USDC' }).userContent);
    const generationConfig = body.generationConfig as Record<string, unknown>;
    expect(generationConfig.temperature).toBe(0.2);
    expect(generationConfig.maxOutputTokens).toBe(1024);
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect('tools' in body).toBe(false);
  });

  it('accepts an already-native baseUrl without an /openai suffix (idempotent)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, geminiTextResponse('{"intent":"x"}'));
    const provider = new GeminiNativeProvider(
      config('gemini-2.5-pro', 'https://generativelanguage.googleapis.com/v1beta'),
      http,
    );
    await provider.generatePlan({ userPrompt: 'hi' });
    expect(http.calls[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
  });

  it('appends /v1beta when caller supplies a bare host', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, geminiTextResponse('{"intent":"x"}'));
    const provider = new GeminiNativeProvider(
      config('gemini-2.5-flash', 'https://example-gemini-proxy.dev'),
      http,
    );
    await provider.generatePlan({ userPrompt: 'hi' });
    expect(http.calls[0]!.url).toBe(
      'https://example-gemini-proxy.dev/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });
});

describe('GeminiNativeProvider.reviewPlan two-pass research', () => {
  it('runs research with google_search and NO responseMimeType, then review with responseMimeType and NO tools', async () => {
    const http = new FakeHttpExecutor();
    // Pass 1: grounded research returns prose + groundingMetadata.groundingChunks.
    http.queueResponse(
      200,
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Helium Mobile cheapest plan is Air at $15/month.' }],
            },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://www.heliummobile.com/plans', title: 'Plans — Helium Mobile' } },
              ],
            },
          },
        ],
      }),
    );
    // Pass 2: structured review returns approve.
    http.queueResponse(
      200,
      geminiTextResponse(
        '{"decision":"approve","reason":"Air plan is $15, under $20.","summary":"Approved","evidence":{"findings":[{"label":"Subscription price","value":"$15/month","tone":"good"}]}}',
      ),
    );

    const provider = new GeminiNativeProvider(config(), http);
    const result = await provider.reviewPlan({
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('approve');
    expect(http.calls.length).toBe(2);

    const researchBody = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(researchBody.tools).toEqual([{ google_search: {} }]);
    const researchGenConfig = researchBody.generationConfig as Record<string, unknown>;
    expect('responseMimeType' in researchGenConfig).toBe(false);
    expect(researchGenConfig.maxOutputTokens).toBe(1800);

    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    expect('tools' in reviewBody).toBe(false);
    const reviewGenConfig = reviewBody.generationConfig as Record<string, unknown>;
    expect(reviewGenConfig.responseMimeType).toBe('application/json');
    const reviewContents = reviewBody.contents as Array<{ parts: Array<{ text: string }> }>;
    expect(reviewContents[0]!.parts[0]!.text).toContain('researchEvidence');
    expect(reviewContents[0]!.parts[0]!.text).toContain('heliummobile.com');
  });

  it('falls back to single-pass review when research pass throws (non-fatal)', async () => {
    const http = new FakeHttpExecutor();
    http.queueFailure(new Error('research pass network blip'));
    http.queueResponse(
      200,
      geminiTextResponse(
        '{"decision":"needs_input","reason":"Cannot confirm current price.","summary":"Needs input","evidence":{}}',
      ),
    );
    const provider = new GeminiNativeProvider(config(), http);
    const result = await provider.reviewPlan({
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('needs_input');
    expect(http.calls.length).toBe(2);
  });

  it('single-pass review (no research) keeps responseMimeType json and omits tools', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      geminiTextResponse('{"decision":"approve","reason":"ok","summary":"go","evidence":{}}'),
    );
    const provider = new GeminiNativeProvider(config(), http);
    // Supply a pre-built research object so the assembler doesn't auto-generate a fresh
    // `currentDate: new Date().toISOString()` between the provider call and the test's
    // own buildReviewMessages comparison — that mismatch is just timing noise.
    const reviewPayload = {
      plan: { intent: 'swap' },
      research: { needed: false, mode: 'not_required', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    };
    const result = await provider.reviewPlan(reviewPayload);

    expect(result.decision).toBe('approve');
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect('tools' in body).toBe(false);
    expect((body.generationConfig as Record<string, unknown>).responseMimeType).toBe('application/json');
    const contents = body.contents as Array<{ parts: Array<{ text: string }> }>;
    expect(contents[0]!.parts[0]!.text).toBe(buildReviewMessages(reviewPayload).userContent);
  });
});

describe('GeminiNativeProvider.ask', () => {
  it('omits responseMimeType, uses ASK temperature, wraps result as { output_text }', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, geminiTextResponse('It will swap SOL for USDC via Jupiter.'));
    const provider = new GeminiNativeProvider(config(), http);
    const result = await provider.ask({ question: 'what happens?' });

    expect((result.output_text as string).startsWith('It will swap')).toBe(true);
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const generationConfig = body.generationConfig as Record<string, unknown>;
    expect('responseMimeType' in generationConfig).toBe(false);
    expect(generationConfig.temperature).toBe(0.3);
    expect(generationConfig.maxOutputTokens).toBe(800);
  });

  it('attaches google_search when ask payload requests research', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, geminiTextResponse('Current Helium cheapest plan is $15.'));
    const provider = new GeminiNativeProvider(config(), http);
    await provider.ask({
      question: 'what is the current Helium plan?',
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect('responseMimeType' in (body.generationConfig as Record<string, unknown>)).toBe(false);
  });

  it('throws provider_invalid_response when the model returns blank text', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, geminiTextResponse(''));
    const provider = new GeminiNativeProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.ask({ question: 'what happens?' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });
});

describe('GeminiNativeProvider error handling', () => {
  it('403 → ProviderHttpError(provider_auth)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(403, '{"error":{"message":"key not allowed"}}');
    const provider = new GeminiNativeProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({ userPrompt: 'hi' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_auth');
  });

  it('malformed 200 body becomes provider_invalid_response', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, '{not even json');
    const provider = new GeminiNativeProvider(config(), http);

    let captured: unknown = null;
    try {
      await provider.generatePlan({ userPrompt: 'hi' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });
});
