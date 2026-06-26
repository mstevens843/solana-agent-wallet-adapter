import { describe, expect, it, vi } from 'vitest';

import {
  anthropicHeaders,
  bearerJsonHeaders,
  chatTransportAdapter,
  createStreamingProviderTurn,
  isSolanaAddress,
  iterateProviderSse,
  runAgentChatLoop,
  validateChatProposedAction,
} from '../chatAgent/index.js';
import { isTruncatedFinish } from '../chatAgent/providerTurn.js';
import type { AgentChatStreamEvent } from '../chatAgent/index.js';

// A real 32-byte base58 Solana address (USDC mint) and a charset-valid-but-wrong-size string.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('proposal validation hardening (F7)', () => {
  it('rejects non-32-byte recipients that pass the charset regex', () => {
    expect(isSolanaAddress(USDC)).toBe(true);
    expect(isSolanaAddress('1111111111111111111111')).toBe(false); // 22 chars → wrong byte length
    const bad = validateChatProposedAction({ kind: 'transfer_sol', summary: 'send', params: { recipient: '1111111111111111111111', amountSol: 1 } });
    expect(bad.proposal).toBeUndefined();
    expect(bad.error).toMatch(/base58/i);
  });

  it('rejects non-positive / non-finite amounts', () => {
    for (const amount of [0, -1, 'abc', '', Infinity]) {
      const r = validateChatProposedAction({ kind: 'transfer_sol', summary: 's', params: { recipient: USDC, amountSol: amount } });
      expect(r.proposal, `amount=${String(amount)}`).toBeUndefined();
    }
    const ok = validateChatProposedAction({ kind: 'transfer_sol', summary: 's', params: { recipient: USDC, amountSol: 0.5 } });
    expect(ok.proposal).toBeDefined();
  });

  it('rejects an invalid resolution source enum', () => {
    const r = validateChatProposedAction({ kind: 'transfer_sol', summary: 's', params: { recipient: USDC, amountSol: 1 }, resolution: { recipientSource: 'made_up' } });
    expect(r.proposal).toBeUndefined();
    expect(r.error).toMatch(/evidence.*user_input/i);
  });

  it('caps an over-long sign_proof statement to 280 chars', () => {
    const long = 'x'.repeat(500);
    const r = validateChatProposedAction({ kind: 'sign_proof', summary: 'proof', params: { statement: long } });
    expect(r.proposal).toBeDefined();
    expect((r.proposal!.params as { statement: string }).statement.length).toBe(280);
  });
});

describe('parseResponse hardening (F5 — native path)', () => {
  it('throws on a provider error field (all 3 adapters)', () => {
    expect(() => chatTransportAdapter('anthropic-messages').parseResponse({ error: { message: 'rate limited' } })).toThrow(/rate limited/);
    expect(() => chatTransportAdapter('openai-compatible').parseResponse({ error: { message: 'bad key' } })).toThrow(/bad key/);
    expect(() => chatTransportAdapter('gemini-native').parseResponse({ error: { message: 'quota' } })).toThrow(/quota/);
  });

  it('throws on empty result arrays instead of returning empty text', () => {
    expect(() => chatTransportAdapter('openai-compatible').parseResponse({ choices: [] })).toThrow(/no choices/i);
    expect(() => chatTransportAdapter('gemini-native').parseResponse({ candidates: [], promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/);
    expect(() => chatTransportAdapter('anthropic-messages').parseResponse({})).toThrow(/no content/i);
  });
});

describe('SSE robustness (F1/F3)', () => {
  it('flushes a multibyte char split across read chunks', async () => {
    // "😀" is 4 bytes (F0 9F 98 80); split after 2 bytes across two stream chunks.
    const emoji = new TextEncoder().encode('data: {"v":"😀"}\n\n');
    const splitAt = emoji.indexOf(0x9f) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(emoji.slice(0, splitAt));
        controller.enqueue(emoji.slice(splitAt));
        controller.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const frames: string[] = [];
    for await (const f of iterateProviderSse(res)) frames.push(f.data);
    expect(frames).toEqual(['{"v":"😀"}']);
  });

  it('stops the OpenAI parseStream promptly when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const turn = await chatTransportAdapter('openai-compatible').parseStream(
      sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
      () => {},
      controller.signal,
    );
    expect(turn.text).toBe('');
  });
});

