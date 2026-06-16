import { describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '../runtime/config.js';
import {
  ProviderFailedError,
  ProviderUnavailableError,
  RUNTIME_ERROR_CODES,
} from '../runtime/errors.js';
import {
  DEFAULT_QUEUE_CAPACITY,
  type ProviderExecutor,
  RequestQueue,
} from '../runtime/queue.js';
import type { RuntimeRequest } from '../runtime/request.js';

const CONFIG: RuntimeConfig = {
  provider: 'openai',
  apiFormat: 'openai-compatible',
  model: 'gpt-4.1-mini',
  apiKey: 'sk-test',
};

function makeRequest(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    requestId: overrides.requestId ?? `req-${Math.random().toString(36).slice(2, 10)}`,
    method: overrides.method ?? 'generatePlan',
    payload: overrides.payload ?? {},
    enqueuedAtMs: overrides.enqueuedAtMs ?? Date.now(),
  };
}

interface CapturedCall {
  readonly method: 'generatePlan' | 'reviewPlan' | 'ask' | 'localize';
  readonly config: RuntimeConfig;
  readonly payload: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly startedAtMs: number;
}

interface StubExecutor extends ProviderExecutor {
  readonly calls: CapturedCall[];
}

function stubExecutor(
  handler: (call: CapturedCall) => Promise<unknown>,
): StubExecutor {
  const calls: CapturedCall[] = [];
  const wrap = (method: CapturedCall['method']) =>
    async (
      config: RuntimeConfig,
      payload: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const call: CapturedCall = {
        method,
        config,
        payload,
        signal,
        startedAtMs: performance.now(),
      };
      calls.push(call);
      return handler(call);
    };
  return {
    calls,
    generatePlan: wrap('generatePlan'),
    reviewPlan: wrap('reviewPlan'),
    ask: wrap('ask'),
    localize: wrap('localize'),
  };
}

function neverResolves(): Promise<never> {
  return new Promise(() => undefined);
}

