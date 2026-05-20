import { describe, expect, it } from 'vitest';

import { skills } from '../dev/index.js';

const VALID_MANIFEST: skills.SkillManifest = {
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.0.0',
  authorWallet: 'Author11111111111111111111111111111111111',
  description: 'Buy SOL with USDC every Friday.',
  category: 'dca',
  schedule: { kind: 'cron', spec: '0 14 * * 5' },
  action: {
    connectorAction: 'prepare_swap',
    paramsTemplate: {
      inputMint: 'USDC',
      outputMint: 'SOL',
      amount: '50',
    },
  },
  caps: {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '2600',
    allowlistedTokens: ['USDC', 'SOL'],
    maxExecutions: 52,
  },
};

describe('DevLayer1 skills validators', () => {
  it('validates a skill manifest and preserves the stable shape', () => {
    expect(skills.validateSkillManifest(VALID_MANIFEST)).toEqual(VALID_MANIFEST);
  });

  it('rejects forbidden authority fields anywhere in a manifest', () => {
    expect(() => skills.validateSkillManifest({
      ...VALID_MANIFEST,
      action: {
        ...VALID_MANIFEST.action,
        paramsTemplate: {
          ...VALID_MANIFEST.action.paramsTemplate,
          nested: { delegatedSigner: 'server-wallet' },
        },
      },
    })).toThrow(/not permitted/);

    expect(() => skills.validateSkillManifest({
      ...VALID_MANIFEST,
      approvalAuthority: 'unlimited',
    })).toThrow(/unlimited/);
  });

  it('validates install requests and rejects forbidden install params', () => {
    expect(skills.validateInstallSkillRequest({
      skillId: 'friday-dca',
      manifestVersion: '1.0.0',
      caps: VALID_MANIFEST.caps,
      acceptMonetization: false,
      installParams: { recipient: 'Recipient111111111111111111111111111111111' },
    })).toMatchObject({
      skillId: 'friday-dca',
      acceptMonetization: false,
    });

    expect(() => skills.validateInstallSkillRequest({
      skillId: 'friday-dca',
      manifestVersion: '1.0.0',
      caps: VALID_MANIFEST.caps,
      acceptMonetization: false,
      installParams: { privateKey: 'nope' },
    })).toThrow(/not permitted/);
  });

  it('rejects malformed caps and monetization', () => {
    expect(() => skills.validateSkillManifest({
      ...VALID_MANIFEST,
      caps: { ...VALID_MANIFEST.caps, allowlistedTokens: [] },
    })).toThrow(/allowlistedTokens/);

    expect(() => skills.validateSkillManifest({
      ...VALID_MANIFEST,
      monetization: { kind: 'performance-fee', payoutWallet: VALID_MANIFEST.authorWallet, feePercent: 101 },
    })).toThrow(/feePercent/);
  });

  it('accepts USDC and SKR as monetization tokens; rejects others', () => {
    const usdc = skills.validateSkillManifest({
      ...VALID_MANIFEST,
      monetization: {
        kind: 'monthly',
        payoutWallet: VALID_MANIFEST.authorWallet,
        amount: '5',
        token: 'USDC',
      },
    });
    expect(usdc.monetization?.token).toBe('USDC');

    const skr = skills.validateSkillManifest({
      ...VALID_MANIFEST,
      monetization: {
        kind: 'monthly',
        payoutWallet: VALID_MANIFEST.authorWallet,
        amount: '5',
        token: 'SKR',
      },
    });
    expect(skr.monetization?.token).toBe('SKR');

    // Omitting `token` is backward-compatible (defaults to USDC at install time).
    const omitted = skills.validateSkillManifest({
      ...VALID_MANIFEST,
      monetization: {
        kind: 'monthly',
        payoutWallet: VALID_MANIFEST.authorWallet,
        amount: '5',
      },
    });
    expect(omitted.monetization?.token).toBeUndefined();

    expect(() => skills.validateSkillManifest({
      ...VALID_MANIFEST,
      monetization: {
        kind: 'monthly',
        payoutWallet: VALID_MANIFEST.authorWallet,
        amount: '5',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        token: 'BONK' as any,
      },
    })).toThrow(/must be one of/);
  });
});
