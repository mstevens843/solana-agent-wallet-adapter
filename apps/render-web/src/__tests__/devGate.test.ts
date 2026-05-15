import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['AGENTIC_DEV_AP2_ACP', 'AGENTIC_DEV_WALLET_ALLOWLIST'] as const;
const TEST_WALLET = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';

interface EnvSnapshot {
  [key: string]: string | undefined;
}

interface DevGateModule {
  DEV_WALLET_ALLOWLIST: readonly string[];
  isAllowedDevWallet: (walletAddress: string | undefined | null) => boolean;
  devLayer1Enabled: () => boolean;
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

describe('devGate', () => {
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
});
