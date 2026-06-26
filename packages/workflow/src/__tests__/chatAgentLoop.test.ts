import { describe, expect, it, vi } from 'vitest';

import {
  chatTransportAdapter,
  createStreamingProviderTurn,
  resolveChatTransport,
  runAgentChatLoop,
  streamAgentChat,
} from '../chatAgent/index.js';
import type { AgentChatStreamEvent, ChatModelProfile, ChatTurnOutcome } from '../chatAgent/index.js';

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const PROFILE_OPENAI: ChatModelProfile = { provider: 'openai', apiFormat: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

describe('resolveChatTransport', () => {
  it('routes providers to the right tool-capable transport', () => {
    expect(resolveChatTransport(PROFILE_OPENAI)).toBe('openai-compatible');
    expect(resolveChatTransport({ provider: 'anthropic', apiFormat: 'anthropic', baseUrl: '', model: 'claude-sonnet-4-5' })).toBe('anthropic-messages');
    // Gemini keeps its native transport but now joins the tool loop (not single-shot).
    expect(resolveChatTransport({ provider: 'gemini', apiFormat: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash-lite' })).toBe('gemini-native');
    expect(resolveChatTransport({ provider: 'openrouter', apiFormat: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' })).toBe('anthropic-messages');
    expect(resolveChatTransport({ provider: 'codex', apiFormat: 'openai-compatible', baseUrl: '', model: 'x', engine: 'connector' })).toBe('cli-agent');
  });
});

describe('runAgentChatLoop orchestration', () => {
  it('runs a read tool then answers, emitting events in order', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    const turns: ChatTurnOutcome[] = [
      { text: '', toolCalls: [{ id: 'c1', name: 'get_token_price', args: '{"query":"SOL"}' }] },
      { text: 'SOL is $150.', toolCalls: [] },
    ];
    let i = 0;
    const executeTool = vi.fn(async () => ({ summary: 'SOL: $150', data: { query: 'SOL', prices: [{ usdPrice: 150 }] } }));
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'price of SOL?' }], walletAddress: 'WALLET' },
      adapter,
      runProviderTurn: async (_messages, onToken) => {
        const turn = turns[i++]!;
        if (turn.text) onToken(turn.text);
        return turn;
      },
      executeTool,
      emit: (e) => { events.push(e); },
    });
    expect(executeTool).toHaveBeenCalledWith('get_token_price', { query: 'SOL' }, 'WALLET');
    expect(events.map((e) => e.type)).toEqual(['tool_status', 'tool_status', 'token', 'done']);
    const toolStart = events[0] as Extract<AgentChatStreamEvent, { type: 'tool_status' }>;
    expect(toolStart).toMatchObject({ tool: 'get_token_price', phase: 'start' });
    const done = events.at(-1) as Extract<AgentChatStreamEvent, { type: 'done' }>;
    expect(done.result.answer).toBe('SOL is $150.');
  });

  it('validates and emits a wallet-action proposal', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    const proposalArgs = JSON.stringify({
      kind: 'swap',
      summary: 'Swap 1 SOL to USDC',
      params: { inputToken: 'SOL', outputToken: 'USDC', amount: '1' },
    });
    const turns: ChatTurnOutcome[] = [
      { text: '', toolCalls: [{ id: 'p1', name: 'propose_wallet_action', args: proposalArgs }] },
      { text: 'Review the card and approve it.', toolCalls: [] },
    ];
    let i = 0;
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'swap 1 sol to usdc' }], walletAddress: 'WALLET' },
      adapter,
      runProviderTurn: async (_m, onToken) => { const t = turns[i++]!; if (t.text) onToken(t.text); return t; },
      executeTool: async () => ({ summary: '', data: {} }),
      emit: (e) => { events.push(e); },
    });
    const proposal = events.find((e) => e.type === 'proposal') as Extract<AgentChatStreamEvent, { type: 'proposal' }>;
    expect(proposal.proposal).toMatchObject({ kind: 'swap', requiresApproval: true });
    expect((events.at(-1) as Extract<AgentChatStreamEvent, { type: 'done' }>).type).toBe('done');
  });

  it('rejects a proposal with a non-base58 recipient', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    const bad = JSON.stringify({ kind: 'transfer_sol', summary: 'Send', params: { recipient: 'alice', amountSol: '1' } });
    const turns: ChatTurnOutcome[] = [
      { text: '', toolCalls: [{ id: 'p1', name: 'propose_wallet_action', args: bad }] },
      { text: 'I need the exact address.', toolCalls: [] },
    ];
    let i = 0;
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'send 1 sol to alice' }] },
      adapter,
      runProviderTurn: async (_m) => turns[i++]!,
      executeTool: async () => ({ summary: '', data: {} }),
      emit: (e) => { events.push(e); },
    });
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
  });

  it('stops at maxIterations with a graceful done', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'loop forever' }] },
      adapter,
      // Always asks for another tool — never terminates on its own.
      runProviderTurn: async () => ({ text: '', toolCalls: [{ id: 'c', name: 'get_market_regime', args: '{}' }] }),
      executeTool: async () => ({ summary: 'regime', data: {} }),
      emit: (e) => { events.push(e); },
      maxIterations: 2,
    });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('H8-A: trims a history ending on an assistant turn so the model generates after a user turn', async () => {
    const adapter = chatTransportAdapter('openai-compatible');
    let seen: Array<{ role: string }> = [];
    await runAgentChatLoop({
      request: { messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'dangling assistant turn' }, // malformed: ends on assistant
      ] },
      adapter,
      runProviderTurn: async (messages) => { seen = messages as Array<{ role: string }>; return { text: 'ok', toolCalls: [] }; },
      executeTool: async () => ({ summary: '', data: {} }),
      emit: () => {},
    });
    const roles = seen.map((m) => m.role).filter((r) => r !== 'system');
    expect(roles[roles.length - 1]).toBe('user'); // ends on user (trailing assistant dropped)
    for (let i = 1; i < roles.length; i += 1) expect(roles[i]).not.toBe(roles[i - 1]); // strict alternation
  });

  it('H7-F2: gives a final response turn after exhausting iterations with pending tools', async () => {
    const events: AgentChatStreamEvent[] = [];
    const adapter = chatTransportAdapter('openai-compatible');
    let calls = 0;
    await runAgentChatLoop({
      request: { messages: [{ role: 'user', content: 'multi-step' }] },
      adapter,
      runProviderTurn: async (_m, onToken) => {
        calls += 1;
        if (calls <= 2) return { text: '', toolCalls: [{ id: `c${calls}`, name: 'get_market_regime', args: '{}' }] };
        onToken('Here is the summary.'); // the closing turn finally answers
        return { text: 'Here is the summary.', toolCalls: [] };
      },
      executeTool: async () => ({ summary: 'regime', data: {} }),
      emit: (e) => { events.push(e); },
      maxIterations: 2,
    });
    expect(calls).toBe(3); // 2 tool iterations + 1 closure turn
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect((done as { result?: { answer?: string } }).result?.answer).toBe('Here is the summary.');
  });
});

