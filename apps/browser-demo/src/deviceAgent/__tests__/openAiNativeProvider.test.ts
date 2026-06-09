// Pins the OpenAI Responses-API wire shape for the new native Device Agent path:
// URL ends `/responses`, body uses `instructions` + `input` (not `messages`), token
// limit is `max_output_tokens` (not max_tokens / max_completion_tokens), reasoning
// effort attached for gpt-5 / o-series, web_search_preview tool attached only on the
// research pass with `tools_choice: 'auto'` and the `web_search_call.action.sources`
// include flag. Structured output uses `text.format.type = 'json_schema'` (NOT
// json_object — that mode requires the literal word "json" in `input` and 400s on our
// JSON-stringified userContent). Research pass also runs the citation filter that drops
// blog/news subdomain citations on pricing questions. The Kotlin port for this class
// is a followup ticket.

import { describe, expect, it } from 'vitest';

import { buildPlanMessages, buildReviewMessages } from '../prompts/messageAssembler.js';
import { DEVICE_AGENT_SYSTEM_PROMPTS } from '../prompts/systemPrompts.js';
import type { RuntimeConfig } from '../runtime/config.js';

import { ProviderHttpError } from '../provider/errorCodes.js';
import { OpenAiNativeProvider } from '../provider/openAiNativeProvider.js';

import { FakeHttpExecutor } from './fakeHttpExecutor.helper.js';

function config(model = 'gpt-5'): RuntimeConfig {
  return {
    provider: 'openai',
    apiFormat: 'openai-compatible',
    model,
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test-ABCDEFGHIJKLMNOP',
  };
}

describe('OpenAiNativeProvider.generatePlan', () => {
  it('POSTs to /responses with instructions, input, max_output_tokens, and reasoning effort for gpt-5', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"intent":"swap","route":"jupiter","risk":"low","approval":"once","safeguards":["check slippage"]}',
      }),
    );
    const provider = new OpenAiNativeProvider(config(), http);
    const result = await provider.generatePlan({ userPrompt: 'swap 1 SOL for USDC' });

    expect(result.intent).toBe('swap');
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers.Authorization).toBe('Bearer sk-test-ABCDEFGHIJKLMNOP');

    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5');
    expect(body.instructions).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.PLAN);
    expect(body.input).toBe(buildPlanMessages({ userPrompt: 'swap 1 SOL for USDC' }).userContent);
    // gpt-5 is a reasoning model, so the plan budget is raised to REASONING_OUTPUT_TOKEN_FLOOR
    // (4096) — reasoning tokens count against max_output_tokens and would otherwise starve the answer.
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);
    const textConfig = body.text as Record<string, unknown>;
    expect(textConfig.verbosity).toBe('low');
    const formatConfig = textConfig.format as Record<string, unknown>;
    expect(formatConfig.type).toBe('json_schema');
    expect(formatConfig.name).toBe('agentic_device_plan');
    expect(formatConfig.strict).toBe(true);
    expect((formatConfig.schema as Record<string, unknown>).required).toEqual([
      'intent', 'route', 'risk', 'approval', 'safeguards',
    ]);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect('temperature' in body).toBe(false);
    expect('tools' in body).toBe(false);
    expect('max_tokens' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  });

  it('sends temperature (not reasoning) for non-reasoning models like gpt-4.1', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ output_text: '{"intent":"x"}' }));
    const provider = new OpenAiNativeProvider(config('gpt-4.1'), http);
    await provider.generatePlan({ userPrompt: 'hi' });

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect('reasoning' in body).toBe(false);
  });

  it('extracts text from the walked output[].content[].text shape when output_text is absent', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"intent":"swap"}' }],
          },
        ],
      }),
    );
    const provider = new OpenAiNativeProvider(config(), http);
    const result = await provider.generatePlan({ userPrompt: 'hi' });
    expect(result.intent).toBe('swap');
  });
});

