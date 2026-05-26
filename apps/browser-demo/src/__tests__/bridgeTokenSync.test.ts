import { describe, expect, it } from 'vitest';

import { computeBridgeConfigUpdate } from '../bridgeTokenSync.js';
import type { TauriBridgeStatus } from '../tauriNative.js';

function fixture(overrides: Partial<TauriBridgeStatus> = {}): TauriBridgeStatus {
  return {
    running: false,
    pid: null,
    startedAt: null,
    bridgeReachable: false,
    restarting: false,
    bridgeUrl: 'http://127.0.0.1:8787',
    bridgeToken: 'a'.repeat(48),
    repoRoot: '',
    envPath: '',
    actionConfigPath: '',
    preparedActionsPath: '',
    runtimeMode: 'missing-sidecar',
    sidecarPath: null,
    desktopConfigPath: '',
    runtimeDataPath: '',
    releaseVersion: '0.0.0',
    diagnostics: [],
    lastError: null,
    ...overrides,
  };
}

describe('computeBridgeConfigUpdate', () => {
  it('returns nulls when the Tauri status is missing (web-only mode)', () => {
    expect(computeBridgeConfigUpdate(null)).toEqual({
      bridgeUrl: null,
      bridgeToken: null,
    });
  });

  it('mirrors a populated Rust status into both fields', () => {
    const update = computeBridgeConfigUpdate(fixture({
      bridgeUrl: 'http://127.0.0.1:9999',
      bridgeToken: 'abc123',
    }));
    expect(update).toEqual({
      bridgeUrl: 'http://127.0.0.1:9999',
      bridgeToken: 'abc123',
    });
  });

  it('returns null tokens when the Rust value is empty so the webview default is preserved', () => {
    const update = computeBridgeConfigUpdate(fixture({
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: '',
    }));
    expect(update.bridgeUrl).toBe('http://127.0.0.1:8787');
    expect(update.bridgeToken).toBeNull();
  });

  it('treats whitespace-only tokens as empty (trim defense)', () => {
    const update = computeBridgeConfigUpdate(fixture({
      bridgeUrl: '  http://127.0.0.1:9000  ',
      bridgeToken: '   ',
    }));
    expect(update.bridgeUrl).toBe('http://127.0.0.1:9000');
    expect(update.bridgeToken).toBeNull();
  });
});
