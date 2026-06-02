import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'AGENTIC_DEV_AP2_ACP',
  'AGENTIC_DEV_WALLET_ALLOWLIST',
  'AGENTIC_DEVICE_AGENT',
  'AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST',
  'AGENTIC_ANDROID_DEVICE_AGENT',
  'AGENTIC_BROWSER_DEVICE_AGENT',
] as const;
const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const SECOND_DEVICE_WALLET = '7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';

interface EnvSnapshot {
  [key: string]: string | undefined;
}

interface DevGateModule {
  DEV_WALLET_ALLOWLIST: readonly string[];
  DEVICE_AGENT_WALLET_ALLOWLIST: readonly string[];
  isAllowedDevWallet: (walletAddress: string | undefined | null) => boolean;
  isAllowedDeviceAgentWallet: (walletAddress: string | undefined | null) => boolean;
  devLayer1Enabled: () => boolean;
  deviceAgentFeatureEnabled: () => boolean;
  deviceAgentRuntimeAvailability: () => { android: boolean; browserNative: boolean };
}

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {};
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadFreshGate(): Promise<DevGateModule> {
  // Module-level constants in devGate.ts capture process.env at import time,
  // so we reset Vitest's module cache before each load to pick up env mutations.
  vi.resetModules();
  return (await import('../cloud/devGate.js')) as DevGateModule;
}

// Sequential: the tests below all mutate `process.env.AGENTIC_*` and reload
// the devGate module via `vi.resetModules()` between cases. If vitest were
// ever configured to run tests within this describe concurrently (e.g. via a
// future `describe.concurrent` or a config flag), the env mutations would
// race across tests. Explicit `.sequential` pins the safe ordering.
describe.sequential('devGate', () => {
  let original: EnvSnapshot;

  beforeEach(() => {
    original = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(original);
  });

  it('rejects all wallets when allowlist is empty', async () => {
    delete process.env.AGENTIC_DEV_WALLET_ALLOWLIST;
    const gate = await loadFreshGate();
    expect(gate.DEV_WALLET_ALLOWLIST).toEqual([]);
    expect(gate.isAllowedDevWallet(TEST_WALLET)).toBe(false);
    expect(gate.isAllowedDevWallet(undefined)).toBe(false);
  });

  it('accepts an exact wallet match', async () => {
    process.env.AGENTIC_DEV_WALLET_ALLOWLIST = TEST_WALLET;
    const gate = await loadFreshGate();
    expect(gate.DEV_WALLET_ALLOWLIST).toContain(TEST_WALLET);
    expect(gate.isAllowedDevWallet(TEST_WALLET)).toBe(true);
  });

  it('rejects wallets not in the comma-separated list', async () => {
    process.env.AGENTIC_DEV_WALLET_ALLOWLIST = `${TEST_WALLET},AnotherWallet1111111111111111111111111111111`;
    const gate = await loadFreshGate();
    expect(gate.isAllowedDevWallet(TEST_WALLET)).toBe(true);
    expect(gate.isAllowedDevWallet(OTHER_WALLET)).toBe(false);
  });

  it('only enables layer 1 when flag is exactly "1"', async () => {
    process.env.AGENTIC_DEV_AP2_ACP = '1';
    let gate = await loadFreshGate();
    expect(gate.devLayer1Enabled()).toBe(true);

    process.env.AGENTIC_DEV_AP2_ACP = 'true';
    gate = await loadFreshGate();
    expect(gate.devLayer1Enabled()).toBe(false);

    delete process.env.AGENTIC_DEV_AP2_ACP;
    gate = await loadFreshGate();
    expect(gate.devLayer1Enabled()).toBe(false);
  });

  it('gates Device Agent behind its server flag', async () => {
    delete process.env.AGENTIC_DEVICE_AGENT;
    let gate = await loadFreshGate();
    expect(gate.deviceAgentFeatureEnabled()).toBe(false);

    process.env.AGENTIC_DEVICE_AGENT = '1';
    gate = await loadFreshGate();
    expect(gate.deviceAgentFeatureEnabled()).toBe(true);
  });

  it('defaults Device Agent access to no wallets', async () => {
    process.env.AGENTIC_DEVICE_AGENT = '1';
    delete process.env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST;
    const gate = await loadFreshGate();
    expect(gate.DEVICE_AGENT_WALLET_ALLOWLIST).toEqual([]);
    expect(gate.isAllowedDeviceAgentWallet(TEST_WALLET)).toBe(false);
    expect(gate.isAllowedDeviceAgentWallet(SECOND_DEVICE_WALLET)).toBe(false);
    expect(gate.isAllowedDeviceAgentWallet(OTHER_WALLET)).toBe(false);
  });

  it('allows overriding the Device Agent wallet list', async () => {
    process.env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST = OTHER_WALLET;
    const gate = await loadFreshGate();
    expect(gate.isAllowedDeviceAgentWallet(TEST_WALLET)).toBe(false);
    expect(gate.isAllowedDeviceAgentWallet(OTHER_WALLET)).toBe(true);
  });

  describe('deviceAgentRuntimeAvailability', () => {
    it('reports both runtimes unavailable when the master gate is off', async () => {
      delete process.env.AGENTIC_DEVICE_AGENT;
      process.env.AGENTIC_BROWSER_DEVICE_AGENT = '1';
      delete process.env.AGENTIC_ANDROID_DEVICE_AGENT;
      const gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability()).toEqual({ android: false, browserNative: false });
    });

    it('defaults Android runtime to available when the master gate is on', async () => {
      process.env.AGENTIC_DEVICE_AGENT = '1';
      delete process.env.AGENTIC_ANDROID_DEVICE_AGENT;
      delete process.env.AGENTIC_BROWSER_DEVICE_AGENT;
      const gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability()).toEqual({ android: true, browserNative: false });
    });

    it('opts the Android runtime out only when AGENTIC_ANDROID_DEVICE_AGENT is exactly "0"', async () => {
      process.env.AGENTIC_DEVICE_AGENT = '1';
      process.env.AGENTIC_ANDROID_DEVICE_AGENT = '0';
      const gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability().android).toBe(false);

      process.env.AGENTIC_ANDROID_DEVICE_AGENT = 'false';
      const gateAgain = await loadFreshGate();
      expect(gateAgain.deviceAgentRuntimeAvailability().android).toBe(true);
    });

    it('enables the browser-native runtime only when AGENTIC_BROWSER_DEVICE_AGENT is exactly "1"', async () => {
      process.env.AGENTIC_DEVICE_AGENT = '1';
      process.env.AGENTIC_BROWSER_DEVICE_AGENT = 'true';
      let gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability().browserNative).toBe(false);

      process.env.AGENTIC_BROWSER_DEVICE_AGENT = '1';
      gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability().browserNative).toBe(true);
    });

    it('reports both runtimes when fully enabled', async () => {
      process.env.AGENTIC_DEVICE_AGENT = '1';
      delete process.env.AGENTIC_ANDROID_DEVICE_AGENT;
      process.env.AGENTIC_BROWSER_DEVICE_AGENT = '1';
      const gate = await loadFreshGate();
      expect(gate.deviceAgentRuntimeAvailability()).toEqual({ android: true, browserNative: true });
    });
  });
});
