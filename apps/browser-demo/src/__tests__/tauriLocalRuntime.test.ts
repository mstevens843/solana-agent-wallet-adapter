import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal DOM + Tauri host shims. Vitest runs in Node by default; we install
// just enough of window / document / EventTarget for the panel to mount and
// the polling timer to fire.
beforeAll(() => {
  const target = new EventTarget();
  const memoryStore = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key) ?? null : null),
    setItem: (key: string, value: string) => { memoryStore.set(key, String(value)); },
    removeItem: (key: string) => { memoryStore.delete(key); },
    clear: () => memoryStore.clear(),
    key: (i: number) => Array.from(memoryStore.keys())[i] ?? null,
    get length() { return memoryStore.size; },
  };
  const elementStore = new Map<string, MinimalElement>();
  interface MinimalElement {
    innerHTML: string;
    outerHTML: string;
    dataset: Record<string, string>;
    addEventListener(...args: unknown[]): void;
    querySelector(...args: unknown[]): MinimalElement | null;
    querySelectorAll(...args: unknown[]): MinimalElement[];
  }
  const makeElement = (id: string): MinimalElement => ({
    innerHTML: '',
    outerHTML: '',
    dataset: {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const documentMock = {
    getElementById: (id: string) => {
      let el = elementStore.get(id);
      if (!el) { el = makeElement(id); elementStore.set(id, el); }
      return el;
    },
  };
  const win: any = {
    addEventListener: target.addEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    localStorage: localStorageMock,
  };
  (globalThis as any).window = win;
  (globalThis as any).document = documentMock;
  (globalThis as any).CustomEvent = class CustomEventMock<T> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      // Preserve null vs. undefined — `?? undefined` would collapse null into
      // undefined and break tests that assert null detail.
      this.detail = (init && 'detail' in init ? init.detail : undefined) as T;
    }
  };
});

import {
  TAURI_BRIDGE_STATUS_EVENT,
  __resetTauriLocalRuntimePanelStateForTests,
  mountTauriLocalRuntimePanel,
} from '../tauriLocalRuntime.js';
import { __resetTauriNativeTokenCacheForTests } from '../tauriNative.js';

function installTauri(invoke: ReturnType<typeof vi.fn>) {
  (window as any).__TAURI_INTERNALS__ = { invoke };
}

function uninstallTauri() {
  delete (window as any).__TAURI_INTERNALS__;
}

function fakeBridgeStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    running: true,
    pid: 1234,
    startedAt: '2026-05-21T17:00:00.000Z',
    bridgeReachable: true,
    restarting: false,
    bridgeUrl: 'http://127.0.0.1:8787',
    bridgeToken: 'tok',
    repoRoot: '/repo',
    envPath: '/.env',
    actionConfigPath: '/agent-wallet.config.json',
    preparedActionsPath: '/prepared-actions.json',
    runtimeMode: 'installed-sidecar',
    sidecarPath: '/sidecar/path',
    desktopConfigPath: '/desktop-config.json',
    runtimeDataPath: '/runtime-data',
    releaseVersion: '0.3.0',
    diagnostics: [],
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetTauriNativeTokenCacheForTests();
  __resetTauriLocalRuntimePanelStateForTests();
  installTauri(vi.fn());
});

afterEach(() => {
  uninstallTauri();
});

describe('mountTauriLocalRuntimePanel', () => {
  it('clears the container and bails when not in Tauri', () => {
    uninstallTauri();
    const container = (document as any).getElementById('panel-clear');
    container.innerHTML = '<p>initial</p>';
    mountTauriLocalRuntimePanel('panel-clear');
    expect(container.innerHTML).toBe('');
  });

  it('emits TAURI_BRIDGE_STATUS_EVENT on first refresh with the status detail', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const listener = vi.fn();
    window.addEventListener(TAURI_BRIDGE_STATUS_EVENT, listener);
    mountTauriLocalRuntimePanel('panel-emit');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect((detail as any).running).toBe(true);
    expect((detail as any).bridgeUrl).toBe('http://127.0.0.1:8787');
    window.removeEventListener(TAURI_BRIDGE_STATUS_EVENT, listener);
  });

  it('emits null detail when bridge_status IPC fails', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') throw new Error('bridge unreachable');
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const listener = vi.fn();
    window.addEventListener(TAURI_BRIDGE_STATUS_EVENT, listener);
    mountTauriLocalRuntimePanel('panel-null');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    const detail = (listener.mock.calls[0]![0] as CustomEvent).detail;
    expect(detail).toBeNull();
    window.removeEventListener(TAURI_BRIDGE_STATUS_EVENT, listener);
  });

  it('idempotent mount does not crash on repeated invocations', () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    expect(() => {
      mountTauriLocalRuntimePanel('panel-idempotent');
      mountTauriLocalRuntimePanel('panel-idempotent');
      mountTauriLocalRuntimePanel('panel-idempotent');
    }).not.toThrow();
  });

  it('renders header copy stating the fields are optional', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-header-copy');
    mountTauriLocalRuntimePanel('panel-header-copy');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain('All fields below are optional');
  });

  it('renders the local runtime keys grid inside the advanced details wrapper', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-advanced-wrapper');
    mountTauriLocalRuntimePanel('panel-advanced-wrapper');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain('<details class="tauri-local-runtime-advanced"');
    expect(container.innerHTML).toContain('Advanced: run agent locally');
  });

  it('renders persistent Local Bridge AI env fields in the advanced runtime setup', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-ai-fields');
    mountTauriLocalRuntimePanel('panel-ai-fields');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain('Local Bridge AI provider key');
    expect(container.innerHTML).toContain('name="AGENTIC_AI_API_KEY"');
    expect(container.innerHTML).toContain('name="AGENTIC_AI_MODEL"');
    expect(container.innerHTML).toContain('name="AGENTIC_AI_BASE_URL"');
  });

  it('keeps the advanced details collapsed when no values are saved', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return {};
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-collapsed');
    mountTauriLocalRuntimePanel('panel-collapsed');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).not.toMatch(/<details class="tauri-local-runtime-advanced"\s+open\b/);
  });

  it('opens the advanced details when at least one local runtime key is saved', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return { HELIUS_API_KEY: 'helius-test' };
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-open');
    mountTauriLocalRuntimePanel('panel-open');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toMatch(/<details class="tauri-local-runtime-advanced"\s+open\b/);
  });

  it('opens the advanced details when a Local Bridge AI provider key is saved', async () => {
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'bridge_status') return fakeBridgeStatus();
      if (cmd === 'read_env_keys') return { AGENTIC_AI_API_KEY: 'sk-test' };
      return undefined;
    });
    installTauri(invoke);
    const container = (document as any).getElementById('panel-ai-open');
    mountTauriLocalRuntimePanel('panel-ai-open');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toMatch(/<details class="tauri-local-runtime-advanced"\s+open\b/);
  });
});