describe('provider-specific correctness (Phase G)', () => {
  it('OpenAI reasoning models use max_completion_tokens + no temperature; standard use max_tokens', () => {
    const a = chatTransportAdapter('openai-compatible');
    const reasoning = a.buildBody('SYS', [], 'gpt-5', []);
    expect(reasoning.max_completion_tokens).toBeGreaterThan(0);
    expect(reasoning.max_tokens).toBeUndefined();
    expect(reasoning.temperature).toBeUndefined();
    const standard = a.buildBody('SYS', [], 'gpt-4o', []);
    expect(standard.max_tokens).toBeGreaterThan(0);
    expect(standard.max_completion_tokens).toBeUndefined();
    expect(standard.temperature).toBe(0.3);
  });

  it('maps reasoning depth per provider (H2)', () => {
    const oai = chatTransportAdapter('openai-compatible');
    // o-series gets reasoning_effort; 'minimal' clamps to 'low' for non-gpt-5.
    expect(oai.buildBody('S', [], 'o3', [], { reasoningEffort: 'high' }).reasoning_effort).toBe('high');
    expect(oai.buildBody('S', [], 'o3', [], { reasoningEffort: 'minimal' }).reasoning_effort).toBe('low');
    expect(oai.buildBody('S', [], 'gpt-5', [], { reasoningEffort: 'minimal' }).reasoning_effort).toBe('minimal');
    // Non-reasoning models get NO reasoning_effort.
    expect(oai.buildBody('S', [], 'gpt-4o', [], { reasoningEffort: 'high' }).reasoning_effort).toBeUndefined();
    // Anthropic: medium/high enable extended thinking + DROP temperature.
    const aMed = chatTransportAdapter('anthropic-messages').buildBody('S', [], 'claude-sonnet-4', [], { reasoningEffort: 'medium' });
    expect((aMed.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0);
    expect(aMed.temperature).toBeUndefined();
    const aLow = chatTransportAdapter('anthropic-messages').buildBody('S', [], 'claude-sonnet-4', [], { reasoningEffort: 'low' });
    expect(aLow.thinking).toBeUndefined();
    expect(aLow.temperature).toBe(0.3);
    // Gemini 2.5 gets thinkingConfig; non-2.5 does not.
    const g25 = chatTransportAdapter('gemini-native').buildBody('S', [], 'gemini-2.5-flash', [], { reasoningEffort: 'minimal' });
    expect(((g25.generationConfig as { thinkingConfig?: { thinkingBudget: number } }).thinkingConfig)?.thinkingBudget).toBe(128);
    const g15 = chatTransportAdapter('gemini-native').buildBody('S', [], 'gemini-1.5-flash', [], { reasoningEffort: 'minimal' });
    expect((g15.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toBeUndefined();
  });

  it('gates stream_options to native OpenAI/OpenRouter only (H0.2)', () => {
    const oai = chatTransportAdapter('openai-compatible');
    expect(oai.buildBody('S', [], 'gpt-4o', [], { streaming: true, openAiNative: true }).stream_options).toEqual({ include_usage: true });
    expect(oai.buildBody('S', [], 'gpt-4o', [], { streaming: true, openAiNative: false }).stream_options).toBeUndefined();
    expect(oai.buildBody('S', [], 'gpt-4o', [], { streaming: false, openAiNative: true }).stream_options).toBeUndefined();
    // Back-compat: a bare boolean still means `streaming`.
    expect(oai.buildBody('S', [], 'gpt-4o', [], false).stream).toBe(false);
  });

  it('OpenRouter Anthropic headers include anthropic-version (skin needs it)', () => {
    expect(anthropicHeaders('or-key', true)['anthropic-version']).toBe('2023-06-01');
    expect(anthropicHeaders('or-key', true).authorization).toBe('Bearer or-key');
  });

  it('server vs browser header divergence (CORS)', () => {
    // Server (node, no window): Anthropic has no dangerous-access; OpenRouter keeps metadata.
    expect(anthropicHeaders('ak', false)['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(bearerJsonHeaders('k', true)['X-OpenRouter-Metadata']).toBe('enabled');
    // Browser (window+document present): add dangerous-access; DROP the metadata header
    // that OpenRouter's browser preflight rejects.
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    g.window = { document: {} };
    try {
      expect(anthropicHeaders('ak', false)['anthropic-dangerous-direct-browser-access']).toBe('true');
      expect(bearerJsonHeaders('k', true)['X-OpenRouter-Metadata']).toBeUndefined();
    } finally {
      if (!had) delete g.window;
    }
  });

  it('Gemini buildBody relaxes the DANGEROUS_CONTENT safety filter for wallet ops', () => {
    const body = chatTransportAdapter('gemini-native').buildBody('SYS', [], 'gemini-2.5-flash', []);
    const settings = body.safetySettings as Array<{ category: string; threshold: string }>;
    expect(settings.find((s) => s.category === 'HARM_CATEGORY_DANGEROUS_CONTENT')?.threshold).toBe('BLOCK_NONE');
  });

  it('extracts finishReason and flags truncation (all 3 adapters)', () => {
    expect(chatTransportAdapter('openai-compatible').parseResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'length' }] }).finishReason).toBe('length');
    expect(chatTransportAdapter('anthropic-messages').parseResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'max_tokens' }).finishReason).toBe('max_tokens');
    expect(chatTransportAdapter('gemini-native').parseResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'MAX_TOKENS' }] }).finishReason).toBe('max_tokens');
    expect(isTruncatedFinish('length')).toBe(true);
    expect(isTruncatedFinish('max_tokens')).toBe(true);
    expect(isTruncatedFinish('stop')).toBe(false);
  });

  it('Gemini streaming throws on a SAFETY block with no output', async () => {
    await expect(chatTransportAdapter('gemini-native').parseStream(
      sseResponse('data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n'),
      () => {},
    )).rejects.toThrow(/blocked|SAFETY/i);
  });

  it('retries a 429 then succeeds (G2)', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '1' } });
      return sseResponse('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }) as unknown as typeof fetch;
    const run = createStreamingProviderTurn({
      adapter: chatTransportAdapter('openai-compatible'),
      profile: { provider: 'openai', apiFormat: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      apiKey: 'k', systemPrompt: 'SYS', model: 'gpt-4o', fetchImpl,
    });
    const turn = await run([{ role: 'user', content: 'hi' }], () => {});
    expect(calls).toBe(2);
    expect(turn.text).toBe('ok');
  }, 10_000);

  it('does NOT retry a 4xx client error', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('{"error":{"message":"bad key"}}', { status: 401 });
    }) as unknown as typeof fetch;
    const run = createStreamingProviderTurn({
      adapter: chatTransportAdapter('openai-compatible'),
      profile: { provider: 'openai', apiFormat: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      apiKey: 'k', systemPrompt: 'SYS', model: 'gpt-4o', fetchImpl,
    });
    await expect(run([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow(/401|bad key/);
    expect(calls).toBe(1);
  });
});

