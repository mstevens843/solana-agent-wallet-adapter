import { describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../runtime/config.js';
import { RUNTIME_ERROR_CODES } from '../runtime/errors.js';
import type { ProviderExecutor } from '../runtime/queue.js';
import {
  BrowserRuntimeRegistry,
  type RegistrySnapshotPersist,
  type RuntimePersistence,
} from '../runtime/registry.js';
import type { RuntimeRequest } from '../runtime/request.js';
import type { RuntimeError, RuntimeStateWire } from '../runtime/state.js';

const VALID_CONFIG: RuntimeConfig = {
  provider: 'openai',
  apiFormat: 'openai-compatible',
  model: 'gpt-4.1-mini',
  apiKey: 'sk-test',
};

interface FakePersistence extends RuntimePersistence {
  saves: Array<{ state: RuntimeStateWire; error: RuntimeError | null }>;
  loadCalls: number;
}

function fakePersistence(initial?: Partial<RegistrySnapshotPersist>): FakePersistence {
  const persisted: RegistrySnapshotPersist = {
    state: initial?.state ?? 'stopped',
    error: initial?.error ?? null,
    lastTransitionAtMs: initial?.lastTransitionAtMs ?? 0,
  };
  const saves: FakePersistence['saves'] = [];
  let loadCalls = 0;
  return {
    saves,
    get loadCalls() {
      return loadCalls;
    },
    async load() {
      loadCalls += 1;
      return { ...persisted };
    },
    async save(state, error) {
      saves.push({ state, error });
      persisted.state = state;
      persisted.error = error;
    },
  };
}

function noopExecutor(): ProviderExecutor {
  return {
    generatePlan: async () => ({ ok: true }),
    reviewPlan: async () => ({ ok: true }),
    ask: async () => ({ ok: true }),
    localize: async () => ({ ok: true }),
  };
}

function makeRequest(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    requestId: overrides.requestId ?? 'req-1',
    method: overrides.method ?? 'generatePlan',
    payload: overrides.payload ?? {},
    enqueuedAtMs: overrides.enqueuedAtMs ?? Date.now(),
  };
}

describe('BrowserRuntimeRegistry.hydrate', () => {
  it('downgrades persisted running to stopped and clears the error', async () => {
    const persistence = fakePersistence({
      state: 'running',
      error: { code: 'previous', message: 'stale' },
    });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await registry.hydrate();

    expect(registry.snapshot()).toMatchObject({
      state: 'stopped',
      lastError: null,
    });
    expect(persistence.saves).toEqual([{ state: 'stopped', error: null }]);
  });

  it('downgrades persisted starting to stopped', async () => {
    const persistence = fakePersistence({ state: 'starting' });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await registry.hydrate();

    expect(registry.snapshot().state).toBe('stopped');
    expect(persistence.saves).toEqual([{ state: 'stopped', error: null }]);
  });

  it('keeps the persisted error state untouched', async () => {
    const persistedError: RuntimeError = { code: 'previous', message: 'boom' };
    const persistence = fakePersistence({ state: 'error', error: persistedError });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await registry.hydrate();

    expect(registry.snapshot()).toMatchObject({
      state: 'error',
      lastError: persistedError,
    });
    expect(persistence.saves).toEqual([]);
  });

  it('is idempotent across repeated calls', async () => {
    const persistence = fakePersistence({ state: 'stopped' });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await registry.hydrate();
    await registry.hydrate();
    await registry.hydrate();

    expect(persistence.loadCalls).toBe(1);
  });
});

