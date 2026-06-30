import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AndroidNativeWalletBackend,
  androidNativeRequest,
  shouldBlockAndroidNativeAutoRestoreAfterManualDisconnect,
  androidNativePostRestoreRoute,
  resolveAndroidAppSurface,
  restoreLatestAndroidNativeWallet,
  type AndroidManualDisconnectRestoreBlock,
} from '../androidNative.js';

type AndroidCallbackBridge = {
  resolve(requestId: string, payload: unknown): void;
  reject(requestId: string, error: { code?: string; message?: string }): void;
};

type AndroidWindow = Window & {
  __agenticAndroidMwaBridge?: AndroidCallbackBridge;
};

// Regression guard for the "some Android UI doesn't update from Render" bug.
//
// The release Android app live-loads the SAME bundle Render serves to the public
// website, which has NO build-time `VITE_AGENTIC_ANDROID_APP` flag. Shell
// identity must therefore be detected at RUNTIME via the injected `AgenticAndroid`
// bridge — otherwise Android-only UI (AI Review tabs, Connect AI subtab) stays
// hidden in the live bundle and only a new APK could surface it. These tests lock
// in that the same flagless bundle adapts at runtime and that the public website
// (no bridge) is unaffected.
// NOTE: `VITE_AGENTIC_ANDROID_APP` is statically replaced at build time by
// vite.config.ts `define` (defaults to 'false'), so it is hard-`false` in this
// test bundle and cannot be stubbed — which is precisely the production-website
// reality. That makes these tests assert the load-bearing invariant directly:
// with the build flag off (website + live Render bundle), shell identity is
// driven ENTIRELY by the runtime `AgenticAndroid` bridge. The build-flag wiring
// itself is covered by the vite `define` config tests.
describe('resolveAndroidAppSurface (flagless / live-Render bundle)', () => {
  afterEach(() => {
    clearAndroidTestWindow();
    vi.unstubAllGlobals();
  });

  it('is false on the public website: no build flag, no native bridge', () => {
    expect(resolveAndroidAppSurface()).toBe(false);
  });

  it('is true inside the Android WebView shell once the bridge is injected', () => {
    vi.stubGlobal('AgenticAndroid', { mwaRequest: vi.fn() });
    expect(resolveAndroidAppSurface()).toBe(true);
  });
});