describe('provider stream parsing', () => {
  it('parses OpenAI tool_calls + text deltas', async () => {
    const adapter = chatTransportAdapter('openai-compatible');
    const toolTurn = await adapter.parseStream(
      sseResponse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_token_price","arguments":"{\\"query\\":\\"SOL\\"}"}}]}}]}\n\ndata: [DONE]\n\n'),
      () => {},
    );
    expect(toolTurn.toolCalls).toEqual([{ id: 'call_1', name: 'get_token_price', args: '{"query":"SOL"}' }]);

    const tokens: string[] = [];
    const textTurn = await adapter.parseStream(
      sseResponse('data: {"choices":[{"delta":{"content":"SOL is $150"}}]}\n\ndata: [DONE]\n\n'),
      (t) => { tokens.push(t); },
    );
    expect(textTurn.text).toBe('SOL is $150');
    expect(tokens).toEqual(['SOL is $150']);
  });

  it('parses Anthropic tool_use + text blocks', async () => {
    const adapter = chatTransportAdapter('anthropic-messages');
    const turn = await adapter.parseStream(
      sseResponse(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"get_token_safety"}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"mint\\":\\"So11111111111111111111111111111111111111112\\"}"}}\n\n',
      ),
      () => {},
    );
    expect(turn.toolCalls).toEqual([{ id: 'tu_1', name: 'get_token_safety', args: '{"mint":"So11111111111111111111111111111111111111112"}' }]);
  });

  it('parses Gemini functionCall + text parts', async () => {
    const adapter = chatTransportAdapter('gemini-native');
    const tokens: string[] = [];
    const turn = await adapter.parseStream(
      sseResponse(
        'data: {"candidates":[{"content":{"parts":[{"text":"Checking. "}]}}]}\n\n' +
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_token_price","args":{"query":"SOL"}}}]}}]}\n\n',
      ),
      (t) => { tokens.push(t); },
    );
    expect(tokens).toEqual(['Checking. ']);
    expect(turn.toolCalls).toEqual([{ id: 'gem_0', name: 'get_token_price', args: '{"query":"SOL"}' }]);
  });

  it('Anthropic adapter advertises web_search + tolerates its server-tool blocks', async () => {
    const adapter = chatTransportAdapter('anthropic-messages');
    // web_search is in the tool set...
    expect(adapter.toolSpecs().some((t) => (t as { type?: string }).type === 'web_search_20250305')).toBe(true);
    // ...and server_tool_use / web_search_tool_result blocks do NOT become our function calls.
    const turn = await adapter.parseStream(
      sseResponse(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search"}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1"}}\n\n' +
          'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"The plan is $20."}}\n\n',
      ),
      () => {},
    );
    expect(turn.text).toBe('The plan is $20.');
    expect(turn.toolCalls).toEqual([]);
  });

  it('parseResponse tolerates Anthropic web_search blocks (non-streaming)', () => {
    const adapter = chatTransportAdapter('anthropic-messages');
    expect(adapter.parseResponse({
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'helium plan' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
        { type: 'text', text: 'About $20/mo.' },
      ],
    })).toEqual({ text: 'About $20/mo.', toolCalls: [] });
  });
});

