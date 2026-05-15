import { describe, expect, it } from 'vitest';

import { bindManifestParams, SandboxError } from '../sandbox.js';
import type { SkillInstallRecord, SkillManifest } from '../types.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const NOW_ISO = '2026-05-15T09:00:00.000Z';

const baseManifest = (paramsTemplate: Record<string, unknown>): SkillManifest => ({
  id: 'demo',
  name: 'Demo',
  version: '1.0.0',
  authorWallet: 'Author11111111111111111111111111111111111',
  description: 'demo',
  category: 'custom',
  schedule: { kind: 'interval', spec: '7d' },
  action: { connectorAction: 'transfer_spl', paramsTemplate: paramsTemplate as Record<string, never> },
  caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC'] },
});

const baseInstall = (overrides: Partial<SkillInstallRecord> = {}): SkillInstallRecord => ({
  id: 'install_1',
  walletAddress: WALLET,
  skillId: 'demo',
  manifestVersion: '1.0.0',
  caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC'] },
  installedAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  status: 'active',
  ...overrides,
});

describe('bindManifestParams', () => {
  it('substitutes all four supported variables', () => {
    const manifest = baseManifest({
      recipient: '{{walletAddress}}',
      token: 'USDC',
      amount: '{{caps.perRunMaxAmount}}',
      lifetime: '{{caps.lifetimeMaxAmount}}',
      note: 'execution #{{execution.count}} at {{nowIso}}',
    });
    const result = bindManifestParams({ install: baseInstall(), manifest, executionCount: 3, nowIso: NOW_ISO });
    expect(result.params).toEqual({
      recipient: WALLET,
      token: 'USDC',
      amount: '50',
      lifetime: '5000',
      note: `execution #3 at ${NOW_ISO}`,
    });
  });

  it('substitutes inside deeply-nested templates', () => {
    const manifest = baseManifest({
      transfer: {
        outer: [{ to: '{{walletAddress}}', amount: '{{caps.perRunMaxAmount}}' }],
      },
    });
    const result = bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO });
    expect(result.params).toEqual({
      transfer: {
        outer: [{ to: WALLET, amount: '50' }],
      },
    });
  });

  it('substitutes install-time params from install metadata', () => {
    const manifest = baseManifest({
      recipient: '{{install.recipient}}',
      destinationAddress: '{{install.destinationAddress}}',
      amount: '{{caps.perRunMaxAmount}}',
    });
    const result = bindManifestParams({
      install: baseInstall({
        metadata: {
          installParams: {
            recipient: 'Recipient111111111111111111111111111111111',
            destinationAddress: '0x1111111111111111111111111111111111111111',
          },
        },
      }),
      manifest,
      executionCount: 0,
      nowIso: NOW_ISO,
    });
    expect(result.params).toMatchObject({
      recipient: 'Recipient111111111111111111111111111111111',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      amount: '50',
    });
  });

  it('throws SandboxError with unresolved-placeholder when a template var is unknown', () => {
    const manifest = baseManifest({ foo: '{{unknownVar}}' });
    expect(() => bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO }))
      .toThrow(SandboxError);
    try {
      bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO });
    } catch (err) {
      expect((err as SandboxError).code).toBe('unresolved-placeholder');
    }
  });

  it('rejects forbidden keys: delegatedSigner', () => {
    const manifest = baseManifest({ delegatedSigner: WALLET, token: 'USDC' });
    expect(() => bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO }))
      .toThrow(/forbidden key.*delegatedSigner/);
  });

  it('rejects forbidden keys: privateKey nested', () => {
    const manifest = baseManifest({ token: 'USDC', metadata: { privateKey: 'x' } });
    expect(() => bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO }))
      .toThrow(/privateKey/);
  });

  it('rejects forbidden keys: seedPhrase', () => {
    const manifest = baseManifest({ token: 'USDC', seedPhrase: '...' });
    expect(() => bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO }))
      .toThrow(/seedPhrase/);
  });

  it("rejects approvalAuthority: 'unlimited'", () => {
    const manifest = baseManifest({ token: 'USDC', approvalAuthority: 'unlimited' });
    expect(() => bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO }))
      .toThrow(/unlimited/);
    try {
      bindManifestParams({ install: baseInstall(), manifest, executionCount: 0, nowIso: NOW_ISO });
    } catch (err) {
      expect((err as SandboxError).code).toBe('forbidden-unlimited-authority');
    }
  });
});
