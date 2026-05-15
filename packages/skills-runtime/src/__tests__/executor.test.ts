import { describe, expect, it } from 'vitest';

import { buildApprovalRequest, normalizeSkillApprovalKind } from '../executor.js';
import type { SkillInstallRecord, SkillManifest } from '../types.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';
const NOW_ISO = '2026-05-15T09:00:00.000Z';

const manifest: SkillManifest = {
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.2.3',
  authorWallet: 'Author11111111111111111111111111111111111',
  description: 'DCA every Friday',
  category: 'dca',
  schedule: { kind: 'cron', spec: '0 9 * * FRI' },
  action: { connectorAction: 'swap', paramsTemplate: { inputToken: 'USDC', amount: '50' } },
  caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC'] },
};

const install: SkillInstallRecord = {
  id: 'install_42',
  walletAddress: WALLET,
  skillId: 'friday-dca',
  manifestVersion: '1.2.3',
  caps: manifest.caps,
  installedAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  status: 'active',
};

describe('buildApprovalRequest', () => {
  it('emits kind, summary, params, metadata, cluster', () => {
    const result = buildApprovalRequest({
      install,
      manifest,
      boundParams: { inputToken: 'USDC', amount: '50' },
      cluster: 'mainnet-beta',
      nowIso: NOW_ISO,
    });
    expect(result.kind).toBe('swap');
    expect(result.summary).toBe('Friday DCA (skill friday-dca@1.2.3)');
    expect(result.params).toEqual({ inputToken: 'USDC', amount: '50' });
    expect(result.cluster).toBe('mainnet-beta');
    expect(result.metadata).toMatchObject({
      skillId: 'friday-dca',
      skillVersion: '1.2.3',
      skillInstallId: 'install_42',
      skillExecutionAt: NOW_ISO,
    });
    expect(typeof result.metadata.approvalBoundary).toBe('string');
  });

  it('normalizes MCP prepare_* connector actions into executable approval kinds', () => {
    const result = buildApprovalRequest({
      install,
      manifest: {
        ...manifest,
        action: { connectorAction: 'prepare_wormhole_transfer', paramsTemplate: { sourceMint: 'USDC', amount: '50' } },
      },
      boundParams: { sourceMint: 'USDC', amount: '50' },
      cluster: 'mainnet-beta',
      nowIso: NOW_ISO,
    });
    expect(result.kind).toBe('wormhole_transfer');
    expect(result.metadata).toMatchObject({
      skillConnectorAction: 'prepare_wormhole_transfer',
      normalizedApprovalKind: 'wormhole_transfer',
    });
  });

  it('normalizes raw tool names as well as short prepare_* names', () => {
    expect(normalizeSkillApprovalKind('prepare_swap')).toBe('swap');
    expect(normalizeSkillApprovalKind('solana_prepare_kamino_deposit')).toBe('kamino_deposit');
    expect(normalizeSkillApprovalKind('yield.auto_rotate')).toBe('yield.auto_rotate');
  });

  it('throws when manifest is missing connectorAction', () => {
    const broken: SkillManifest = {
      ...manifest,
      action: { connectorAction: '', paramsTemplate: {} },
    };
    expect(() => buildApprovalRequest({
      install,
      manifest: broken,
      boundParams: {},
      cluster: 'devnet',
      nowIso: NOW_ISO,
    })).toThrow(/connectorAction/);
  });
});