describe('OpenRouter attribution headers', () => {
  it('emits HTTP-Referer + X-Title on the keyed fetch when set', async () => {
    const adapter = chatTransportAdapter('openai-compatible');
    const fetchImpl = vi.fn(async () => sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')) as unknown as typeof fetch;
    const run = createStreamingProviderTurn({
      adapter,
      profile: { provider: 'openrouter', apiFormat: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', openRouterReferer: 'https://agentic-signer.com', openRouterTitle: 'Agentic Chat' },
      apiKey: 'or-test',
      systemPrompt: 'SYS',
      model: 'openai/gpt-4o-mini',
      fetchImpl,
    });
    await run([{ role: 'user', content: 'hi' }], () => {});
    const headers = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['HTTP-Referer']).toBe('https://agentic-signer.com');
    expect(headers['X-Title']).toBe('Agentic Chat');
    expect(headers['X-OpenRouter-Metadata']).toBe('enabled');
  });
});

describe('non-streaming parseResponse (native completion path)', () => {
  it('parses an OpenAI /chat/completions response (text + tool_calls)', () => {
    const adapter = chatTransportAdapter('openai-compatible');
    expect(adapter.parseResponse({
      choices: [{ message: { content: 'SOL is $150.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_token_price', arguments: '{"query":"SOL"}' } }] } }],
    })).toEqual({ text: 'SOL is $150.', toolCalls: [{ id: 'c1', name: 'get_token_price', args: '{"query":"SOL"}' }] });
  });

  it('parses an Anthropic /messages response (text + tool_use)', () => {
    const adapter = chatTransportAdapter('anthropic-messages');
    expect(adapter.parseResponse({
      content: [
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'tu_1', name: 'get_token_safety', input: { mint: 'So11111111111111111111111111111111111111112' } },
      ],
    })).toEqual({ text: 'Checking. ', toolCalls: [{ id: 'tu_1', name: 'get_token_safety', args: '{"mint":"So11111111111111111111111111111111111111112"}' }] });
  });

  it('parses a Gemini :generateContent response (text + functionCall)', () => {
    const adapter = chatTransportAdapter('gemini-native');
    expect(adapter.parseResponse({
      candidates: [{ content: { parts: [{ text: 'Looking. ' }, { functionCall: { name: 'get_market_regime', args: {} } }] } }],
    })).toEqual({ text: 'Looking. ', toolCalls: [{ id: 'gem_0', name: 'get_market_regime', args: '{}' }] });
  });

  it('buildBody honors the streaming flag for OpenAI/Anthropic', () => {
    const openai = chatTransportAdapter('openai-compatible');
    expect(openai.buildBody('SYS', [], 'gpt-4o-mini', [], false).stream).toBe(false);
    expect(openai.buildBody('SYS', [], 'gpt-4o-mini', [], true).stream).toBe(true);
    const anthropic = chatTransportAdapter('anthropic-messages');
    expect(anthropic.buildBody('SYS', [], 'claude-sonnet-4-5', [], false).stream).toBe(false);
  });
});