describe('BrowserRuntimeRegistry.start', () => {
  it('reports an error for a null config', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();

    const result = await registry.start(null);

    expect(result).toBe('error');
    expect(registry.snapshot()).toMatchObject({
      state: 'error',
      lastError: { code: 'invalid_config', subcode: 'missing_provider' },
      config: null,
    });
  });

  it('reports an error for an invalid config and does not run the executor', async () => {
    const persistence = fakePersistence();
    const executor = vi.fn();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: () => ({
        generatePlan: executor,
        reviewPlan: executor,
        ask: executor,
        localize: executor,
      }),
    });
    await registry.hydrate();

    const result = await registry.start({ ...VALID_CONFIG, apiFormat: 'gemini' });

    expect(result).toBe('error');
    expect(registry.snapshot().lastError).toMatchObject({ subcode: 'unsupported_format' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('transitions through starting → running and persists each step', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();
    persistence.saves.length = 0;

    const result = await registry.start(VALID_CONFIG);

    expect(result).toBe('running');
    expect(persistence.saves.map((s) => s.state)).toEqual(['starting', 'running']);
    expect(registry.snapshot()).toMatchObject({
      state: 'running',
      lastError: null,
      config: VALID_CONFIG,
    });
  });

  it('updates lastTransitionAtMs via the injected clock', async () => {
    const persistence = fakePersistence();
    let now = 1000;
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
      clock: () => now,
    });
    await registry.hydrate();

    now = 2000;
    await registry.start(VALID_CONFIG);

    expect(registry.snapshot().lastTransitionAtMs).toBe(2000);
  });
});

describe('BrowserRuntimeRegistry.stop and recordError', () => {
  it('returns to stopped without an error', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();
    await registry.start(VALID_CONFIG);

    const result = await registry.stop();

    expect(result).toBe('stopped');
    expect(registry.snapshot()).toMatchObject({
      state: 'stopped',
      lastError: null,
      config: null,
    });
  });

  it('transitions to error and tears down the queue', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();
    await registry.start(VALID_CONFIG);

    const result = await registry.recordError({
      code: 'service_start_failed',
      message: 'foreground service refused',
    });

    expect(result).toBe('error');
    expect(registry.snapshot()).toMatchObject({
      state: 'error',
      lastError: { code: 'service_start_failed', message: 'foreground service refused' },
      config: null,
    });
  });
});

describe('BrowserRuntimeRegistry.submit', () => {
  it('rejects submit when the runtime is not running', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();

    const result = await registry.submit(makeRequest());

    expect(result).toMatchObject({
      kind: 'failed',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING },
    });
  });

  it('forwards submits to the underlying queue when running', async () => {
    const persistence = fakePersistence();
    let invoked = 0;
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: () => ({
        generatePlan: async () => {
          invoked += 1;
          return { ok: true };
        },
        reviewPlan: async () => ({ ok: true }),
        ask: async () => ({ ok: true }),
        localize: async () => ({ ok: true }),
      }),
    });
    await registry.hydrate();
    await registry.start(VALID_CONFIG);

    const result = await registry.submit(makeRequest({ requestId: 'r1' }));

    expect(invoked).toBe(1);
    expect(result).toMatchObject({ kind: 'ok', requestId: 'r1', data: { ok: true } });
  });

  it('rejects submits after stop', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();
    await registry.start(VALID_CONFIG);
    await registry.stop();

    const result = await registry.submit(makeRequest());

    expect(result).toMatchObject({
      kind: 'failed',
      error: { code: RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING },
    });
  });
});

describe('BrowserRuntimeRegistry concurrency', () => {
  it('serializes concurrent start calls through the mutex', async () => {
    const persistence = fakePersistence();
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });
    await registry.hydrate();
    persistence.saves.length = 0;

    const configA = { ...VALID_CONFIG, model: 'model-a' };
    const configB = { ...VALID_CONFIG, model: 'model-b' };

    const [a, b] = await Promise.all([
      registry.start(configA),
      registry.start(configB),
    ]);

    expect(a).toBe('running');
    expect(b).toBe('running');

    // Each start writes (starting, running) in sequence; with two starts we expect
    // four saves in starting/running/starting/running order. The final config wins.
    expect(persistence.saves.map((s) => s.state)).toEqual([
      'starting', 'running', 'starting', 'running',
    ]);
    expect(registry.snapshot().config?.model).toBe('model-b');
  });

  it('uses the explicitly set executor over the dependency provider', async () => {
    const persistence = fakePersistence();
    const providerSpy = vi.fn(noopExecutor);
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: providerSpy,
    });
    await registry.hydrate();

    const explicit: ProviderExecutor = {
      generatePlan: async () => ({ via: 'explicit' }),
      reviewPlan: async () => ({ ok: true }),
      ask: async () => ({ ok: true }),
      localize: async () => ({ ok: true }),
    };
    registry.setExecutor(explicit);
    await registry.start(VALID_CONFIG);

    const result = await registry.submit(makeRequest({ requestId: 'r1' }));
    expect(result).toMatchObject({ kind: 'ok', data: { via: 'explicit' } });
    expect(providerSpy).not.toHaveBeenCalled();
  });
});

