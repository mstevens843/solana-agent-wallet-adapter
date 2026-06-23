import { describe, expect, it } from 'vitest';

import { iterateProviderSse, parseSseFrame } from '../aiPlanner.js';

describe('parseSseFrame', () => {
  it('parses an Anthropic event + data frame', () => {
    expect(parseSseFrame('event: content_block_delta\ndata: {"x":1}')).toEqual({ event: 'content_block_delta', data: '{"x":1}' });
  });

  it('parses an OpenAI data-only frame', () => {
    expect(parseSseFrame('data: {"a":1}')).toEqual({ event: undefined, data: '{"a":1}' });
  });

  it('joins multi-line data', () => {
    expect(parseSseFrame('data: line1\ndata: line2')?.data).toBe('line1\nline2');
  });

  it('tolerates CRLF line endings', () => {
    expect(parseSseFrame('event: ping\r\ndata: {"t":1}\r')).toEqual({ event: 'ping', data: '{"t":1}' });
  });

  it('returns null for comment/heartbeat frames with no data line', () => {
    expect(parseSseFrame(': ping')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
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
  return { body: stream } as unknown as Response;
}

async function collect(chunks: string[]): Promise<Array<{ event?: string; data: string }>> {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const frame of iterateProviderSse(streamResponse(chunks))) out.push(frame);
  return out;
}

describe('iterateProviderSse', () => {
  it('reassembles a frame split across chunks', async () => {
    const events = await collect(['event: content_block_delta\ndata: {"x"', ':1}\n\n']);
    expect(events).toEqual([{ event: 'content_block_delta', data: '{"x":1}' }]);
  });

  it('yields each OpenAI frame and surfaces [DONE]', async () => {
    const events = await collect(['data: {"a":1}\n\n', 'data: [DONE]\n\n']);
    expect(events).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ]);
  });

  it('flushes a trailing frame not terminated by a blank line', async () => {
    const events = await collect(['data: {"a":1}']);
    expect(events).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it('skips comment/heartbeat frames', async () => {
    const events = await collect([': ping\n\n', 'data: {"b":2}\n\n']);
    expect(events).toEqual([{ event: undefined, data: '{"b":2}' }]);
  });

  it('splits multiple CRLF-delimited frames', async () => {
    const events = await collect([
      'data: {"a":1}\r\n\r\n',
      ': ping\r\n\r\n',
      'event: content_block_delta\r\ndata: {"b":2}\r\n\r\n',
    ]);
    expect(events).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: 'content_block_delta', data: '{"b":2}' },
    ]);
  });
});