describe('streamAgentChat (end-to-end with mock fetch)', () => {
  it('drives the OpenAI transport: tool call → tool result → answer', async () => {
    const responses = [
      sseResponse('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_token_price","arguments":"{\\"query\\":\\"SOL\\"}"}}]}}]}\n\ndata: [DONE]\n\n'),
      sseResponse('data: {"choices":[{"delta":{"content":"SOL trades near $150."}}]}\n\ndata: [DONE]\n\n'),
    ];
    let call = 0;
    const fetchImpl = vi.fn(async () => responses[call++]!) as unknown as typeof fetch;
    const events: AgentChatStreamEvent[] = [];
    const transport = await streamAgentChat({
      request: { messages: [{ role: 'user', content: 'price of SOL?' }], walletAddress: 'WALLET' },
      profile: PROFILE_OPENAI,
      apiKey: 'sk-test',
      executeTool: async () => ({ summary: 'SOL: $150', data: { prices: [{ usdPrice: 150 }] } }),
      emit: (e) => { events.push(e); },
      fetchImpl,
    });
    expect(transport).toBe('openai-compatible');
    expect(call).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', result: { answer: 'SOL trades near $150.' } });
    // The key was sent as a Bearer header on the keyed fetch.
    const firstHeaders = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]![1].headers as Record<string, string>;
    expect(firstHeaders.authorization).toBe('Bearer sk-test');
  });
});

describe('createStreamingProviderTurn', () => {
  it('builds the request body via the adapter and posts to the resolved endpoint', async () => {
    const adapter = chatTransportAdapter('anthropic-messages');
    const fetchImpl = vi.fn(async () => sseResponse('data: {"type":"message_stop"}\n\n')) as unknown as typeof fetch;
    const run = createStreamingProviderTurn({
      adapter,
      profile: { provider: 'anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
      apiKey: 'ak-test',
      systemPrompt: 'SYS',
      model: 'claude-sonnet-4-5',
      fetchImpl,
    });
    await run([{ role: 'user', content: 'hi' }], () => {});
    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ak-test');
    const body = JSON.parse(init.body as string);
    // System is sent as a cache_control array (prompt caching), not a bare string.
    expect(body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools).toBeTruthy();
    // The last tool carries the cache breakpoint.
    expect(body.tools[body.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });
});