describe('AndroidNativeWalletBackend cached restore', () => {
  afterEach(() => {
    clearAndroidTestWindow();
    vi.unstubAllGlobals();
  });

  it('restores the exact native cached authorization without opening a fresh connect', async () => {
    const calls: string[] = [];
    installAndroidBridge((method, payload) => {
      calls.push(method);
      if (method === 'reconnectSession') {
        expect(payload.authCacheKey).toBe('mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111');
        return androidStatus({
          connected: true,
          address: 'Android11111111111111111111111111111111',
          authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    const restored = await restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
    });

    expect(restored).toMatchObject({
      address: 'Android11111111111111111111111111111111',
      walletName: 'Phantom',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
      cacheCount: 1,
    });
    expect(calls).toEqual(['reconnectSession']);
  });

  it('restores native latest authorization when web session identity is missing after a hard kill', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'reconnectLatest') {
        return androidStatus({
          connected: true,
          address: 'Android33333333333333333333333333333333',
          authCacheKey: 'mainnet-beta|pkg:app.phantom|Android33333333333333333333333333333333',
          walletPackage: 'app.phantom',
          walletType: 20,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({ cluster: 'mainnet-beta' })).resolves.toMatchObject({
      address: 'Android33333333333333333333333333333333',
      walletName: 'Phantom',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android33333333333333333333333333333333',
      cacheCount: 1,
    });
    expect(calls).toEqual(['reconnectLatest']);
  });

  it('falls back from a stale exact session key to provider-scoped native restore', async () => {
    const calls: string[] = [];
    installAndroidBridge((method, payload) => {
      calls.push(method);
      if (method === 'reconnectSession') {
        expect(payload.authCacheKey).toBe('mainnet-beta|pkg:app.phantom|Stale111111111111111111111111111111111');
        return androidStatus({ connected: false, cachedCount: 2 });
      }
      if (method === 'reconnectForPubkey') {
        expect(payload.pubkey).toBe('Android11111111111111111111111111111111');
        expect(payload.walletPackage).toBe('app.phantom');
        expect(payload.walletType).toBe(20);
        return androidStatus({
          connected: true,
          address: 'Android11111111111111111111111111111111',
          authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
          walletPackage: 'app.phantom',
          walletType: 20,
          cachedCount: 2,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Stale111111111111111111111111111111111',
      walletPackage: 'app.phantom',
      walletType: 20,
    })).resolves.toMatchObject({
      address: 'Android11111111111111111111111111111111',
      walletName: 'Phantom',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
      cacheCount: 2,
    });
    expect(calls).toEqual(['reconnectSession', 'reconnectForPubkey']);
  });

  it('falls back from provider-scoped miss to the latest native authorization', async () => {
    const calls: string[] = [];
    installAndroidBridge((method, payload) => {
      calls.push(method);
      if (method === 'reconnectForPubkey') {
        expect(payload.pubkey).toBe('Android11111111111111111111111111111111');
        expect(payload.walletPackage).toBe('app.phantom');
        return androidStatus({ connected: false, cachedCount: 2 });
      }
      if (method === 'reconnectLatest') {
        return androidStatus({
          connected: true,
          address: 'Android11111111111111111111111111111111',
          authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
          walletPackage: 'app.phantom',
          walletType: 20,
          cachedCount: 2,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      walletPackage: 'app.phantom',
    })).resolves.toMatchObject({
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
      cacheCount: 2,
    });
    expect(calls).toEqual(['reconnectForPubkey', 'reconnectLatest']);
  });

  it('falls back to latest when an older native bridge rejects provider-scoped restore', async () => {
    const calls: string[] = [];
    installAndroidBridge((method, payload) => {
      calls.push(method);
      if (method === 'reconnectForPubkey') {
        expect(payload.pubkey).toBe('Android11111111111111111111111111111111');
        throw new AndroidBridgeReject(
          'UNSUPPORTED_METHOD',
          'Unsupported Android MWA bridge method: reconnectForPubkey',
        );
      }
      if (method === 'reconnectLatest') {
        return androidStatus({
          connected: true,
          address: 'Android11111111111111111111111111111111',
          authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
          walletPackage: 'app.phantom',
          walletType: 20,
          cachedCount: 1,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      walletPackage: 'app.phantom',
      walletType: 20,
    })).resolves.toMatchObject({
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
      cacheCount: 1,
    });
    expect(calls).toEqual(['reconnectForPubkey', 'reconnectLatest']);
  });

  it('falls back through unsupported exact and provider methods before latest restore', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'reconnectSession' || method === 'reconnectForPubkey') {
        throw new AndroidBridgeReject(
          'UNSUPPORTED_METHOD',
          `Unsupported Android MWA bridge method: ${method}`,
        );
      }
      if (method === 'reconnectLatest') {
        return androidStatus({
          connected: true,
          address: 'Android55555555555555555555555555555555',
          authCacheKey: 'mainnet-beta|pkg:ag.jup.jupiter.android|Android55555555555555555555555555555555',
          walletPackage: 'ag.jup.jupiter.android',
          walletType: 40,
          cachedCount: 1,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android55555555555555555555555555555555',
      authCacheKey: 'mainnet-beta|pkg:ag.jup.jupiter.android|Android55555555555555555555555555555555',
      walletPackage: 'ag.jup.jupiter.android',
      walletType: 40,
    })).resolves.toMatchObject({
      address: 'Android55555555555555555555555555555555',
      walletName: 'Jupiter',
      authCacheKey: 'mainnet-beta|pkg:ag.jup.jupiter.android|Android55555555555555555555555555555555',
      cacheCount: 1,
    });
    expect(calls).toEqual(['reconnectSession', 'reconnectForPubkey', 'reconnectLatest']);
  });

  it('lets native latest cache repair stale live-origin web session identity', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'reconnectSession') {
        return androidStatus({ connected: false, cachedCount: 2 });
      }
      if (method === 'reconnectLatest') {
        return androidStatus({
          connected: true,
          address: 'Android99999999999999999999999999999999',
          authCacheKey: 'mainnet-beta|pkg:ag.jup.jupiter.android|Android99999999999999999999999999999999',
          walletPackage: 'ag.jup.jupiter.android',
          walletType: 40,
          cachedCount: 2,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Stale111111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Stale111111111111111111111111111111111',
    })).resolves.toMatchObject({
      address: 'Android99999999999999999999999999999999',
      walletName: 'Jupiter',
      authCacheKey: 'mainnet-beta|pkg:ag.jup.jupiter.android|Android99999999999999999999999999999999',
      cacheCount: 2,
    });
    expect(calls).toEqual(['reconnectSession', 'reconnectLatest']);
  });

  it('does not report native latest restore when explicit disconnect left only non-restorable cache', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'reconnectLatest') {
        return androidStatus({ connected: false, cachedCount: 1 });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({ cluster: 'mainnet-beta' })).resolves.toBeNull();
    expect(calls).toEqual(['reconnectLatest']);
  });

  it('lazy getAddress opens a fresh connect instead of restoring arbitrary latest after a cold start', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'status') {
        return androidStatus({ connected: false });
      }
      if (method === 'connect') {
        return androidStatus({ connected: true, address: 'Android22222222222222222222222222222222' });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    const backend = new AndroidNativeWalletBackend({ cluster: 'mainnet-beta' });

    await expect(backend.getAddress()).resolves.toBe('Android22222222222222222222222222222222');
    expect(calls).toEqual(['status', 'connect']);
  });

  it('passes the selected wallet package and type to fresh native connect', async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    installAndroidBridge((method, payload) => {
      calls.push({ method, payload });
      if (method === 'connect') {
        expect(payload.walletPackage).toBe('app.phantom');
        expect(payload.walletType).toBe(20);
        return androidStatus({
          connected: true,
          address: 'Android44444444444444444444444444444444',
          walletPackage: 'app.phantom',
          walletType: 20,
        });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    const backend = new AndroidNativeWalletBackend({
      cluster: 'mainnet-beta',
      walletPackage: 'app.phantom',
      walletType: 20,
    });

    await expect(backend.connect()).resolves.toBe('Android44444444444444444444444444444444');
    expect(calls.map((call) => call.method)).toEqual(['connect']);
  });

  it('does not report a disconnected native authorization as restored', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      if (method === 'reconnectSession') {
        return androidStatus({ connected: false, cachedCount: 1 });
      }
      if (method === 'reconnectLatest') {
        return androidStatus({ connected: false, cachedCount: 1 });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
    })).resolves.toBeNull();
    expect(calls).toEqual(['reconnectSession', 'reconnectLatest']);
  });
});

describe('Android cached restore routing', () => {
  it('sends successful Android cached restores from demo to app', () => {
    expect(androidNativePostRestoreRoute('/demo')).toBe('/app');
    expect(androidNativePostRestoreRoute('/app')).toBeNull();
    expect(androidNativePostRestoreRoute('/docs')).toBeNull();
    expect(androidNativePostRestoreRoute(null)).toBeNull();
  });
});

describe('Android manual disconnect restore block', () => {
  const block: AndroidManualDisconnectRestoreBlock = {
    version: 1,
    cluster: 'mainnet-beta',
    address: 'Android11111111111111111111111111111111',
    walletName: 'Phantom',
    disconnectedAt: '2026-06-30T08:51:28.910Z',
    webBuildCommit: 'test-build',
  };

  it('blocks automatic restore on the same cluster after explicit disconnect', () => {
    expect(shouldBlockAndroidNativeAutoRestoreAfterManualDisconnect(block, 'mainnet-beta')).toBe(true);
  });

  it('does not block other clusters or empty state', () => {
    expect(shouldBlockAndroidNativeAutoRestoreAfterManualDisconnect(block, 'devnet')).toBe(false);
    expect(shouldBlockAndroidNativeAutoRestoreAfterManualDisconnect(undefined, 'mainnet-beta')).toBe(false);
  });
});

describe('androidNativeRequest pending wallet handoff', () => {
  afterEach(() => {
    clearAndroidTestWindow();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not reject a pending wallet request on the old picker grace window', async () => {
    vi.useFakeTimers();
    const testWindow = installAndroidTestWindow();
    let capturedRequestId = '';
    vi.stubGlobal('AgenticAndroid', {
      mwaRequest: vi.fn((requestId: string) => {
        capturedRequestId = requestId;
      }),
    });

    let settled = false;
    const request = androidNativeRequest('connect', { cluster: 'mainnet-beta' })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(5_500);
    expect(settled).toBe(false);

    testWindow.__agenticAndroidMwaBridge?.resolve(
      capturedRequestId,
      androidStatus({
        connected: true,
        address: 'AndroidBackpack1111111111111111111111111',
        walletPackage: 'app.backpack.mobile.standalone',
      }),
    );

    await expect(request).resolves.toMatchObject({
      connected: true,
      walletPackage: 'app.backpack.mobile.standalone',
    });
  });

  it('keeps the 120s Android native hard timeout', async () => {
    vi.useFakeTimers();
    installAndroidTestWindow();
    vi.stubGlobal('AgenticAndroid', {
      mwaRequest: vi.fn(),
    });

    const request = androidNativeRequest('connect', { cluster: 'mainnet-beta' });
    const timeoutError = request.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);

    await expect(timeoutError).resolves.toMatchObject({
      code: 'expired',
    });
  });
});