describe('OpenAiNativeProvider.reviewPlan two-pass research', () => {
  it('runs research pass with web_search_preview, then a structured review pass with the research summary injected', async () => {
    const http = new FakeHttpExecutor();
    // Pass 1: research call returns a grounded text summary + citation annotations.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text: 'Helium Mobile offers Zero ($0/mo) and Air ($15/mo); cheapest is $15.',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Helium Mobile offers Zero ($0/mo) and Air ($15/mo).',
                annotations: [
                  { type: 'url_citation', url: 'https://www.heliummobile.com/plans', title: 'Plans' },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Pass 2: structured review returns approve with a $15 finding.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"decision":"approve","reason":"Air plan is $15, under $20.","summary":"Approved","evidence":{"findings":[{"label":"Subscription price","value":"$15/month","tone":"good"}]}}',
      }),
    );

    const provider = new OpenAiNativeProvider(config(), http);
    const result = await provider.reviewPlan({
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('approve');
    expect(result.evidence).toMatchObject({
      research: { status: 'checked' },
      findings: expect.arrayContaining([
        { label: 'Current research', value: expect.stringContaining('Helium Mobile'), tone: 'neutral' },
      ]),
      sources: expect.arrayContaining([
        { url: 'https://www.heliummobile.com/plans', title: 'Plans' },
      ]),
    });
    expect(http.calls.length).toBe(2);

    const researchBody = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const tools = researchBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('web_search_preview');
    expect(researchBody.tool_choice).toBe('auto');
    expect(researchBody.include).toEqual(['web_search_call.action.sources']);
    expect(researchBody.max_output_tokens).toBe(4096); // gpt-5 reasoning floor (was 1800 base)
    // Research pass: free-text output, no JSON-object format coercion.
    expect('text' in researchBody).toBe(false);

    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    expect('tools' in reviewBody).toBe(false);
    expect(reviewBody.max_output_tokens).toBe(4096); // gpt-5 reasoning floor (was 1800 base)
    const reviewText = reviewBody.text as Record<string, unknown>;
    // Review pass bumps verbosity to 'medium' so the "why it passed/denied" prose
    // has room to match Claude/Gemini-style breadth instead of one-liners.
    expect(reviewText.verbosity).toBe('medium');
    const reviewFormat = reviewText.format as Record<string, unknown>;
    expect(reviewFormat.type).toBe('json_schema');
    expect(reviewFormat.name).toBe('agentic_device_review');
    expect(reviewFormat.strict).toBe(false);
    expect(JSON.stringify(reviewFormat.schema)).toContain('evidenceFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('findings');
    expect(JSON.stringify(reviewFormat.schema)).toContain('sources');
    expect(JSON.stringify(reviewFormat.schema)).toContain('research');
    expect(JSON.stringify(reviewFormat.schema)).toContain('blockingFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('missingFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('confidence');
    // The injected researchEvidence should be present in the user input string.
    expect(reviewBody.input as string).toContain('researchEvidence');
    expect(reviewBody.input as string).toContain('heliummobile.com');
  });

  it('falls back to single-pass review when research pass throws (non-fatal)', async () => {
    const http = new FakeHttpExecutor();
    // Pass 1 fails.
    http.queueFailure(new Error('research pass network blip'));
    // Pass 2: review runs anyway with the original payload.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"decision":"needs_input","reason":"Cannot confirm current price.","summary":"Needs input","evidence":{}}',
      }),
    );

    const provider = new OpenAiNativeProvider(config(), http);
    const result = await provider.reviewPlan({
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    expect(result.decision).toBe('needs_input');
    expect(http.calls.length).toBe(2);
  });

  it('single-pass review (no research) does NOT attach tools', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"decision":"approve","reason":"ok","summary":"go","evidence":{}}',
      }),
    );
    const provider = new OpenAiNativeProvider(config(), http);
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
    expect(body.max_output_tokens).toBe(4096); // gpt-5 reasoning floor (was 1800 base)
    const reviewText = body.text as Record<string, unknown>;
    // Review pass verbosity is 'medium' (vs 'low' for plan/ask) — see openAiNativeProvider.ts.
    expect(reviewText.verbosity).toBe('medium');
    const reviewFormat = reviewText.format as Record<string, unknown>;
    expect(reviewFormat.type).toBe('json_schema');
    expect(reviewFormat.name).toBe('agentic_device_review');
    expect(reviewFormat.strict).toBe(false);
    expect(JSON.stringify(reviewFormat.schema)).toContain('evidenceFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('findings');
    expect(JSON.stringify(reviewFormat.schema)).toContain('sources');
    expect(JSON.stringify(reviewFormat.schema)).toContain('research');
    expect(JSON.stringify(reviewFormat.schema)).toContain('blockingFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('missingFactIds');
    expect(JSON.stringify(reviewFormat.schema)).toContain('confidence');
    expect(body.instructions).toBe(DEVICE_AGENT_SYSTEM_PROMPTS.REVIEW);
    expect(body.input).toBe(buildReviewMessages(reviewPayload).userContent);
  });

  it('filters blog/news citations and keeps official-domain citations for pricing instructions', async () => {
    const http = new FakeHttpExecutor();
    // Pass 1: research returns a mix of blog + official URLs.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text: 'Helium Mobile cheapest plan is Air at $15/month.',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Helium Mobile cheapest plan is Air at $15/month.',
                annotations: [
                  { type: 'url_citation', url: 'https://blog.heliummobile.com/break-free', title: 'Break Free' },
                  { type: 'url_citation', url: 'https://www.heliummobile.com/plans', title: 'Plans' },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Pass 2: structured review.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"decision":"approve","reason":"Air plan is $15, under $20.","summary":"Approved","evidence":{}}',
      }),
    );

    const provider = new OpenAiNativeProvider(config(), http);
    await provider.reviewPlan({
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    // The review pass's user input string carries the injected researchEvidence —
    // the blog URL should be filtered out, only the official domain should remain.
    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    const input = reviewBody.input as string;
    expect(input).toContain('heliummobile.com/plans');
    expect(input).not.toContain('blog.heliummobile.com');
  });

  it('suppresses the research summary when only blog citations were returned for a pricing question', async () => {
    const http = new FakeHttpExecutor();
    // Pass 1: research returns ONLY a blog URL.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text: 'Helium Mobile offers the Zero Plan at $0/month.',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Helium Mobile offers the Zero Plan at $0/month.',
                annotations: [
                  { type: 'url_citation', url: 'https://blog.heliummobile.com/zero-plan', title: 'Zero Plan' },
                ],
              },
            ],
          },
        ],
      }),
    );
    // Pass 2: structured review.
    http.queueResponse(
      200,
      JSON.stringify({
        output_text:
          '{"decision":"needs_input","reason":"Current pricing not verified.","summary":"Needs input","evidence":{}}',
      }),
    );

    const provider = new OpenAiNativeProvider(config(), http);
    await provider.reviewPlan({
      instruction: 'check helium mobile. lowest monthly plan. if less than $20. approve.',
      plan: { intent: 'swap' },
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    const reviewBody = JSON.parse(http.calls[1]!.body) as Record<string, unknown>;
    const input = reviewBody.input as string;
    // researchEvidence.summary should be the suppression copy, NOT the stale Zero Plan line.
    expect(input).toContain('Current pricing could not be verified');
    expect(input).not.toContain('Zero Plan');
    expect(input).not.toContain('blog.heliummobile.com');
  });
});

