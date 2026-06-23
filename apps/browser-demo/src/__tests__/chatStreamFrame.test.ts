import { describe, expect, it, vi } from 'vitest';

import { consumeChatSseResponse, dispatchChatStreamFrame, type ChatStreamHandlers } from '../planner.js';

function handlers(): Required<Pick<ChatStreamHandlers, 'onToken' | 'onToolStatus' | 'onProposal' | 'onError' | 'onDone'>> {
  return {
    onToken: vi.fn(),
    onToolStatus: vi.fn(),
    onProposal: vi.fn(),
    onError: vi.fn(),
    onDone: vi.fn(),
  };
}

describe('dispatchChatStreamFrame', () => {
  it('routes a token event', () => {
    const h = handlers();
    dispatchChatStreamFrame('data: {"type":"token","text":"hi "}', h);
    expect(h.onToken).toHaveBeenCalledWith('hi ');
  });

  it('routes a tool_status event', () => {
    const h = handlers();
    dispatchChatStreamFrame('data: {"type":"tool_status","tool":"get_token_price","phase":"start","label":"Checking price…"}', h);
    expect(h.onToolStatus).toHaveBeenCalledWith(expect.objectContaining({ tool: 'get_token_price', phase: 'start' }));
  });

  it('routes a proposal event', () => {
    const h = handlers();
    dispatchChatStreamFrame('data: {"type":"proposal","proposal":{"kind":"swap","summary":"s","params":{},"requiresApproval":true}}', h);
    expect(h.onProposal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'swap', requiresApproval: true }));
  });

  it('routes error and done events', () => {
    const h = handlers();
    dispatchChatStreamFrame('data: {"type":"error","message":"boom"}', h);
    expect(h.onError).toHaveBeenCalledWith('boom');
    dispatchChatStreamFrame('data: {"type":"done","result":{"answer":"a","checkedAt":"t","source":"ai"}}', h);
    expect(h.onDone).toHaveBeenCalledWith(expect.objectContaining({ answer: 'a' }));
  });

  it('joins multi-line data and ignores [DONE]/empty/non-data frames', () => {
    const h = handlers();
    dispatchChatStreamFrame('data: {"type":"token",\ndata: "text":"x"}', h);
    expect(h.onToken).toHaveBeenCalledWith('x');
    const h2 = handlers();
    dispatchChatStreamFrame('data: [DONE]', h2);
    dispatchChatStreamFrame(': heartbeat comment', h2);
    dispatchChatStreamFrame('', h2);
    expect(h2.onToken).not.toHaveBeenCalled();
    expect(h2.onDone).not.toHaveBeenCalled();
  });

  it('does not throw on malformed JSON', () => {
    const h = handlers();
    expect(() => dispatchChatStreamFrame('data: {not json', h)).not.toThrow();
    expect(h.onToken).not.toHaveBeenCalled();
  });
});

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('consumeChatSseResponse', () => {
  it('reassembles split frames and tolerates CRLF delimiters', async () => {
    const h = handlers();
    await consumeChatSseResponse(streamResponse([
      'data: {"type":"token","text":"hel',
      'lo"}\r\n\r\n: ping\r\n\r\n',
      'data: {"type":"done","result":{"answer":"hello","checkedAt":"t","source":"ai"}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]), h);

    expect(h.onToken).toHaveBeenCalledWith('hello');
    expect(h.onDone).toHaveBeenCalledWith(expect.objectContaining({ answer: 'hello' }));
  });

  it('falls back to response.text() when the body is not streamable (WebView edge)', async () => {
    const h = handlers();
    const body = 'data: {"type":"token","text":"hi"}\n\ndata: {"type":"done","result":{"answer":"hi","checkedAt":"t","source":"ai"}}\n\n';
    const fake = { body: null, text: async () => body } as unknown as Response;
    await consumeChatSseResponse(fake, h);
    expect(h.onToken).toHaveBeenCalledWith('hi');
    expect(h.onDone).toHaveBeenCalledWith(expect.objectContaining({ answer: 'hi' }));
  });

  it('stops processing when the abort signal is already aborted', async () => {
    const h = handlers();
    const controller = new AbortController();
    controller.abort();
    await consumeChatSseResponse(streamResponse([
      'data: {"type":"token","text":"x"}\n\n',
      'data: {"type":"done","result":{"answer":"x","checkedAt":"t","source":"ai"}}\n\n',
    ]), h, controller.signal);
    expect(h.onToken).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
  });
});
