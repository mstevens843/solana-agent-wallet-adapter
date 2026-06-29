import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AndroidNativeWalletBackend,
  resolveAndroidAppSurface,
  restoreLatestAndroidNativeWallet,
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

  it('does not use native latest restore without a saved session identity', async () => {
    const calls: string[] = [];
    installAndroidBridge((method) => {
      calls.push(method);
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({ cluster: 'mainnet-beta' })).resolves.toBeNull();
    expect(calls).toEqual([]);
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

  it('does not report a disconnected native authorization as restored', async () => {
    installAndroidBridge((method) => {
      if (method === 'reconnectSession') {
        return androidStatus({ connected: false, cachedCount: 1 });
      }
      throw new Error(`unexpected Android MWA method ${method}`);
    });

    await expect(restoreLatestAndroidNativeWallet({
      cluster: 'mainnet-beta',
      address: 'Android11111111111111111111111111111111',
      authCacheKey: 'mainnet-beta|pkg:app.phantom|Android11111111111111111111111111111111',
    })).resolves.toBeNull();
  });
});

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
          code: 'TEST_ERROR',
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
}): Record<string, unknown> {
  const address = input.address ?? '';
  return {
    connected: input.connected,
    cachedCount: input.cachedCount ?? 1,
    ...(address && {
      address,
      authCacheKey: input.authCacheKey ?? `mainnet-beta|pkg:app.phantom|${address}`,
      cluster: 'mainnet-beta',
      walletPackage: 'app.phantom',
      walletType: 1,
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