class AndroidBridgeReject extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AndroidBridgeReject';
    this.code = code;
  }
}

function installAndroidBridge(handler: (method: string, payload: Record<string, unknown>) => unknown): void {
  const testWindow = installAndroidTestWindow();
  vi.stubGlobal('AgenticAndroid', {
    mwaRequest: vi.fn((requestId: string, method: string, payloadJson: string) => {
      try {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        const result = handler(method, payload);
        testWindow.__agenticAndroidMwaBridge?.resolve(requestId, result);
      } catch (err) {
        testWindow.__agenticAndroidMwaBridge?.reject(requestId, {
          code: err instanceof AndroidBridgeReject ? err.code : 'TEST_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  });
}

function installAndroidTestWindow(): AndroidWindow {
  const testWindow = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as AndroidWindow;
  vi.stubGlobal('window', testWindow);
  return testWindow;
}

function clearAndroidTestWindow(): void {
  const testWindow = (globalThis as typeof globalThis & { window?: AndroidWindow }).window;
  if (testWindow) {
    delete testWindow.__agenticAndroidMwaBridge;
  }
}

function androidStatus(input: {
  connected: boolean;
  address?: string;
  authCacheKey?: string;
  cachedCount?: number;
  walletPackage?: string;
  walletType?: number;
}): Record<string, unknown> {
  const address = input.address ?? '';
  const walletPackage = input.walletPackage ?? 'app.phantom';
  const walletType = input.walletType ?? 20;
  return {
    connected: input.connected,
    cachedCount: input.cachedCount ?? 1,
    ...(address && {
      address,
      authCacheKey: input.authCacheKey ?? `mainnet-beta|pkg:${walletPackage}|${address}`,
      cluster: 'mainnet-beta',
      walletPackage,
      walletType,
      capabilities: {
        backend: 'android-native-mwa',
        cluster: ['mainnet-beta'],
        address,
        supports: {
          signMessage: false,
          signTransaction: true,
          signAndSendTransaction: true,
          multiSign: true,
          simulationPreview: false,
        },
      },
    }),
  };
}