function abortable(call: CapturedCall): Promise<unknown> {
  return new Promise((_, reject) => {
    if (call.signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    call.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

describe('RequestQueue capacity + sequencing', () => {
  it('processes requests one at a time in FIFO order', async () => {
    const order: string[] = [];
    const executor = stubExecutor(async (call) => {
      order.push(`start:${(call.payload as { id: string }).id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${(call.payload as { id: string }).id}`);
      return { ok: true };
    });
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const p1 = queue.submit(makeRequest({ requestId: 'r1', payload: { id: '1' } }));
    const p2 = queue.submit(makeRequest({ requestId: 'r2', payload: { id: '2' } }));
    const p3 = queue.submit(makeRequest({ requestId: 'r3', payload: { id: '3' } }));

    const results = await Promise.all([p1, p2, p3]);
    expect(results.every((r) => r.kind === 'ok')).toBe(true);
    expect(order).toEqual([
      'start:1', 'end:1',
      'start:2', 'end:2',
      'start:3', 'end:3',
    ]);
  });

  it('fails the 65th request with runtime_busy at default capacity', async () => {
    expect(DEFAULT_QUEUE_CAPACITY).toBe(64);
    const executor = stubExecutor(() => neverResolves());
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const accepted: Array<Promise<unknown>> = [];
    for (let i = 0; i < DEFAULT_QUEUE_CAPACITY; i++) {
      accepted.push(queue.submit(makeRequest({ requestId: `r${i}` })));
    }
    const overflow = await queue.submit(makeRequest({ requestId: 'overflow' }));
    expect(overflow).toMatchObject({
      kind: 'failed',
      requestId: 'overflow',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_BUSY },
    });

    queue.stop();
    // Drain accepted to keep the test from leaking promises.
    await Promise.all(accepted);
  });

  it('respects a custom capacity', async () => {
    const executor = stubExecutor(() => neverResolves());
    const queue = new RequestQueue({
      capacity: 2,
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const a = queue.submit(makeRequest({ requestId: 'a' }));
    const b = queue.submit(makeRequest({ requestId: 'b' }));
    const c = await queue.submit(makeRequest({ requestId: 'c' }));

    expect(c).toMatchObject({
      kind: 'failed',
      requestId: 'c',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_BUSY },
    });

    queue.stop();
    await Promise.all([a, b]);
  });
});

describe('RequestQueue stop semantics', () => {
  it('drains pending requests as runtime_canceled when stop is called before they start', async () => {
    const executor = stubExecutor(() => neverResolves());
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const p1 = queue.submit(makeRequest({ requestId: 'a' }));
    const p2 = queue.submit(makeRequest({ requestId: 'b' }));
    const p3 = queue.submit(makeRequest({ requestId: 'c' }));

    queue.stop();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    for (const r of [r1, r2, r3]) {
      expect(r).toMatchObject({
        kind: 'failed',
        error: { code: RUNTIME_ERROR_CODES.RUNTIME_CANCELED },
      });
    }
  });

  it('aborts an in-flight request via AbortController and resolves it as runtime_canceled', async () => {
    let observedSignal: AbortSignal | undefined;
    const executor = stubExecutor((call) => {
      observedSignal = call.signal;
      return abortable(call);
    });
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const p = queue.submit(makeRequest({ requestId: 'inflight' }));
    // Let the worker pick the request up.
    await Promise.resolve();
    await Promise.resolve();

    queue.stop();
    const result = await p;

    expect(observedSignal).toBeDefined();
    expect(observedSignal!.aborted).toBe(true);
    expect(result).toMatchObject({
      kind: 'failed',
      requestId: 'inflight',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_CANCELED },
    });
  });

  it('rejects new submits after stop with runtime_not_running', async () => {
    const executor = stubExecutor(async () => ({ ok: true }));
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();
    queue.stop();

    const result = await queue.submit(makeRequest({ requestId: 'late' }));
    expect(result).toMatchObject({
      kind: 'failed',
      requestId: 'late',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING },
    });
  });
});

describe('RequestQueue provider error handling', () => {
  it('maps ProviderUnavailableError into a failed result and keeps consuming', async () => {
    let calls = 0;
    const executor: ProviderExecutor = {
      generatePlan: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderUnavailableError({
            code: RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE,
            message: 'gateway down',
          });
        }
        return { ok: true };
      },
      reviewPlan: async () => ({ ok: true }),
      ask: async () => ({ ok: true }),
      localize: async () => ({ ok: true }),
    };
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const first = await queue.submit(makeRequest({ requestId: 'first' }));
    const second = await queue.submit(makeRequest({ requestId: 'second' }));

    expect(first).toMatchObject({
      kind: 'failed',
      requestId: 'first',
      error: { code: RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE, message: 'gateway down' },
    });
    expect(second).toMatchObject({ kind: 'ok', requestId: 'second' });
  });

  it('passes ProviderFailedError subcodes through verbatim', async () => {
    const executor = stubExecutor(async () => {
      throw new ProviderFailedError({
        code: RUNTIME_ERROR_CODES.PROVIDER_AUTH,
        subcode: 'unauthorized',
        message: 'bad api key',
      });
    });
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const result = await queue.submit(makeRequest({ requestId: 'auth' }));
    expect(result).toMatchObject({
      kind: 'failed',
      requestId: 'auth',
      error: {
        code: RUNTIME_ERROR_CODES.PROVIDER_AUTH,
        subcode: 'unauthorized',
        message: 'bad api key',
      },
    });
  });

  it('maps generic errors to runtime_internal with the error message', async () => {
    const executor = stubExecutor(async () => {
      throw new Error('boom');
    });
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const result = await queue.submit(makeRequest({ requestId: 'crash' }));
    expect(result).toMatchObject({
      kind: 'failed',
      requestId: 'crash',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_INTERNAL, message: 'boom' },
    });
  });

  it('returns invalid_config when configProvider yields null mid-flight', async () => {
    let config: RuntimeConfig | null = CONFIG;
    const executor = stubExecutor(async () => ({ ok: true }));
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => config,
    });
    queue.start();

    config = null;
    const result = await queue.submit(makeRequest({ requestId: 'noconfig' }));
    expect(result).toMatchObject({
      kind: 'failed',
      requestId: 'noconfig',
      error: { code: RUNTIME_ERROR_CODES.INVALID_CONFIG, subcode: 'missing_provider' },
    });
  });
});

