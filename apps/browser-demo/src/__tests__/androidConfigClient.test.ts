import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Node test environment doesn't ship window-style addEventListener/dispatchEvent
// even though the DOM lib in tsconfig says they exist. Install a minimal real
// EventTarget on globalThis so the unload-cleanup tests can exercise the same
// code path the SPA hits in a browser. Casting through `unknown` because TS's DOM
// lib has stricter signatures than what node's EventTarget provides.
beforeAll(() => {
  if (typeof (globalThis as { dispatchEvent?: unknown }).dispatchEvent === 'function') return;
  const target = new EventTarget();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).addEventListener = target.addEventListener.bind(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).dispatchEvent = target.dispatchEvent.bind(target);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).removeEventListener = target.removeEventListener.bind(target);
});

import {
  biometricPrompt,
  clipboardWrite,
  getAppLifecycle,
  getBiometricStatus,
  getFeatureFlag,
  getRemoteConfig,
  getRemoteConfigStatus,
  getSystemInfo,
  haptic,
  openExternalUrl,
  refreshRemoteConfig,
  showNotification,
} from '../androidConfigClient.js';

interface BridgeStub {
  remoteConfigGet?: () => string;
  remoteConfigRefresh?: () => string;
  remoteConfigStatus?: () => string;
  openExternal?: (url: string) => boolean;
  systemInfo?: () => string;
  clipboardWrite?: (text: string) => boolean;
  haptic?: (pattern: string) => boolean;
  showNotification?: (payloadJson: string) => string;
  biometricStatus?: () => string;
  biometricPrompt?: (requestId: string, payloadJson: string) => void;
  appLifecycleState?: () => string;
}

type WindowWithBridge = typeof globalThis & {
  AgenticAndroid?: BridgeStub;
  __agenticAndroidBiometricBridge?: { resolve(requestId: string, envelope: unknown): void };
};

function installBridge(stub: BridgeStub): WindowWithBridge {
  const win = globalThis as WindowWithBridge;
  win.AgenticAndroid = stub;
  return win;
}

afterEach(() => {
  const win = globalThis as WindowWithBridge;
  delete win.AgenticAndroid;
  delete win.__agenticAndroidBiometricBridge;
  vi.useRealTimers();
});

