import { describe, expect, it } from 'vitest';

import {
  checkAi,
  type DeviceAgentHealthHint,
  type HealthCheckInputs,
} from '../systemHealth.js';

function baseInputs(overrides: Partial<HealthCheckInputs> = {}): HealthCheckInputs {
  return {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    cluster: 'mainnet-beta',
    walletAddress: null,
    walletConnected: false,
    aiMode: 'device-agent',
    bridgeUrl: null,
    bridgeToken: null,
    bridgeActive: false,
    ...overrides,
  };
}

const ANDROID_RUNNING: DeviceAgentHealthHint = {
  available: true,
  configured: true,
  state: 'running',
  runtime: 'android-native',
  bridgeAvailable: true,
};

const BROWSER_NATIVE_RUNNING: DeviceAgentHealthHint = {
  available: true,
  configured: true,
  state: 'running',
  runtime: 'browser-native',
  bridgeAvailable: false,
};

describe('checkAi (device-agent mode)', () => {
  it('reports scaffold-only on browser dev when no hint is provided', async () => {
    const result = await checkAi(baseInputs());
    expect(result).toMatchObject({
      id: 'ai',
      status: 'warn',
      message: 'Device Agent scaffold',
    });
  });

  it('reports browser-dev runtime as scaffold-only even when a hint exists', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: {
        available: false,
        configured: false,
        state: 'stopped',
        runtime: 'browser-dev',
        bridgeAvailable: false,
      },
    }));
    expect(result.status).toBe('warn');
    expect(result.message).toBe('Device Agent scaffold');
  });

  it('reports render-gated runtime as control-only', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: {
        available: true,
        configured: false,
        state: 'stopped',
        runtime: 'render-gated',
        bridgeAvailable: false,
      },
    }));
    expect(result.message).toBe('Device Agent control-only');
    expect(result.status).toBe('warn');
  });

  it('reports bridge missing when Android runtime cannot reach the native bridge', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: {
        available: true,
        configured: true,
        state: 'running',
        runtime: 'android-native',
        bridgeAvailable: false,
      },
    }));
    expect(result.message).toBe('Device Agent bridge missing');
    expect(result.status).toBe('warn');
  });

  it('reports an error state when the runtime is in error', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: { ...ANDROID_RUNNING, state: 'error', message: 'Provider failed.' },
    }));
    expect(result.status).toBe('fail');
    expect(result.message).toBe('Device Agent error');
    expect(result.detail).toBe('Provider failed.');
  });

  it('reports unconfigured when the runtime needs a key', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: { ...ANDROID_RUNNING, configured: false, state: 'stopped' },
    }));
    expect(result.message).toBe('Device Agent unconfigured');
    expect(result.status).toBe('warn');
  });

  it('reports OK when the Android runtime is running, configured, and bridge is available', async () => {
    const result = await checkAi(baseInputs({ deviceAgent: ANDROID_RUNNING }));
    expect(result.status).toBe('ok');
    expect(result.message).toBe('Device Agent ready');
  });

  it('reports OK when the browser-native runtime is running without an Android bridge', async () => {
    const result = await checkAi(baseInputs({ deviceAgent: BROWSER_NATIVE_RUNNING }));
    expect(result.status).toBe('ok');
    expect(result.message).toBe('Device Agent ready');
    expect(result.detail).toContain('browser tab');
  });

  it('uses reload remediation when browser-native enters an error state', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: { ...BROWSER_NATIVE_RUNNING, state: 'error', message: 'Storage failed.' },
    }));
    expect(result.status).toBe('fail');
    expect(result.message).toBe('Device Agent error');
    expect(result.remediation).toEqual({ label: 'Reload tab', intent: 'reload' });
  });

  it('reports browser-native as unconfigured before a key is staged', async () => {
    const result = await checkAi(baseInputs({
      deviceAgent: { ...BROWSER_NATIVE_RUNNING, configured: false, state: 'stopped' },
    }));
    expect(result.message).toBe('Device Agent unconfigured');
    expect(result.status).toBe('warn');
  });

  it('distinguishes starting from stopped when configured but not yet running', async () => {
    const starting = await checkAi(baseInputs({
      deviceAgent: { ...ANDROID_RUNNING, state: 'starting' },
    }));
    expect(starting.message).toBe('Device Agent starting');

    const stopped = await checkAi(baseInputs({
      deviceAgent: { ...ANDROID_RUNNING, state: 'stopped' },
    }));
    expect(stopped.message).toBe('Device Agent stopped');
  });
});