describe('usage + citations (Phase G3.3/G4.2)', () => {
  it('OpenAI parseStream extracts usage from the final include_usage frame', async () => {
    const turn = await chatTransportAdapter('openai-compatible').parseStream(
      sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":64}}}\n\ndata: [DONE]\n\n'),
      () => {},
    );
    expect(turn.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 64 });
  });

  it('Anthropic parseStream extracts usage + web_search citations', async () => {
    const turn = await chatTransportAdapter('anthropic-messages').parseStream(
      sseResponse(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":200,"cache_read_input_tokens":150}}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://helium.com/plans","title":"Helium plans"}]}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"It is $20."}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":45}}\n\n',
      ),
      () => {},
    );
    expect(turn.text).toBe('It is $20.');
    expect(turn.usage).toEqual({ inputTokens: 200, outputTokens: 45, cacheReadTokens: 150 });
    expect(turn.citations).toEqual([{ url: 'https://helium.com/plans', title: 'Helium plans' }]);
  });

  it('the loop sums usage across turns and emits usage + citations before done', async () => {
    const events: AgentChatStreamEvent[] = [];
    let turn = 0;
    const runProviderTurn = async () => {
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'get_token_price', args: '{"query":"SOL"}' }], usage: { inputTokens: 100, outputTokens: 10 } };
      return { text: 'done', toolCalls: [], usage: { inputTokens: 150, outputTokens: 20 }, citations: [{ url: 'https://x.com/a' }] };
    };
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'price?' }] },
      adapter: chatTransportAdapter('openai-compatible'),
      runProviderTurn,
      executeTool: async () => ({ summary: 'SOL: $150', data: { price: 150 } }),
      emit: (e) => { events.push(e); },
    });
    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toEqual({ type: 'usage', usage: { inputTokens: 250, outputTokens: 30 } });
    expect(events.find((e) => e.type === 'citations')).toEqual({ type: 'citations', citations: [{ url: 'https://x.com/a' }] });
    // usage/citations must precede done.
    expect(events.findIndex((e) => e.type === 'usage')).toBeLessThan(events.findIndex((e) => e.type === 'done'));
  });
});

describe('loop never strands a tool chip when executeTool throws (F2)', () => {
  it('emits tool_status done + an isError result, then finishes', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    let turn = 0;
    const runProviderTurn = async (_messages: unknown[], _onToken: (t: string) => void) => {
      turn += 1;
      if (turn === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'get_token_price', args: '{"query":"SOL"}' }] };
      return { text: 'done', toolCalls: [] };
    };
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'price?' }] },
      adapter,
      runProviderTurn,
      executeTool: async () => { throw new Error('boom'); },
      emit: (e) => { events.push(e); },
    });
    const statuses = events.filter((e) => e.type === 'tool_status');
    expect(statuses.some((e) => e.type === 'tool_status' && e.phase === 'start')).toBe(true);
    expect(statuses.some((e) => e.type === 'tool_status' && e.phase === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