describe('androidConfigClient', () => {
  describe('off-Android safety', () => {
    it('returns null from every reader when AgenticAndroid is absent', () => {
      expect(getRemoteConfig()).toBeNull();
      expect(getRemoteConfigStatus()).toBeNull();
      expect(refreshRemoteConfig()).toBeNull();
      expect(getSystemInfo()).toBeNull();
      expect(getBiometricStatus()).toBeNull();
      expect(getAppLifecycle()).toBeNull();
    });

    it('returns false from boolean primitives when bridge is absent', () => {
      expect(openExternalUrl('https://example.com')).toBe(false);
      expect(clipboardWrite('text')).toBe(false);
      expect(haptic('light')).toBe(false);
    });

    it('returns explicit error envelope from showNotification when bridge is absent', () => {
      expect(showNotification({ title: 't', body: 'b' })).toEqual({
        ok: false,
        error: 'bridge_not_available',
      });
    });

    it('biometricPrompt resolves with HARDWARE_UNAVAILABLE when bridge is absent', async () => {
      const result = await biometricPrompt({ title: 'Confirm' });
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('HARDWARE_UNAVAILABLE');
    });
  });

  describe('remote config readers', () => {
    it('parses the bridge JSON snapshot', () => {
      installBridge({
        remoteConfigGet: () => JSON.stringify({
          version: 3,
          source: 'server',
          fetchedAtMs: 99,
          walletRegistry: [],
          memoProofRouter: { envelopeVersion: 'v1', proofMemoPrefix: 'P', fallbackOnBlankPackage: true },
          featureFlags: { betaTradePlanner: true },
        }),
      });
      const cfg = getRemoteConfig();
      expect(cfg).not.toBeNull();
      expect(cfg?.version).toBe(3);
      expect(cfg?.source).toBe('server');
      expect(cfg?.featureFlags.betaTradePlanner).toBe(true);
    });

    it('returns null when bridge returns malformed JSON', () => {
      installBridge({ remoteConfigGet: () => 'not-json' });
      expect(getRemoteConfig()).toBeNull();
    });

    it('refreshRemoteConfig forwards through the bridge', () => {
      const refresh = vi.fn(() => JSON.stringify({
        version: 4,
        source: 'server',
        fetchedAtMs: 1000,
        walletCount: 5,
        envelopeVersion: 'v1',
      }));
      installBridge({ remoteConfigRefresh: refresh });
      const status = refreshRemoteConfig();
      expect(refresh).toHaveBeenCalledOnce();
      expect(status?.version).toBe(4);
    });
  });

  describe('getFeatureFlag', () => {
    it('returns the flag value when set', () => {
      installBridge({
        remoteConfigGet: () => JSON.stringify({
          version: 1,
          source: 'server',
          fetchedAtMs: 0,
          walletRegistry: [],
          memoProofRouter: { envelopeVersion: 'v1', proofMemoPrefix: 'P', fallbackOnBlankPackage: true },
          featureFlags: { enableX: true, enableY: false },
        }),
      });
      expect(getFeatureFlag('enableX')).toBe(true);
      expect(getFeatureFlag('enableY')).toBe(false);
    });

    it('falls back to default when flag is missing', () => {
      installBridge({
        remoteConfigGet: () => JSON.stringify({
          version: 1,
          source: 'server',
          fetchedAtMs: 0,
          walletRegistry: [],
          memoProofRouter: { envelopeVersion: 'v1', proofMemoPrefix: 'P', fallbackOnBlankPackage: true },
          featureFlags: {},
        }),
      });
      expect(getFeatureFlag('absent')).toBe(false);
      expect(getFeatureFlag('absent', true)).toBe(true);
    });

    it('falls back to default when config itself is unavailable', () => {
      expect(getFeatureFlag('any')).toBe(false);
      expect(getFeatureFlag('any', true)).toBe(true);
    });
  });

  describe('biometricPrompt', () => {
    it('resolves with the envelope the native side hands back', async () => {
      const fn = vi.fn();
      installBridge({ biometricPrompt: fn });

      const promise = biometricPrompt({ title: 'Confirm transfer' });

      // After installPromiseHandler, the bridge global exists.
      expect(fn).toHaveBeenCalledOnce();
      const [requestId, payloadJson] = fn.mock.calls[0]!;
      expect(requestId).toMatch(/^biometric-/);
      const payload = JSON.parse(payloadJson);
      expect(payload.title).toBe('Confirm transfer');

      const win = globalThis as WindowWithBridge;
      win.__agenticAndroidBiometricBridge!.resolve(requestId, {
        ok: true,
        kind: 'AUTH_SUCCEEDED',
        authType: 2,
      });

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.kind).toBe('AUTH_SUCCEEDED');
      expect(result.authType).toBe(2);
    });

    it('resolves with ERROR/dispatch_failed when the bridge call throws', async () => {
      installBridge({
        biometricPrompt: () => {
          throw new Error('native crash');
        },
      });
      const result = await biometricPrompt({ title: 'X' });
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('ERROR');
      expect(result.code).toBe('dispatch_failed');
      expect(result.message).toContain('native crash');
    });

    it('ignores resolve calls for unknown request IDs', async () => {
      const fn = vi.fn();
      installBridge({ biometricPrompt: fn });

      const promise = biometricPrompt({ title: 'X' });
      const win = globalThis as WindowWithBridge;
      // Resolve with a wrong ID first — must be ignored.
      win.__agenticAndroidBiometricBridge!.resolve('unrelated-id', { ok: true, kind: 'AUTH_SUCCEEDED' });
      // Then resolve with the right ID.
      const [requestId] = fn.mock.calls[0]!;
      win.__agenticAndroidBiometricBridge!.resolve(requestId, { ok: false, kind: 'USER_CANCELED' });

      const result = await promise;
      expect(result.kind).toBe('USER_CANCELED');
    });

    it('fires a timeout envelope when the native callback never arrives', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      installBridge({ biometricPrompt: fn });

      const promise = biometricPrompt({ title: 'X' });
      vi.advanceTimersByTime(120_001);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('ERROR');
      expect(result.code).toBe('timeout');
    });
  });

  describe('runtime type guards', () => {
    it('getRemoteConfig returns null when bridge returns valid JSON of the wrong shape', () => {
      installBridge({ remoteConfigGet: () => JSON.stringify({ pretendingToBeConfig: true }) });
      expect(getRemoteConfig()).toBeNull();
    });

    it('getRemoteConfigStatus returns null for shape-invalid JSON', () => {
      installBridge({ remoteConfigStatus: () => JSON.stringify({ version: 'not-a-number' }) });
      expect(getRemoteConfigStatus()).toBeNull();
    });

    it('getSystemInfo returns null for shape-invalid JSON', () => {
      installBridge({ systemInfo: () => JSON.stringify({ manufacturer: 42 }) });
      expect(getSystemInfo()).toBeNull();
    });

    it('getBiometricStatus returns null for shape-invalid JSON', () => {
      installBridge({ biometricStatus: () => JSON.stringify({ kind: 'AVAILABLE' /* no status */ }) });
      expect(getBiometricStatus()).toBeNull();
    });

    it('getAppLifecycle returns null for shape-invalid JSON', () => {
      installBridge({ appLifecycleState: () => JSON.stringify({ state: 'resumed' /* no hasFocus */ }) });
      expect(getAppLifecycle()).toBeNull();
    });

    it('showNotification returns invalid_response_shape envelope when native response is malformed', () => {
      installBridge({ showNotification: () => JSON.stringify({ pretendingToBeOk: true }) });
      const result = showNotification({ title: 't', body: 'b' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('invalid_response_shape');
    });
  });

  describe('PENDING_BIOMETRIC cleanup', () => {
    it('beforeunload purges every in-flight biometric prompt', async () => {
      const fn = vi.fn();
      installBridge({ biometricPrompt: fn });

      // Fire 3 prompts; none will be resolved by the native side.
      const p1 = biometricPrompt({ title: 'P1' });
      const p2 = biometricPrompt({ title: 'P2' });
      const p3 = biometricPrompt({ title: 'P3' });

      // Dispatch the beforeunload event the SPA would emit on tab close / route change.
      globalThis.dispatchEvent(new Event('beforeunload'));

      const results = await Promise.all([p1, p2, p3]);
      for (const r of results) {
        expect(r.ok).toBe(false);
        expect(r.kind).toBe('USER_CANCELED');
        expect(r.message).toContain('beforeunload');
      }
    });

    it('pagehide event also purges in-flight prompts', async () => {
      installBridge({ biometricPrompt: vi.fn() });

      const promise = biometricPrompt({ title: 'X' });
      globalThis.dispatchEvent(new Event('pagehide'));

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('USER_CANCELED');
      expect(result.message).toContain('pagehide');
    });
  });

  describe('simple primitives', () => {
    it('forwards openExternalUrl through the bridge', () => {
      const fn = vi.fn(() => true);
      installBridge({ openExternal: fn });
      expect(openExternalUrl('https://agentic-signer.com')).toBe(true);
      expect(fn).toHaveBeenCalledWith('https://agentic-signer.com');
    });

    it('parses systemInfo JSON', () => {
      installBridge({
        systemInfo: () => JSON.stringify({
          manufacturer: 'Google',
          model: 'Pixel 8',
          device: 'shiba',
          sdkInt: 34,
          release: '14',
          locale: 'en-US',
          timezone: 'America/Los_Angeles',
          batteryPercent: 87,
          networkType: 'wifi',
          packageName: 'com.agentic.wallet',
        }),
      });
      const info = getSystemInfo();
      expect(info).not.toBeNull();
      expect(info?.model).toBe('Pixel 8');
      expect(info?.networkType).toBe('wifi');
    });

    it('parses showNotification envelope', () => {
      installBridge({
        showNotification: () => JSON.stringify({ ok: true, id: 1003, tag: null }),
      });
      const res = showNotification({ title: 't', body: 'b' });
      expect(res.ok).toBe(true);
      expect(res.id).toBe(1003);
    });

    it('forwards haptic pattern', () => {
      const fn = vi.fn(() => true);
      installBridge({ haptic: fn });
      haptic('medium');
      expect(fn).toHaveBeenCalledWith('medium');
    });
  });
});
