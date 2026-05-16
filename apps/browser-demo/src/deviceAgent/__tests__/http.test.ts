// FetchHttpExecutor unit tests. Mirrors Kotlin HttpExecutorPolicyTest (HTTPS
// guard) and adds browser-only coverage that Kotlin marked as "instrumented
// test follow-up" (cancellation, 1 MiB body cap). All tests inject a mock
// fetch via the FetchHttpExecutor `fetchImpl` option — no real network, no
// fake timers (all timeouts are sub-100ms real time).

import { describe, expect, it } from 'vitest';

import { ProviderHttpError } from '../provider/errorCodes.js';
import { FetchHttpExecutor } from '../provider/http.js';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function trackingFetch(impl: typeof fetch): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const wrapped: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return impl(input, init);
  };
  return { fetch: wrapped, calls };
}

function streamingResponse(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status });
}

/**
 * Build a mock fetch whose Response body is a ReadableStream we can drive from
 * the test. The stream is `error()`-d when the fetch's signal aborts, so
 * `reader.read()` rejects — exactly mirroring how real browser fetch behaves
 * when its AbortSignal fires mid-body.
 */
function controllableMockFetch(): {
  fetch: typeof fetch;
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const mockFetch: typeof fetch = (_input, init) => {
    const signal = init?.signal;
    if (signal) {
      const onAbort = () => {
        try {
          controller?.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // stream already errored or closed; ignore
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
  return {
    fetch: mockFetch,
    enqueue: (chunk) => controller?.enqueue(chunk),
    close: () => controller?.close(),
  };
}

describe('FetchHttpExecutor — HTTPS guard', () => {
  it('rejects http:// with provider_invalid_config and message referencing https://', async () => {
    let called = false;
    const executor = new FetchHttpExecutor({
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('{}'));
      },
    });

    let captured: unknown = null;
    try {
      await executor.postJson('http://example.com/v1/chat/completions', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(called).toBe(false);
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_invalid_config');
    expect(err.message.includes('https://')).toBe(true);
  });

  it('rejects bare scheme (no protocol prefix)', async () => {
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(new Response('{}')),
    });

    let captured: unknown = null;
    try {
      await executor.postJson('example.com/v1/chat/completions', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_config');
  });

  it('accepts HTTPS:// case-insensitively', async () => {
    let called = false;
    const executor = new FetchHttpExecutor({
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    await executor.postJson('HTTPS://api.example.com/v1/chat/completions', {}, '{}');
    expect(called).toBe(true);
  });
});

describe('FetchHttpExecutor — AbortSignal handling', () => {
  it('throws before calling fetch when external signal is already aborted', async () => {
    let called = false;
    const executor = new FetchHttpExecutor({
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('{}'));
      },
    });
    const controller = new AbortController();
    controller.abort();

    let captured: unknown = null;
    try {
      await executor.postJson('https://api.example.com/v1/x', {}, '{}', controller.signal);
    } catch (err) {
      captured = err;
    }
    expect(called).toBe(false);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).name).toBe('AbortError');
    expect(captured instanceof ProviderHttpError).toBe(false);
  });

  it('propagates external abort fired DURING body read as AbortError (regression: timeout-leak fix)', async () => {
    const { fetch: mockFetch } = controllableMockFetch();
    const executor = new FetchHttpExecutor({ fetchImpl: mockFetch });
    const controller = new AbortController();
    const promise = executor.postJson('https://api.example.com/v1/x', {}, '{}', controller.signal);

    // give the executor a tick to start reading the body
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    let captured: unknown = null;
    try {
      await promise;
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).name).toBe('AbortError');
    expect(captured instanceof ProviderHttpError).toBe(false);
  });

  it('classifies internal timeout DURING body read as provider_timeout (regression: timeout-leak fix)', async () => {
    const { fetch: mockFetch } = controllableMockFetch();
    const executor = new FetchHttpExecutor({
      fetchImpl: mockFetch,
      connectTimeoutMs: 10,
      readTimeoutMs: 10,
    });
    const promise = executor.postJson('https://api.example.com/v1/x', {}, '{}');

    let captured: unknown = null;
    try {
      await promise;
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_timeout');
    expect(err.message).toBe('Provider request timed out.');
  });
});

describe('FetchHttpExecutor — headers', () => {
  it('sets default Content-Type and Accept when caller passes none', async () => {
    const { fetch: wrapped, calls } = trackingFetch(() => Promise.resolve(new Response('{}', { status: 200 })));
    const executor = new FetchHttpExecutor({ fetchImpl: wrapped });

    await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    expect(calls.length).toBe(1);
    const init = calls[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(headers.Accept).toBe('application/json');
  });

  it('lets caller headers override the defaults', async () => {
    const { fetch: wrapped, calls } = trackingFetch(() => Promise.resolve(new Response('{}', { status: 200 })));
    const executor = new FetchHttpExecutor({ fetchImpl: wrapped });

    await executor.postJson(
      'https://api.example.com/v1/x',
      { 'Content-Type': 'application/vnd.custom+json', Authorization: 'Bearer X' },
      '{}',
    );
    const headers = (calls[0]!.init!.headers as Record<string, string>);
    expect(headers['Content-Type']).toBe('application/vnd.custom+json');
    expect(headers.Authorization).toBe('Bearer X');
    expect(headers.Accept).toBe('application/json'); // default still present
  });
});

describe('FetchHttpExecutor — response handling', () => {
  it('returns status and body verbatim for 2xx (does NOT remap non-2xx — provider layer does that)', async () => {
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    });

    const result = await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('returns 4xx status and body without remapping', async () => {
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(new Response('{"error":"oops"}', { status: 401 })),
    });

    const result = await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    expect(result.status).toBe(401);
    expect(result.body).toBe('{"error":"oops"}');
  });

  it('maps fetch TypeError to ProviderHttpError(provider_network)', async () => {
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    let captured: unknown = null;
    try {
      await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_network');
    expect(err.message).toBe('Failed to fetch');
  });
});

describe('FetchHttpExecutor — body cap', () => {
  it('throws provider_invalid_response when streaming body exceeds maxBytes', async () => {
    const overflow = new Uint8Array(150).fill(0x41); // 150 bytes of "A"
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(streamingResponse([overflow])),
      maxBytes: 100,
    });

    let captured: unknown = null;
    try {
      await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_invalid_response');
    expect(err.message.includes('KiB cap')).toBe(true);
  });

  it('throws provider_invalid_response via response.text() fallback when body is null (degraded env)', async () => {
    const oversize = 'X'.repeat(200);
    const fakeResponse = {
      status: 200,
      body: null,
      text: () => Promise.resolve(oversize),
    } as unknown as Response;
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(fakeResponse),
      maxBytes: 100,
    });

    let captured: unknown = null;
    try {
      await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });

  it('returns body successfully when total bytes are under maxBytes', async () => {
    const small = new TextEncoder().encode('{"ok":true}');
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(streamingResponse([small])),
      maxBytes: 1_048_576,
    });

    const result = await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('text() fallback counts UTF-8 bytes, not UTF-16 code units, so multi-byte chars cannot slip past the cap', async () => {
    // 60 code units of "😀" (each emoji is one UTF-16 surrogate pair = 2 code
    // units) but encodes to 240 UTF-8 bytes — over the 100-byte cap.
    const oversize = '😀'.repeat(60);
    expect(oversize.length).toBeLessThan(150); // proves UTF-16 length undercounts
    const fakeResponse = {
      status: 200,
      body: null,
      text: () => Promise.resolve(oversize),
    } as unknown as Response;
    const executor = new FetchHttpExecutor({
      fetchImpl: () => Promise.resolve(fakeResponse),
      maxBytes: 100,
    });

    let captured: unknown = null;
    try {
      await executor.postJson('https://api.example.com/v1/x', {}, '{}');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_response');
  });
});
