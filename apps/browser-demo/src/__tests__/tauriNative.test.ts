import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vitest runs in Node by default; install minimal window + localStorage + event
// target globals so tauriNative can read/write its localStorage fallback and
// dispatch CustomEvents from the rehydration listener.
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
  const win: any = {
    addEventListener: target.addEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    localStorage: localStorageMock,
  };
  (globalThis as any).window = win;
  (globalThis as any).CustomEvent = class CustomEventMock<T> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      this.detail = (init && 'detail' in init ? init.detail : undefined) as T;
    }
  };
});

import {
  CLOUD_SESSION_REHYDRATED_EVENT,
  __resetTauriNativeTokenCacheForTests,
  clearTauriNativeCloudSessionToken,
  detectTauriNativeEnvironment,
  setTauriNativeCloudSessionToken,
  tauriInvoke,
  tauriListenEvent,
  tauriNativeBridgeStatus,
  tauriNativeCloudSessionToken,
  tauriNativeOpenExternalUrl,
  tauriNativeReadEnvKeys,
  tauriNativeWriteEnvKeys,
} from '../tauriNative.js';

type InvokeMock = ReturnType<typeof vi.fn>;

function installTauri(invoke: InvokeMock | null = vi.fn()): void {
  (window as any).__TAURI_INTERNALS__ = invoke ? { invoke } : undefined;
}

function uninstallTauri(): void {
  delete (window as any).__TAURI_INTERNALS__;
  delete (window as any).__TAURI__;
}

function resetTokenCache(): void {
  try { window.localStorage.clear(); } catch { /* ignore */ }
  __resetTauriNativeTokenCacheForTests();
}

beforeEach(() => {
  installTauri(vi.fn());
  resetTokenCache();
});

afterEach(() => {
  uninstallTauri();
});

describe('detectTauriNativeEnvironment', () => {
  it('returns false when window is undefined', () => {
    const savedWindow = (globalThis as any).window;
    delete (globalThis as any).window;
    expect(detectTauriNativeEnvironment().isTauriNative).toBe(false);
    (globalThis as any).window = savedWindow;
  });

  it('returns false when __TAURI_INTERNALS__ is missing', () => {
    uninstallTauri();
    expect(detectTauriNativeEnvironment()).toEqual({ isTauriNative: false, bridgeAvailable: false });
  });

  it('returns true when __TAURI_INTERNALS__.invoke is present', () => {
    installTauri(vi.fn());
    const env = detectTauriNativeEnvironment();
    expect(env.isTauriNative).toBe(true);
    expect(env.bridgeAvailable).toBe(true);
  });
});

describe('tauriInvoke', () => {
  it('throws when not inside a Tauri webview', async () => {
    uninstallTauri();
    await expect(tauriInvoke('any')).rejects.toThrow(/Tauri bridge/);
  });

  it('proxies cmd + args to the global invoke', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    installTauri(invoke);
    const result = await tauriInvoke<{ ok: boolean }>('secure_get', { key: 'k' });
    expect(invoke).toHaveBeenCalledWith('secure_get', { key: 'k' });
    expect(result).toEqual({ ok: true });
  });

  it('wraps invoke errors as ProtocolError', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('boom'));
    installTauri(invoke);
    await expect(tauriInvoke('x')).rejects.toThrow(/boom/);
  });
});

describe('cloud session token round-trip', () => {
  it('falls back to localStorage when secure_get is unavailable', async () => {
    window.localStorage.setItem('tauri:cloudSessionToken', 'fallback-token');
    // First synchronous read pulls from localStorage and kicks off hydration.
    const reader = () => tauriNativeCloudSessionToken();
    // Mock invoke to throw for secure_get (Phase 3 unavailable scenario)
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'secure_get') throw new Error('not implemented');
      return undefined;
    });
    installTauri(invoke);
    expect(reader()).toBe('fallback-token');
  });

  it('setTauriNativeCloudSessionToken updates the cache and persists', async () => {
    const stored: Record<string, string> = {};
    const invoke = vi.fn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'secure_set') {
        stored[args.key] = args.value;
        return undefined;
      }
      if (cmd === 'secure_get') return stored[args.key] ?? null;
      if (cmd === 'secure_delete') {
        delete stored[args.key];
        return undefined;
      }
      return undefined;
    });
    installTauri(invoke);
    await setTauriNativeCloudSessionToken('hello-token');
    expect(stored.cloudSessionToken).toBe('hello-token');
    expect(tauriNativeCloudSessionToken()).toBe('hello-token');
    await clearTauriNativeCloudSessionToken();
    expect(stored.cloudSessionToken).toBeUndefined();
    expect(tauriNativeCloudSessionToken()).toBe('');
  });

  it('does NOT overwrite cache when a concurrent set runs during hydration (race fix 11.1)', async () => {
    // Pre-populate localStorage with an OLD token so the first sync read
    // returns that. Then mock secure_get to return YET ANOTHER older value
    // — but DELAYED so we can perform a fresh set during the await.
    window.localStorage.setItem('tauri:cloudSessionToken', 'old-storage-token');
    let releaseHydration: (() => void) | null = null;
    const hydrationGate = new Promise<void>((resolve) => { releaseHydration = resolve; });
    const invoke = vi.fn().mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'secure_get') {
        await hydrationGate;
        return 'stale-stronghold-token';
      }
      if (cmd === 'secure_set') return undefined;
      if (cmd === 'secure_delete') return undefined;
      return undefined;
    });
    installTauri(invoke);
    // Trigger hydration (sync read kicks off the async secure_get).
    expect(tauriNativeCloudSessionToken()).toBe('old-storage-token');
    // While hydration is gated, set a brand-new token. This is the user's
    // sign-in completing during the in-flight hydration.
    await setTauriNativeCloudSessionToken('freshly-set-token');
    expect(tauriNativeCloudSessionToken()).toBe('freshly-set-token');
    // Now let hydration finish — its stale value MUST NOT clobber the fresh write.
    releaseHydration!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(tauriNativeCloudSessionToken()).toBe('freshly-set-token');
  });

  it('dispatches CLOUD_SESSION_REHYDRATED_EVENT when secure_get returns a different value', async () => {
    // Pre-populate localStorage with an old token.
    window.localStorage.setItem('tauri:cloudSessionToken', 'old-token');
    // Mock invoke so secure_get returns a NEWER token than localStorage.
    const invoke = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd === 'secure_get') return 'new-token';
      return undefined;
    });
    installTauri(invoke);
    const listener = vi.fn();
    window.addEventListener(CLOUD_SESSION_REHYDRATED_EVENT, listener);
    // First sync read uses localStorage and triggers async hydration.
    const sync = tauriNativeCloudSessionToken();
    expect(sync).toBe('old-token');
    // Wait a microtask for hydration to complete.
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalled();
    expect(tauriNativeCloudSessionToken()).toBe('new-token');
    window.removeEventListener(CLOUD_SESSION_REHYDRATED_EVENT, listener);
  });
});

