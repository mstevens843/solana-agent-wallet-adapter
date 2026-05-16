// Phase 5 dispatcher behavior tests. The dispatcher is the singleton that
// composes runtime/, storage/, provider/, prompts/ — the goal here is to
// exercise the *composition*, not re-test the individual layers. Provider HTTP
// is replaced with FakeHttpExecutor (mirrors the Phase 3 helper pattern), and
// IndexedDB/WebCrypto are bypassed via in-memory persistence/secret stores.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeviceAgentClientError } from '../deviceAgentClient.js';
import {
  __resetBrowserDeviceAgentForTests,
  browserDeviceAgentRequest,
  browserDeviceAgentStatusSnapshot,
  initBrowserDeviceAgent,
  setBrowserDeviceAgentSecretStoreMode,
  setBrowserDeviceAgentWalletAddress,
  type ConfigMetadata,
  type MetadataStore,
} from '../deviceAgent/index.js';
import { FakeHttpExecutor } from '../deviceAgent/__tests__/fakeHttpExecutor.helper.js';
import { createMemoryPersistence } from '../deviceAgent/storage/persistence.js';
import type { RuntimePersistence } from '../deviceAgent/runtime/registry.js';
import type {
  SecretStore,
  SecretStoreMode,
} from '../deviceAgent/storage/secretStore.js';

const OPENAI_PLAN_BODY = JSON.stringify({
  choices: [
    {
      message: {
        content:
          '{"intent":"transfer","route":"system","risk":"low","approval":"once","safeguards":[]}',
      },
    },
  ],
});

interface MemorySecretStore extends SecretStore {
  readonly _data: Map<string, string>;
  readonly _stats: { puts: number; deletes: number; clears: number };
}

function createMemorySecretStore(mode: SecretStoreMode = 'session-memory'): MemorySecretStore {
  const data = new Map<string, string>();
  const stats = { puts: 0, deletes: 0, clears: 0 };
  return {
    _data: data,
    _stats: stats,
    async put(key, plaintext) {
      data.set(key, plaintext);
      stats.puts += 1;
    },
    async get(key) {
      return data.get(key);
    },
    async delete(key) {
      data.delete(key);
      stats.deletes += 1;
    },
    async clear() {
      data.clear();
      stats.clears += 1;
    },
    mode() {
      return mode;
    },
    dispose() {
      /* no-op */
    },
  };
}

function createMemoryMetadataStore(initial: ConfigMetadata | null = null): MetadataStore & {
  current: ConfigMetadata | null;
} {
  const wrapper = {
    current: initial,
    load() {
      return wrapper.current;
    },
    save(metadata: ConfigMetadata | null) {
      wrapper.current = metadata;
    },
  };
  return wrapper;
}

function failingPersistence(reason: string): RuntimePersistence {
  return {
    async load() {
      throw new Error(reason);
    },
    async save() {
      throw new Error(reason);
    },
  };
}

const validConfigPayload = {
  provider: 'openai',
  apiFormat: 'openai-compatible',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-EXAMPLEKEY12345',
  baseUrl: 'https://api.openai.com',
};

