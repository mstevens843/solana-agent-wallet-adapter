import { afterEach, describe, expect, it } from 'vitest';

import { getPhoenixVulcanPolicy, type AgentWalletConfig } from '../../config.js';

afterEach(() => {
  delete process.env.PHOENIX_VULCAN_ENABLED;
  delete process.env.PHOENIX_VULCAN_ALLOW_DANGEROUS;
  delete process.env.PHOENIX_VULCAN_BINARY;
  delete process.env.PHOENIX_VULCAN_AUTO_RESTART;
  delete process.env.PHOENIX_VULCAN_REQUIRED_VERSION;
  delete process.env.VULCAN_WALLET_NAME;
});

const cfg = (overrides: Record<string, unknown> = {}): AgentWalletConfig =>
  ({
    cluster: 'mainnet-beta',
    connectors: {
      phoenix: { vulcan: overrides },
    },
  } as unknown as AgentWalletConfig);

describe('getPhoenixVulcanPolicy', () => {
  it('defaults to disabled with conservative options', () => {
    const policy = getPhoenixVulcanPolicy({ cluster: 'mainnet-beta' } as AgentWalletConfig);
    expect(policy.enabled).toBe(false);
    expect(policy.binaryPath).toBe('vulcan');
    expect(policy.allowDangerous).toBe(false);
    expect(policy.walletPasswordEnvVar).toBe('VULCAN_WALLET_PASSWORD');
    expect(policy.maxToolCallTimeoutMs).toBe(60_000);
    expect(policy.walletName).toBeUndefined();
  });

  it('reads enabled + dangerous overrides from config', () => {
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true, allowDangerous: true, walletName: 'paper-1' }));
    expect(policy.enabled).toBe(true);
    expect(policy.allowDangerous).toBe(true);
    expect(policy.walletName).toBe('paper-1');
  });

  it('falls back to env vars when config is missing', () => {
    process.env.PHOENIX_VULCAN_ENABLED = 'true';
    process.env.PHOENIX_VULCAN_ALLOW_DANGEROUS = 'true';
    process.env.PHOENIX_VULCAN_BINARY = '/usr/local/bin/vulcan';
    process.env.VULCAN_WALLET_NAME = 'env-wallet';
    const policy = getPhoenixVulcanPolicy({ cluster: 'mainnet-beta' } as AgentWalletConfig);
    expect(policy.enabled).toBe(true);
    expect(policy.allowDangerous).toBe(true);
    expect(policy.binaryPath).toBe('/usr/local/bin/vulcan');
    expect(policy.walletName).toBe('env-wallet');
  });

  it('config beats env when both are set', () => {
    process.env.PHOENIX_VULCAN_ENABLED = 'false';
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true }));
    expect(policy.enabled).toBe(true);
  });

  it('respects a custom timeout', () => {
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true, maxToolCallTimeoutMs: 5_000 }));
    expect(policy.maxToolCallTimeoutMs).toBe(5_000);
  });

  // T1.1: D1/D2 config field surfacing.
  it('exposes autoRestart from config', () => {
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true, autoRestart: true }));
    expect(policy.autoRestart).toBe(true);
  });

  it('reads autoRestart from PHOENIX_VULCAN_AUTO_RESTART env', () => {
    process.env.PHOENIX_VULCAN_AUTO_RESTART = 'true';
    const policy = getPhoenixVulcanPolicy({ cluster: 'mainnet-beta' } as AgentWalletConfig);
    expect(policy.autoRestart).toBe(true);
  });

  it('exposes restartBackoffMs', () => {
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true, restartBackoffMs: [100, 200, 400] }));
    expect(policy.restartBackoffMs).toEqual([100, 200, 400]);
  });

  it('exposes requiredServerName / requiredServerVersion', () => {
    const policy = getPhoenixVulcanPolicy(
      cfg({ enabled: true, requiredServerName: 'vulcan-real', requiredServerVersion: '0.1.5' }),
    );
    expect(policy.requiredServerName).toBe('vulcan-real');
    expect(policy.requiredServerVersion).toBe('0.1.5');
  });

  it('reads requiredServerVersion from PHOENIX_VULCAN_REQUIRED_VERSION env', () => {
    process.env.PHOENIX_VULCAN_REQUIRED_VERSION = '0.2.0';
    const policy = getPhoenixVulcanPolicy({ cluster: 'mainnet-beta' } as AgentWalletConfig);
    expect(policy.requiredServerVersion).toBe('0.2.0');
  });

  // T1.3: multi-wallet config exposure.
  it('surfaces walletPasswordsByEnvVar when non-empty', () => {
    const policy = getPhoenixVulcanPolicy(
      cfg({
        enabled: true,
        walletPasswordsByEnvVar: { alice: 'ALICE_PW', bob: 'BOB_PW' },
      }),
    );
    expect(policy.walletPasswordsByEnvVar).toEqual({ alice: 'ALICE_PW', bob: 'BOB_PW' });
  });

  it('omits walletPasswordsByEnvVar when empty', () => {
    const policy = getPhoenixVulcanPolicy(cfg({ enabled: true, walletPasswordsByEnvVar: {} }));
    expect(policy.walletPasswordsByEnvVar).toBeUndefined();
  });

  it('surfaces allowedWallets + defaultWalletName', () => {
    const policy = getPhoenixVulcanPolicy(
      cfg({ enabled: true, allowedWallets: ['alice', 'bob'], defaultWalletName: 'alice' }),
    );
    expect(policy.allowedWallets).toEqual(['alice', 'bob']);
    expect(policy.defaultWalletName).toBe('alice');
  });
});
