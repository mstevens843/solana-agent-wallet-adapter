import { describe, expect, it, vi } from 'vitest';

import {
  anthropicHeaders,
  bearerJsonHeaders,
  chatAgenticSystemPrompt,
  chatLoopExhaustedMessage,
  chatNoTextFallback,
  chatRetryDelayMs,
  chatToolsGemini,
  chatTransportAdapter,
  chatTruncatedSuffix,
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
    // Reasoning fields only apply on a native OpenAI/OpenRouter route (H7-A1).
    const reasoning = a.buildBody('SYS', [], 'gpt-5', [], { openAiNative: true });
    expect(reasoning.max_completion_tokens).toBeGreaterThan(0);
    expect(reasoning.max_tokens).toBeUndefined();
    expect(reasoning.temperature).toBeUndefined();
    const standard = a.buildBody('SYS', [], 'gpt-4o', [], { openAiNative: true });
    expect(standard.max_tokens).toBeGreaterThan(0);
    expect(standard.max_completion_tokens).toBeUndefined();
    expect(standard.temperature).toBe(0.3);
  });

  it('maps reasoning depth per provider (H2)', () => {
    const oai = chatTransportAdapter('openai-compatible');
    // o-series gets reasoning_effort ONLY on a native OpenAI/OpenRouter route; 'minimal' clamps to 'low' for non-gpt-5.
    expect(oai.buildBody('S', [], 'o3', [], { reasoningEffort: 'high', openAiNative: true }).reasoning_effort).toBe('high');
    expect(oai.buildBody('S', [], 'o3', [], { reasoningEffort: 'minimal', openAiNative: true }).reasoning_effort).toBe('low');
    expect(oai.buildBody('S', [], 'gpt-5', [], { reasoningEffort: 'minimal', openAiNative: true }).reasoning_effort).toBe('minimal');
    // Non-reasoning models get NO reasoning_effort.
    expect(oai.buildBody('S', [], 'gpt-4o', [], { reasoningEffort: 'high', openAiNative: true }).reasoning_effort).toBeUndefined();
    // Anthropic: ONLY 'high' enables extended thinking (+ DROP temperature). The default
    // 'medium' stays fast (no thinking tax) so simple lookups don't pay the per-turn cost.
    const aHigh = chatTransportAdapter('anthropic-messages').buildBody('S', [], 'claude-sonnet-4', [], { reasoningEffort: 'high' });
    expect((aHigh.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThan(0);
    expect(aHigh.temperature).toBeUndefined();
    const aMed = chatTransportAdapter('anthropic-messages').buildBody('S', [], 'claude-sonnet-4', [], { reasoningEffort: 'medium' });
    expect(aMed.thinking).toBeUndefined();
    expect(aMed.temperature).toBe(0.3);
    const aLow = chatTransportAdapter('anthropic-messages').buildBody('S', [], 'claude-sonnet-4', [], { reasoningEffort: 'low' });
    expect(aLow.thinking).toBeUndefined();
    expect(aLow.temperature).toBe(0.3);
    // Gemini 2.5 gets thinkingConfig; non-2.5 does not.
    const g25 = chatTransportAdapter('gemini-native').buildBody('S', [], 'gemini-2.5-flash', [], { reasoningEffort: 'minimal' });
    expect(((g25.generationConfig as { thinkingConfig?: { thinkingBudget: number } }).thinkingConfig)?.thinkingBudget).toBe(128);
    const g15 = chatTransportAdapter('gemini-native').buildBody('S', [], 'gemini-1.5-flash', [], { reasoningEffort: 'minimal' });
    expect((g15.generationConfig as { thinkingConfig?: unknown }).thinkingConfig).toBeUndefined();
  });

  it('H7-A1: custom gateway (openAiNative=false) with an o-named model gets NO OpenAI-only fields', () => {
    const oai = chatTransportAdapter('openai-compatible');
    // A local gateway model merely NAMED 'o1-local' must use max_tokens, no reasoning_effort, keep temperature.
    const body = oai.buildBody('S', [], 'o1-local', [], { reasoningEffort: 'high', openAiNative: false });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.3);
    // Genuine OpenAI o-series still gets the reasoning fields.
    const real = oai.buildBody('S', [], 'o1', [], { reasoningEffort: 'high', openAiNative: true });
    expect(real.max_completion_tokens).toBeDefined();
    expect(real.max_tokens).toBeUndefined();
    expect(real.temperature).toBeUndefined();
  });

  it('H7-A2/A3: gemini regex requires the decimal + flash-lite floors at 512', () => {
    const gem = chatTransportAdapter('gemini-native');
    const cfg = (m: string, lvl: 'minimal' | 'low') => (gem.buildBody('S', [], m, [], { reasoningEffort: lvl }).generationConfig as { thinkingConfig?: { thinkingBudget: number } }).thinkingConfig;
    // 'gemini-25-flash' (no decimal) must NOT match → no thinkingConfig.
    expect(cfg('gemini-25-flash', 'minimal')).toBeUndefined();
    // Flash-Lite 'minimal' floors at 512 (API minimum); Flash stays 128.
    expect(cfg('gemini-2.5-flash-lite', 'minimal')?.thinkingBudget).toBe(512);
    expect(cfg('gemini-2.5-flash', 'minimal')?.thinkingBudget).toBe(128);
    expect(cfg('gemini-2.5-flash-lite', 'low')?.thinkingBudget).toBe(1024);
  });

  it('H7-B: loop fallback strings localize by uiLanguage (no English leak)', () => {
    expect(chatLoopExhaustedMessage('es')).not.toBe(chatLoopExhaustedMessage('en'));
    expect(chatNoTextFallback(false, 'ja')).not.toBe(chatNoTextFallback(false, 'en'));
    expect(chatNoTextFallback(true, 'de')).not.toBe(chatNoTextFallback(false, 'de'));
    expect(chatTruncatedSuffix('ru')).not.toBe(chatTruncatedSuffix('en'));
    // unknown / omitted language falls back to English, never empty.
    expect(chatLoopExhaustedMessage('xx')).toBe(chatLoopExhaustedMessage('en'));
    expect(chatTruncatedSuffix()).toBe(chatTruncatedSuffix('en'));
    expect(chatLoopExhaustedMessage('en')).toBeTruthy();
  });

  it('H7-F1: OpenAI [DONE] with trailing whitespace terminates (no leak after it)', async () => {
    const enc = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    void (async () => {
      for (const c of [
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE] \n\n', // trailing whitespace
        'data: {"choices":[{"delta":{"content":"LEAK"}}]}\n\n', // after [DONE] — must be ignored
      ]) ctrl!.enqueue(enc.encode(c));
      ctrl!.close();
    })();
    const turn = await chatTransportAdapter('openai-compatible').parseStream(new Response(stream), () => {});
    expect(turn.text).toBe('hi');
    expect(turn.text).not.toContain('LEAK');
  });

  it('H8-B: Retry-After HTTP-date is honored, not the aggressive exponential', () => {
    const future = new Date(Date.now() + 6000).toUTCString(); // RFC 7231 HTTP-date form
    expect(chatRetryDelayMs(0, future)).toBeGreaterThan(1500); // ~6s (clamped to 8s)
    expect(chatRetryDelayMs(0, '5')).toBeGreaterThan(1500); // numeric seconds still work
    // a non-date / non-numeric header falls back to the attempt-0 exponential (~500ms).
    expect(chatRetryDelayMs(0, 'garbage')).toBeLessThan(800);
    // a PAST date also falls back (no negative/zero wait surfacing as the date).
    expect(chatRetryDelayMs(0, new Date(Date.now() - 60000).toUTCString())).toBeLessThan(800);
  });

  it('H8-D: token-symbol guidance matches CHAT_MAJOR_SYMBOLS (no SOL/USDC-only drift)', () => {
    // An unresolved token error now names the full major-symbol set.
    const bad = validateChatProposedAction({ kind: 'transfer_spl', summary: 's', params: { recipient: USDC, amount: '1', token: 'UNKNOWNCOIN' } });
    expect(bad.proposal).toBeUndefined();
    expect(bad.error).toMatch(/USDT|PYUSD/);
    // USDT by symbol is accepted (the prepare path resolves it) — no search_tokens needed.
    const ok = validateChatProposedAction({ kind: 'transfer_spl', summary: 's', params: { recipient: USDC, amount: '1', token: 'USDT' } });
    expect(ok.proposal).toBeDefined();
    // The system prompt's symbol guidance matches the validator (no SOL/USDC-only text).
    const prompt = chatAgenticSystemPrompt({ walletAddress: USDC });
    expect(prompt).toContain('USDT');
    expect(prompt).toContain('PYUSD');
  });

  it('H8-E: canonicalizes scientific-notation amounts to a plain decimal', () => {
    const r = validateChatProposedAction({ kind: 'transfer_sol', summary: 's', params: { recipient: USDC, amountSol: '1e9' } });
    expect((r.proposal!.params as { amountSol: string }).amountSol).toBe('1000000000');
    const swap = validateChatProposedAction({ kind: 'swap', summary: 's', params: { amount: '2e3', inputToken: 'SOL', outputToken: 'USDC' } });
    expect((swap.proposal!.params as { amount: string }).amount).toBe('2000');
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

  it('Gemini buildBody relaxes DANGEROUS_CONTENT to BLOCK_ONLY_HIGH (never BLOCK_NONE, which 400s non-allowlisted keys)', () => {
    const body = chatTransportAdapter('gemini-native').buildBody('SYS', [], 'gemini-2.5-flash', []);
    const settings = body.safetySettings as Array<{ category: string; threshold: string }>;
    // BLOCK_NONE returns a hard 400 ("restricted HarmBlockThreshold setting BLOCK_NONE") on
    // accounts that are not allowlisted / not on invoiced billing — it must never be sent.
    expect(settings.every((s) => s.threshold !== 'BLOCK_NONE')).toBe(true);
    expect(settings.find((s) => s.category === 'HARM_CATEGORY_DANGEROUS_CONTENT')?.threshold).toBe('BLOCK_ONLY_HIGH');
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

  it('parseStream consumes a Response rebuilt from native chunks (H4a streaming contract)', async () => {
    // Native relays raw SSE chunks; JS rebuilds a Response + reuses parseStream.
    const chunks = [
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ];
    const encoder = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    void (async () => { for (const c of chunks) ctrl!.enqueue(encoder.encode(c)); ctrl!.close(); })();
    const tokens: string[] = [];
    const turn = await chatTransportAdapter('openai-compatible').parseStream(new Response(stream), (t) => { tokens.push(t); });
    expect(tokens.join('')).toBe('Hello');
    expect(turn.text).toBe('Hello');
    expect(turn.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  // Helper: feed raw SSE chunks through a synthetic Response → parseStream (the native
  // streaming relay contract). Returns the streamed tokens + the parsed turn.
  async function relayChunks(transport: 'anthropic-messages' | 'gemini-native', chunks: string[]) {
    const enc = new TextEncoder();
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    void (async () => { for (const c of chunks) ctrl!.enqueue(enc.encode(c)); ctrl!.close(); })();
    const tokens: string[] = [];
    const turn = await chatTransportAdapter(transport).parseStream(new Response(stream), (t) => { tokens.push(t); });
    return { tokens, turn };
  }

  it('Anthropic native chunk relay streams text + DROPS thinking blocks (H4a/H5.7 + H2 no-leak)', async () => {
    // thinking block (index 0) must be dropped; the text block (index 1) is the answer.
    const { tokens, turn } = await relayChunks('anthropic-messages', [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"SECRET reasoning"}}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" there"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    ]);
    expect(tokens.join('')).toBe('Hi there');
    expect(turn.text).toBe('Hi there');
    expect(turn.text).not.toContain('SECRET');
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('Gemini native chunk relay streams text + DROPS thought parts (H4a/H5.7 + H2 no-leak)', async () => {
    const { tokens, turn } = await relayChunks('gemini-native', [
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"SECRET reasoning"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" there"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n\n',
    ]);
    expect(tokens.join('')).toBe('Hi there');
    expect(turn.text).toBe('Hi there');
    expect(turn.text).not.toContain('SECRET');
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
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

// ── Reasoning-depth + Gemini correctness (audit fixes B1/B2/B3/C5) ──────────────────────
describe('Gemini tool-schema sanitization (B2)', () => {
  function hasEmptyObjectSchema(node: unknown): boolean {
    if (!node || typeof node !== 'object') return false;
    const n = node as Record<string, unknown>;
    if (n.type === 'object') {
      const props = n.properties && typeof n.properties === 'object' ? (n.properties as Record<string, unknown>) : undefined;
      if (!props || Object.keys(props).length === 0) return true;
      return Object.values(props).some(hasEmptyObjectSchema);
    }
    if (n.type === 'array' && n.items) return hasEmptyObjectSchema(n.items);
    return false;
  }
  function geminiDecls(): Array<Record<string, unknown>> {
    return (chatToolsGemini()[0] as { functionDeclarations: Array<Record<string, unknown>> }).functionDeclarations;
  }

  it('no functionDeclaration sends an OBJECT schema with empty/absent properties (Gemini 400 guard)', () => {
    for (const d of geminiDecls()) {
      if (d.parameters !== undefined) expect(hasEmptyObjectSchema(d.parameters)).toBe(false);
    }
  });

  it('omits parameters for no-arg tools and gives the proposal params a non-empty properties map', () => {
    const byName = new Map(geminiDecls().map((d) => [d.name as string, d]));
    expect(byName.get('get_market_regime')?.parameters).toBeUndefined();
    expect(byName.get('get_wallet_history')?.parameters).toBeUndefined();
    const params = byName.get('propose_wallet_action')?.parameters as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(params.properties.params?.properties ?? {}).length).toBeGreaterThan(0);
  });
});

describe('Anthropic extended-thinking block replay (B1)', () => {
  const adapter = chatTransportAdapter('anthropic-messages');

  it('parseResponse captures thinking + redacted_thinking blocks in order', () => {
    const out = adapter.parseResponse({
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
        { type: 'redacted_thinking', data: 'enc' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'get_token_price', input: { query: 'SOL' } },
      ],
      stop_reason: 'tool_use',
    });
    expect(out.thinking).toEqual([
      { type: 'thinking', thinking: 'let me think', signature: 'sig123' },
      { type: 'redacted_thinking', data: 'enc' },
    ]);
    expect(out.toolCalls.map((t) => t.name)).toEqual(['get_token_price']);
  });

  it('pushAssistant replays thinking blocks BEFORE the tool_use block (else the next turn 400s)', () => {
    const messages: unknown[] = [];
    adapter.pushAssistant(messages, {
      text: 'hi',
      toolCalls: [{ id: 't1', name: 'get_token_price', args: '{"query":"SOL"}' }],
      thinking: [{ type: 'thinking', thinking: 'reason', signature: 'sig' }],
    });
    const content = (messages[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'reason', signature: 'sig' });
    const thinkingIdx = content.findIndex((b) => b.type === 'thinking');
    const toolIdx = content.findIndex((b) => b.type === 'tool_use');
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(toolIdx);
  });

  it('parseStream captures thinking_delta + signature_delta', async () => {
    const frames = [
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"abc"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
    ].join('');
    const out = await adapter.parseStream(sseResponse(frames), () => {});
    expect(out.thinking).toEqual([{ type: 'thinking', thinking: 'abc', signature: 'sig' }]);
    expect(out.text).toBe('hello');
  });
});

describe('reasoning-depth output headroom (B3)', () => {
  it('Gemini maxOutputTokens exceeds the thinking budget at High', () => {
    const body = chatTransportAdapter('gemini-native').buildBody('SYS', [], 'gemini-2.5-flash', [], { streaming: true, reasoningEffort: 'high' }) as {
      generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number } };
    };
    expect(body.generationConfig.thinkingConfig?.thinkingBudget).toBe(8192);
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThan(body.generationConfig.thinkingConfig!.thinkingBudget);
  });

  it('OpenAI max_completion_tokens is raised above the answer floor for reasoning models at High', () => {
    const body = chatTransportAdapter('openai-compatible').buildBody('SYS', [], 'o3', [], { streaming: true, reasoningEffort: 'high', openAiNative: true }) as {
      max_completion_tokens?: number;
      reasoning_effort?: string;
    };
    expect(body.max_completion_tokens ?? 0).toBeGreaterThan(2048);
    expect(body.reasoning_effort).toBe('high');
  });
});

describe('Anthropic model-generation gate (C5)', () => {
  const a = chatTransportAdapter('anthropic-messages');
  type AnthropicBody = { temperature?: number; thinking?: { type: string; budget_tokens?: number } };

  it('older models (sonnet-4-5): temperature at Medium, enabled+budget_tokens at High, no temperature', () => {
    const med = a.buildBody('S', [], 'claude-sonnet-4-5', [], { streaming: true, reasoningEffort: 'medium' }) as AnthropicBody;
    expect(med.temperature).toBe(0.3);
    expect(med.thinking).toBeUndefined();
    const high = a.buildBody('S', [], 'claude-sonnet-4-5', [], { streaming: true, reasoningEffort: 'high' }) as AnthropicBody;
    expect(high.thinking).toEqual({ type: 'enabled', budget_tokens: 6144 });
    expect(high.temperature).toBeUndefined();
  });

  it('flagship (opus-4-8): never sends temperature; uses adaptive thinking at High', () => {
    const med = a.buildBody('S', [], 'claude-opus-4-8', [], { streaming: true, reasoningEffort: 'medium' }) as AnthropicBody;
    expect(med.temperature).toBeUndefined();
    expect(med.thinking).toBeUndefined();
    const high = a.buildBody('S', [], 'claude-opus-4-8', [], { streaming: true, reasoningEffort: 'high' }) as AnthropicBody;
    expect(high.thinking).toEqual({ type: 'adaptive' });
    expect(high.temperature).toBeUndefined();
  });
});