describe('bridge / env / open commands', () => {
  it('tauriNativeBridgeStatus returns null when invoke fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no bridge'));
    installTauri(invoke);
    const result = await tauriNativeBridgeStatus();
    expect(result).toBeNull();
  });

  it('tauriNativeReadEnvKeys returns null map on failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('disk read failed'));
    installTauri(invoke);
    const result = await tauriNativeReadEnvKeys(['HELIUS_API_KEY', 'COINGECKO_API_KEY']);
    expect(result).toEqual({ HELIUS_API_KEY: null, COINGECKO_API_KEY: null });
  });

  it('tauriNativeWriteEnvKeys returns false on failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('disk write failed'));
    installTauri(invoke);
    const ok = await tauriNativeWriteEnvKeys({ FOO: 'bar' });
    expect(ok).toBe(false);
  });

  it('tauriNativeOpenExternalUrl returns false on failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('xdg-open missing'));
    installTauri(invoke);
    const ok = await tauriNativeOpenExternalUrl('https://example.com');
    expect(ok).toBe(false);
  });

  it('tauriNativeOpenExternalUrl returns true on success', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    installTauri(invoke);
    const ok = await tauriNativeOpenExternalUrl('https://example.com');
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com' });
  });
});

describe('tauriListenEvent', () => {
  it('returns null when no Tauri runtime listen is available', async () => {
    uninstallTauri();
    const unlisten = await tauriListenEvent<string[]>('agentic://deep-link', () => {});
    expect(unlisten).toBeNull();
  });

  it('proxies through __TAURI_INTERNALS__.runtime.listen and forwards payloads', async () => {
    const callback = vi.fn();
    const unlistenSpy = vi.fn();
    const listen = vi.fn(async (_event: string, cb: (e: { event: string; id: number; payload: string[] }) => void) => {
      // Simulate the runtime delivering one event.
      setTimeout(() => cb({ event: 'agentic://deep-link', id: 1, payload: ['agentic://test'] }), 0);
      return unlistenSpy;
    });
    (window as any).__TAURI_INTERNALS__ = { invoke: vi.fn(), runtime: { listen } };
    const unlisten = await tauriListenEvent<string[]>('agentic://deep-link', callback);
    expect(typeof unlisten).toBe('function');
    expect(listen).toHaveBeenCalledWith('agentic://deep-link', expect.any(Function));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callback).toHaveBeenCalledWith(['agentic://test']);
  });

  it('falls back to __TAURI__.event.listen when runtime.listen is missing', async () => {
    const callback = vi.fn();
    const unlistenSpy = vi.fn();
    const listen = vi.fn(async (_event: string, cb: (e: { event: string; id: number; payload: string }) => void) => {
      setTimeout(() => cb({ event: 'agentic://deep-link', id: 1, payload: 'hello' }), 0);
      return unlistenSpy;
    });
    (window as any).__TAURI_INTERNALS__ = { invoke: vi.fn() };
    (window as any).__TAURI__ = { event: { listen } };
    const unlisten = await tauriListenEvent<string>('agentic://deep-link', callback);
    expect(typeof unlisten).toBe('function');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callback).toHaveBeenCalledWith('hello');
  });

  it('returns null when listen throws', async () => {
    const listen = vi.fn().mockRejectedValue(new Error('listen failed'));
    (window as any).__TAURI_INTERNALS__ = { invoke: vi.fn(), runtime: { listen } };
    const unlisten = await tauriListenEvent('agentic://deep-link', () => {});
    expect(unlisten).toBeNull();
  });
});