describe('browser-native Device Agent dispatcher', () => {
  beforeEach(async () => {
    await __resetBrowserDeviceAgentForTests();
  });

  afterEach(async () => {
    await __resetBrowserDeviceAgentForTests();
  });

  it('reports a stopped, unconfigured browser-native runtime on cold init', async () => {
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    const { status } = await browserDeviceAgentRequest('status');
    expect(status.runtime).toBe('browser-native');
    expect(status.state).toBe('stopped');
    expect(status.configured).toBe(false);
    expect(status.provider).toBeUndefined();
    expect(status.message).toBe('Browser Device Agent runtime is stopped.');
    expect(status.lastError).toBeNull();
  });

  it('returns a disabled-build message when status is read before initialization', () => {
    const status = browserDeviceAgentStatusSnapshot();
    expect(status.runtime).toBe('browser-native');
    expect(status.state).toBe('unavailable');
    expect(status.configured).toBe(false);
    // In the test bundle BROWSER_DEVICE_AGENT_ENABLED is false; pre-init path
    // surfaces the disabled-build message (Kotlin parity with disabledStatusJson).
    expect(status.message).toBe('Browser Device Agent is disabled for this build.');
    expect(status.lastError).toBeNull();
  });

  it('persists secret + metadata on configure happy path', async () => {
    const secret = createMemorySecretStore();
    const metadata = createMemoryMetadataStore();
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: secret,
      metadataStore: metadata,
      httpExecutor: new FakeHttpExecutor(),
    });
    const { status } = await browserDeviceAgentRequest('configure', validConfigPayload);
    expect(status.configured).toBe(true);
    expect(status.provider).toBe('openai');
    expect(status.apiFormat).toBe('openai-compatible');
    expect(status.model).toBe('gpt-4o-mini');
    expect(status.baseUrl).toBe('https://api.openai.com');
    expect(await secret.get('device-agent-api-key')).toBe(validConfigPayload.apiKey);
    expect(metadata.current?.model).toBe('gpt-4o-mini');
  });

  it('clears secret + metadata when configure receives clear:true', async () => {
    const secret = createMemorySecretStore();
    const metadata = createMemoryMetadataStore();
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: secret,
      metadataStore: metadata,
      httpExecutor: new FakeHttpExecutor(),
    });
    await browserDeviceAgentRequest('configure', validConfigPayload);
    const { status } = await browserDeviceAgentRequest('configure', { clear: true });
    expect(status.configured).toBe(false);
    expect(status.provider).toBeUndefined();
    expect(await secret.get('device-agent-api-key')).toBeUndefined();
    expect(metadata.current).toBeNull();
  });

  it('rejects configure with empty model using subcode missing_model', async () => {
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    let caught: DeviceAgentClientError | null = null;
    try {
      await browserDeviceAgentRequest('configure', { ...validConfigPayload, model: '' });
    } catch (err) {
      caught = err as DeviceAgentClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('invalid_config');
    expect(caught!.subcode).toBe('missing_model');
    expect(caught!.status?.configured).toBe(false);
  });

  it('runs the full configure → start → generatePlan → stop cycle', async () => {
    const http = new FakeHttpExecutor();
    http.queueResponse(200, OPENAI_PLAN_BODY);
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: http,
    });

    await browserDeviceAgentRequest('configure', validConfigPayload);
    const startResp = await browserDeviceAgentRequest('start');
    expect(startResp.status.state).toBe('running');
    expect(startResp.status.message).toBe('Browser Device Agent runtime is running.');

    const planResp = await browserDeviceAgentRequest<Record<string, unknown>>(
      'generatePlan',
      { userPrompt: 'send 1 SOL' },
    );
    expect(planResp.status.state).toBe('running');
    expect(planResp.status.message).toBe('Browser Device Agent runtime is running.');
    expect(planResp.result?.intent).toBe('transfer');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url.endsWith('/chat/completions')).toBe(true);

    const stopResp = await browserDeviceAgentRequest('stop');
    expect(stopResp.status.state).toBe('stopped');
    expect(stopResp.status.message).toBe('Browser Device Agent runtime is stopped.');
  });

  it('throws runtime_not_running on generatePlan before start', async () => {
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    await browserDeviceAgentRequest('configure', validConfigPayload);
    let caught: DeviceAgentClientError | null = null;
    try {
      await browserDeviceAgentRequest('generatePlan', { userPrompt: 'hi' });
    } catch (err) {
      caught = err as DeviceAgentClientError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('runtime_not_running');
  });

  it('wipes secret + metadata on secret store mode toggle', async () => {
    const secret = createMemorySecretStore('encrypted-indexeddb');
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: secret,
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    await browserDeviceAgentRequest('configure', validConfigPayload);
    expect(browserDeviceAgentStatusSnapshot().configured).toBe(true);

    const toggled = await setBrowserDeviceAgentSecretStoreMode('session-memory');
    expect(toggled.configured).toBe(false);
    expect(secret._stats.clears).toBeGreaterThanOrEqual(1);
    expect(secret._data.size).toBe(0);
  });

  it('surfaces storage_unavailable when hydration fails', async () => {
    initBrowserDeviceAgent({
      persistence: failingPersistence('idb blocked'),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    const { status } = await browserDeviceAgentRequest('status');
    expect(status.state).toBe('unavailable');
    expect(status.lastError?.code).toBe('storage_unavailable');
    expect(status.message).toBe('idb blocked');

    let caught: DeviceAgentClientError | null = null;
    try {
      await browserDeviceAgentRequest('configure', validConfigPayload);
    } catch (err) {
      caught = err as DeviceAgentClientError;
    }
    expect(caught?.code).toBe('storage_unavailable');
  });

  it('throws runtime_canceled when generatePlan receives a pre-aborted signal', async () => {
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    await browserDeviceAgentRequest('configure', validConfigPayload);
    await browserDeviceAgentRequest('start');

    const controller = new AbortController();
    controller.abort();
    let caught: DeviceAgentClientError | null = null;
    try {
      await browserDeviceAgentRequest(
        'generatePlan',
        { userPrompt: 'hi' },
        { signal: controller.signal },
      );
    } catch (err) {
      caught = err as DeviceAgentClientError;
    }
    expect(caught?.code).toBe('runtime_canceled');
  });

  it('serializes concurrent configure calls so the last one wins', async () => {
    const secret = createMemorySecretStore();
    const metadata = createMemoryMetadataStore();
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: secret,
      metadataStore: metadata,
      httpExecutor: new FakeHttpExecutor(),
    });
    const first = browserDeviceAgentRequest('configure', {
      ...validConfigPayload,
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-FIRSTKEY12345',
    });
    const second = browserDeviceAgentRequest('configure', {
      ...validConfigPayload,
      model: 'gpt-4o',
      apiKey: 'sk-test-SECONDKEY12345',
    });
    await Promise.all([first, second]);
    expect(metadata.current?.model).toBe('gpt-4o');
    expect(await secret.get('device-agent-api-key')).toBe('sk-test-SECONDKEY12345');
  });

  it('honors an injected now() in the status snapshot', async () => {
    const fixed = new Date('2026-05-16T12:00:00.000Z');
    initBrowserDeviceAgent({
      now: () => fixed,
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    const { status } = await browserDeviceAgentRequest('status');
    expect(status.checkedAt).toBe(fixed.toISOString());
  });

  it('serializes setBrowserDeviceAgentWalletAddress against in-flight configure', async () => {
    const metadata = createMemoryMetadataStore();
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: metadata,
      httpExecutor: new FakeHttpExecutor(),
      walletAddress: 'OldWalletAddress',
    });
    // Schedule the mutation and a configure call back-to-back. The serializer
    // chains them — the mutation enqueues first, so it lands before configure
    // reads state.deps.walletAddress inside parseConfigPayload. The result is
    // a consistent observation: configure sees the new wallet, never a torn
    // read where the mutation lands halfway through configure.
    setBrowserDeviceAgentWalletAddress('NewWalletAddress');
    await browserDeviceAgentRequest('configure', {
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-EXAMPLEKEY12345',
    });
    expect(metadata.current?.walletAddress).toBe('NewWalletAddress');
    expect(browserDeviceAgentStatusSnapshot().walletAddress).toBe('NewWalletAddress');
  });

  it('throws unsupported_method for unknown methods', async () => {
    initBrowserDeviceAgent({
      persistence: createMemoryPersistence(),
      secretStore: createMemorySecretStore(),
      metadataStore: createMemoryMetadataStore(),
      httpExecutor: new FakeHttpExecutor(),
    });
    let caught: DeviceAgentClientError | null = null;
    try {
      await browserDeviceAgentRequest('bogusMethod' as unknown as 'status', {});
    } catch (err) {
      caught = err as DeviceAgentClientError;
    }
    expect(caught?.code).toBe('unsupported_method');
  });
});