describe('RequestQueue method routing', () => {
  it('dispatches by method', async () => {
    const executor = stubExecutor(async (call) => ({ via: call.method }));
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const [a, b, c] = await Promise.all([
      queue.submit(makeRequest({ requestId: 'a', method: 'generatePlan' })),
      queue.submit(makeRequest({ requestId: 'b', method: 'reviewPlan' })),
      queue.submit(makeRequest({ requestId: 'c', method: 'ask' })),
    ]);

    expect(executor.calls.map((c) => c.method)).toEqual(['generatePlan', 'reviewPlan', 'ask']);
    expect(a).toMatchObject({ kind: 'ok', data: { via: 'generatePlan' } });
    expect(b).toMatchObject({ kind: 'ok', data: { via: 'reviewPlan' } });
    expect(c).toMatchObject({ kind: 'ok', data: { via: 'ask' } });
  });
});

describe('RequestQueue exactly-once', () => {
  it('resolves each submit exactly once even when stop races with completion', async () => {
    const handlers: Array<() => void> = [];
    const executor: ProviderExecutor = {
      generatePlan: () => new Promise((resolve) => {
        handlers.push(() => resolve({ ok: true }));
      }),
      reviewPlan: async () => ({ ok: true }),
      ask: async () => ({ ok: true }),
      localize: async () => ({ ok: true }),
    };
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    let resolveCount = 0;
    const p = queue.submit(makeRequest({ requestId: 'race' }));
    p.then(() => {
      resolveCount += 1;
    });

    await Promise.resolve();
    await Promise.resolve();

    // Resolve the executor and stop the queue in the same tick.
    handlers[0]?.();
    queue.stop();

    await p;
    await new Promise((r) => setTimeout(r, 10));
    expect(resolveCount).toBe(1);
  });

  it('relays caller-supplied AbortSignal onto the executor and resolves as runtime_canceled', async () => {
    const seenSignals: AbortSignal[] = [];
    const executor: ProviderExecutor = {
      generatePlan: (_config, _payload, signal) => new Promise((_resolve, reject) => {
        if (!signal) throw new Error('expected executor to receive a signal');
        seenSignals.push(signal);
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
      reviewPlan: async () => ({ ok: true }),
      ask: async () => ({ ok: true }),
      localize: async () => ({ ok: true }),
    };
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const ac = new AbortController();
    const p = queue.submit(makeRequest({ requestId: 'cancel' }), ac.signal);

    // Give the worker one tick to pick up the request and attach the relay.
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const result = await p;
    expect(result.kind).toBe('failed');
    expect(seenSignals.length).toBe(1);
    expect(seenSignals[0]!.aborted).toBe(true);
    if (result.kind === 'failed') {
      expect(result.error.code).toBe(RUNTIME_ERROR_CODES.RUNTIME_CANCELED);
    }
  });

  it('returns runtime_canceled synchronously when caller signal is already aborted at submit time', async () => {
    const executor: ProviderExecutor = {
      generatePlan: async () => ({ ok: true }),
      reviewPlan: async () => ({ ok: true }),
      ask: async () => ({ ok: true }),
      localize: async () => ({ ok: true }),
    };
    const queue = new RequestQueue({
      executorProvider: () => executor,
      configProvider: () => CONFIG,
    });
    queue.start();

    const ac = new AbortController();
    ac.abort();
    const result = await queue.submit(makeRequest({ requestId: 'pre-aborted' }), ac.signal);
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error.code).toBe(RUNTIME_ERROR_CODES.RUNTIME_CANCELED);
    }
  });
});