describe('OpenAiNativeProvider.ask', () => {
  it('omits text.format, uses ASK temperature for non-reasoning models, wraps result as { output_text }', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ output_text: 'It will swap SOL for USDC via Jupiter.' }));
    const provider = new OpenAiNativeProvider(config('gpt-4.1'), http);
    const result = await provider.ask({ question: 'what happens?' });

    expect((result.output_text as string).startsWith('It will swap')).toBe(true);
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect('text' in body).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_output_tokens).toBe(800);
  });

  it('attaches web_search_preview when ask payload requests research', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ output_text: 'Current Helium Mobile cheapest plan is $15.' }));
    const provider = new OpenAiNativeProvider(config(), http);
    await provider.ask({
      question: 'what is the current Helium plan?',
      research: { needed: true, mode: 'auto_current_facts', currentDate: '2026-05-17T00:00:00.000Z', maxSearches: 3 },
    });

    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('web_search_preview');
  });

  it('throws provider_invalid_response when the model returns blank text', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, JSON.stringify({ output_text: '' }));
    const provider = new OpenAiNativeProvider(config(), http);

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

describe('OpenAiNativeProvider error handling', () => {
  it('401 → ProviderHttpError(provider_auth)', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(401, '{"error":{"message":"invalid key"}}');
    const provider = new OpenAiNativeProvider(config(), http);

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
    const provider = new OpenAiNativeProvider(config(), http);

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

describe('OpenAiNativeProvider via OpenRouter (browser CORS)', () => {
  it('omits X-OpenRouter-Metadata, sends attribution headers, and applies the reasoning floor', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({
        output_text: '{"intent":"x","route":"r","risk":"low","approval":"once","safeguards":[]}',
      }),
    );
    const openRouterConfig: RuntimeConfig = {
      provider: 'openrouter',
      apiFormat: 'openai-compatible',
      model: 'openai/gpt-5',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test-ABCDEFGHIJKLMNOP',
    };
    const provider = new OpenAiNativeProvider(openRouterConfig, http);
    await provider.generatePlan({ userPrompt: 'swap 1 SOL' });

    const call = http.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/responses');
    expect(call.headers.Authorization).toBe('Bearer sk-or-test-ABCDEFGHIJKLMNOP');
    expect(call.headers['HTTP-Referer']).toBeTruthy();
    expect(call.headers['X-Title']).toBeTruthy();
    expect('X-OpenRouter-Metadata' in call.headers).toBe(false);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.max_output_tokens).toBe(4096); // openai/gpt-5 is a reasoning model
  });

  it('reports reasoning-budget starvation when the Responses payload is empty + incomplete', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(
      200,
      JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }),
    );
    const provider = new OpenAiNativeProvider(config('gpt-5'), http);
    let captured: unknown = null;
    try {
      await provider.generatePlan({ userPrompt: 'swap 1 SOL' });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
    expect((captured as ProviderHttpError).message.toLowerCase()).toContain('reasoning');
  });
});