describe('BrowserRuntimeRegistry persistence degradation', () => {
  function failingPersistence(opts: {
    loadError?: Error;
    saveError?: Error;
  }): RuntimePersistence & { loadCalls: number; saveCalls: number } {
    let loadCalls = 0;
    let saveCalls = 0;
    return {
      get loadCalls() {
        return loadCalls;
      },
      get saveCalls() {
        return saveCalls;
      },
      async load() {
        loadCalls += 1;
        if (opts.loadError) throw opts.loadError;
        return { state: 'stopped', error: null, lastTransitionAtMs: 0 };
      },
      async save() {
        saveCalls += 1;
        if (opts.saveError) throw opts.saveError;
      },
    };
  }

  it('start succeeds and the queue is usable when persistence.save rejects', async () => {
    const persistence = failingPersistence({
      saveError: new Error('storage_unavailable: write blocked'),
    });
    let invoked = 0;
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: () => ({
        generatePlan: async () => {
          invoked += 1;
          return { ok: true };
        },
        reviewPlan: async () => ({ ok: true }),
        ask: async () => ({ ok: true }),
        localize: async () => ({ ok: true }),
      }),
    });

    await registry.hydrate();
    const state = await registry.start(VALID_CONFIG);

    expect(state).toBe('running');
    expect(registry.snapshot()).toMatchObject({
      state: 'running',
      lastError: null,
      config: VALID_CONFIG,
    });

    const result = await registry.submit(makeRequest({ requestId: 'r1' }));
    expect(invoked).toBe(1);
    expect(result).toMatchObject({ kind: 'ok', requestId: 'r1' });
  });

  it('stop and recordError also tolerate persistence.save rejections', async () => {
    const persistence = failingPersistence({
      saveError: new Error('storage_unavailable: write blocked'),
    });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await registry.hydrate();
    await registry.start(VALID_CONFIG);

    await expect(registry.stop()).resolves.toBe('stopped');
    expect(registry.snapshot()).toMatchObject({ state: 'stopped', lastError: null });

    await registry.start(VALID_CONFIG);
    const errored = await registry.recordError({
      code: RUNTIME_ERROR_CODES.SERVICE_START_FAILED,
      message: 'simulated',
    });
    expect(errored).toBe('error');
    expect(registry.snapshot().lastError).toMatchObject({ code: RUNTIME_ERROR_CODES.SERVICE_START_FAILED });
  });

  it('hydrate falls through to a fresh stopped snapshot when persistence.load rejects', async () => {
    const persistence = failingPersistence({
      loadError: new Error('storage_unavailable: read blocked'),
    });
    const registry = new BrowserRuntimeRegistry({
      persistence,
      executorProvider: noopExecutor,
    });

    await expect(registry.hydrate()).resolves.toBeUndefined();
    expect(registry.snapshot()).toEqual({
      state: 'stopped',
      lastError: null,
      config: null,
      lastTransitionAtMs: 0,
    });

    // No remediation write on the load-failure path (would also reject).
    expect(persistence.saveCalls).toBe(0);

    // Idempotent: subsequent hydrate does not re-attempt load.
    await registry.hydrate();
    expect(persistence.loadCalls).toBe(1);
  });
});
