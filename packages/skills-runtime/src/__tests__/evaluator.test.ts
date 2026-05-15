import { describe, expect, it } from 'vitest';

import {
  addDecimalStrings,
  compareDecimalStrings,
  evaluateCaps,
  extractTemplateAmount,
  extractTemplateRecipient,
  extractTemplateToken,
  isRecipientAllowed,
  isTokenAllowed,
} from '../evaluator.js';
import type { EvaluatorInput, EvaluatorSkipReason, JsonObject, SkillInstallRecord, SkillManifest } from '../types.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';

const baseManifest = (overrides: Partial<SkillManifest> = {}): SkillManifest => ({
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.0.0',
  authorWallet: 'Author11111111111111111111111111111111111',
  description: 'DCA every Friday',
  category: 'dca',
  schedule: { kind: 'cron', spec: '0 9 * * FRI' },
  action: { connectorAction: 'swap', paramsTemplate: { inputToken: 'USDC', amount: '50' } },
  caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC'] },
  ...overrides,
});

const baseInstall = (overrides: Partial<SkillInstallRecord> = {}): SkillInstallRecord => ({
  id: 'install_1',
  walletAddress: WALLET,
  skillId: 'friday-dca',
  manifestVersion: '1.0.0',
  caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC'] },
  installedAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  status: 'active',
  ...overrides,
});

const baseInput = (overrides: Partial<EvaluatorInput> = {}): EvaluatorInput => ({
  install: baseInstall(),
  manifest: baseManifest(),
  executionCount: 0,
  totalExecutedAmount: '0',
  now: new Date('2026-05-15T09:00:00.000Z'),
  ...overrides,
});

describe('evaluateCaps', () => {
  it('approves a fresh active install with allowlisted token', () => {
    expect(evaluateCaps(baseInput())).toEqual({ allowed: true });
  });

  it('rejects paused installs', () => {
    expect(evaluateCaps(baseInput({ install: baseInstall({ status: 'paused' }) })))
      .toEqual({ allowed: false, reason: 'not-active' });
  });

  it('rejects expired installs', () => {
    const install = baseInstall({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
        expiresAt: '2026-05-01T00:00:00.000Z',
      },
    });
    expect(evaluateCaps(baseInput({ install }))).toEqual({ allowed: false, reason: 'expired' });
  });

  it('rejects when execution count reaches maxExecutions', () => {
    const install = baseInstall({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
        maxExecutions: 3,
      },
    });
    expect(evaluateCaps(baseInput({ install, executionCount: 3 })))
      .toEqual({ allowed: false, reason: 'max-executions-reached' });
    expect(evaluateCaps(baseInput({ install, executionCount: 2 })))
      .toEqual({ allowed: true });
  });

  it('rejects when lifetime cap is reached', () => {
    expect(evaluateCaps(baseInput({ totalExecutedAmount: '5000' })))
      .toEqual({ allowed: false, reason: 'lifetime-cap-reached' });
    expect(evaluateCaps(baseInput({ totalExecutedAmount: '4949.99' })))
      .toEqual({ allowed: true });
    expect(evaluateCaps(baseInput({ totalExecutedAmount: '4950.01' })))
      .toEqual({ allowed: false, reason: 'lifetime-cap-reached' });
  });

  it('rejects when current run amount exceeds the per-run cap', () => {
    const manifest = baseManifest({
      action: { connectorAction: 'swap', paramsTemplate: { inputToken: 'USDC', amount: '50.01' } },
    });
    expect(evaluateCaps(baseInput({ manifest })))
      .toEqual({ allowed: false, reason: 'per-run-cap-exceeded' });
  });

  it('rejects missing, invalid, negative, and ambiguous amounts before approval', () => {
    const cases: Array<{ paramsTemplate: JsonObject; reason: EvaluatorSkipReason }> = [
      { paramsTemplate: { inputToken: 'USDC' }, reason: 'amount-missing' },
      { paramsTemplate: { inputToken: 'USDC', amount: 50 }, reason: 'amount-invalid' },
      { paramsTemplate: { inputToken: 'USDC', amount: '-1' }, reason: 'amount-invalid' },
      { paramsTemplate: { inputToken: 'USDC', amount: '1e3' }, reason: 'amount-invalid' },
      { paramsTemplate: { inputToken: 'USDC', amount: '50', inputAmount: '50' }, reason: 'amount-ambiguous' },
    ];

    for (const { paramsTemplate, reason } of cases) {
      const manifest = baseManifest({
        action: { connectorAction: 'swap', paramsTemplate },
      });
      expect(evaluateCaps(baseInput({ manifest })))
        .toEqual({ allowed: false, reason });
    }
  });

  it('rejects when manifest token is not allowlisted', () => {
    const manifest = baseManifest({
      action: { connectorAction: 'swap', paramsTemplate: { inputToken: 'BONK', amount: '50' } },
    });
    expect(evaluateCaps(baseInput({ manifest })))
      .toEqual({ allowed: false, reason: 'token-not-allowlisted' });
  });

  it('rejects when any top-level token field is outside the allowlist', () => {
    const manifest = baseManifest({
      action: {
        connectorAction: 'swap',
        paramsTemplate: { inputMint: 'USDC', outputMint: 'BONK', amount: '50' },
      },
    });
    expect(evaluateCaps(baseInput({ manifest })))
      .toEqual({ allowed: false, reason: 'token-not-allowlisted' });
    expect(evaluateCaps(baseInput({
      manifest,
      install: baseInstall({
        caps: { perRunMaxAmount: '50', lifetimeMaxAmount: '5000', allowlistedTokens: ['USDC', 'BONK'] },
      }),
    }))).toEqual({ allowed: true });
  });

  it('rejects nested token fields outside the allowlist', () => {
    const manifest = baseManifest({
      action: {
        connectorAction: 'swap',
        paramsTemplate: {
          route: {
            legs: [{ inputMint: 'USDC', outputMint: 'BONK' }],
          },
          amount: '50',
        },
      },
    });
    expect(evaluateCaps(baseInput({ manifest })))
      .toEqual({ allowed: false, reason: 'token-not-allowlisted' });
  });

  it('rejects when recipient allowlist is set but template recipient is missing or unallowed', () => {
    const install = baseInstall({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
        allowlistedRecipients: ['Recipient111111111111111111111111111111111'],
      },
    });
    const transferManifest = baseManifest({
      action: {
        connectorAction: 'transfer_spl',
        paramsTemplate: { token: 'USDC', recipient: 'OtherRecipient2222222222222222222222222222', amount: '50' },
      },
    });
    expect(evaluateCaps(baseInput({ install, manifest: transferManifest })))
      .toEqual({ allowed: false, reason: 'recipient-not-allowlisted' });

    const allowedManifest = baseManifest({
      action: {
        connectorAction: 'transfer_spl',
        paramsTemplate: { token: 'USDC', recipient: 'Recipient111111111111111111111111111111111', amount: '50' },
      },
    });
    expect(evaluateCaps(baseInput({ install, manifest: allowedManifest })))
      .toEqual({ allowed: true });
  });

  it('skips recipient check when allowlist is undefined or empty', () => {
    const transferManifest = baseManifest({
      action: {
        connectorAction: 'transfer_spl',
        paramsTemplate: { token: 'USDC', recipient: 'AnyRecipient111111111111111111111111111111', amount: '50' },
      },
    });
    expect(evaluateCaps(baseInput({ manifest: transferManifest })))
      .toEqual({ allowed: true });
  });

  it('treats placeholder recipients ({{ }}) as allowlist-bypass (resolved later)', () => {
    const install = baseInstall({
      caps: {
        perRunMaxAmount: '50',
        lifetimeMaxAmount: '5000',
        allowlistedTokens: ['USDC'],
        allowlistedRecipients: ['Recipient111111111111111111111111111111111'],
      },
    });
    const placeholderManifest = baseManifest({
      action: {
        connectorAction: 'transfer_spl',
        paramsTemplate: { token: 'USDC', recipient: '{{walletAddress}}', amount: '50' },
      },
    });
    expect(evaluateCaps(baseInput({ install, manifest: placeholderManifest })))
      .toEqual({ allowed: true });
  });
});

describe('template extractors and allowlists', () => {
  it('extractTemplateAmount priority order', () => {
    expect(extractTemplateAmount({ amount: '10', amountSol: '99' })).toBe('10');
    expect(extractTemplateAmount({ amountSol: '99' })).toBe('99');
    expect(extractTemplateAmount({ inputAmount: '5' })).toBe('5');
    expect(extractTemplateAmount({ sourceAmount: '7' })).toBe('7');
    expect(extractTemplateAmount(undefined)).toBeUndefined();
  });

  it('extractTemplateToken priority order', () => {
    expect(extractTemplateToken({ token: 'USDC' })).toBe('USDC');
    expect(extractTemplateToken({ inputToken: 'SOL' })).toBe('SOL');
    expect(extractTemplateToken({ outputToken: 'JUP' })).toBe('JUP');
    expect(extractTemplateToken({ inputMint: 'InputMint' })).toBe('InputMint');
    expect(extractTemplateToken({ sourceMint: 'SourceMint' })).toBe('SourceMint');
    expect(extractTemplateToken({ mint: 'XYZ' })).toBe('XYZ');
    expect(extractTemplateToken({ nested: { token: 'NESTED' } })).toBe('NESTED');
  });

  it('extractTemplateRecipient prioritises recipient over destination aliases', () => {
    expect(extractTemplateRecipient({ recipient: 'AAA', to: 'BBB' })).toBe('AAA');
    expect(extractTemplateRecipient({ to: 'BBB' })).toBe('BBB');
    expect(extractTemplateRecipient({ destinationAddress: 'CCC' })).toBe('CCC');
    expect(extractTemplateRecipient({ destinationRecipient: 'DDD' })).toBe('DDD');
  });

  it('isTokenAllowed is case-insensitive and rejects empty allowlist', () => {
    expect(isTokenAllowed('USDC', ['usdc'])).toBe(true);
    expect(isTokenAllowed('usdc', ['USDC'])).toBe(true);
    expect(isTokenAllowed('BONK', ['USDC'])).toBe(false);
    expect(isTokenAllowed(undefined, ['USDC'])).toBe(false);
    expect(isTokenAllowed('USDC', [])).toBe(false);
  });

  it('isRecipientAllowed permits anyone when allowlist is absent', () => {
    expect(isRecipientAllowed('AAA', undefined)).toBe(true);
    expect(isRecipientAllowed('AAA', [])).toBe(true);
  });

  it('isRecipientAllowed permits placeholders to pass through pre-bind', () => {
    expect(isRecipientAllowed('{{walletAddress}}', ['AAA'])).toBe(true);
  });
});

describe('decimal helpers', () => {
  it('compareDecimalStrings handles fractional widths', () => {
    expect(compareDecimalStrings('10000', '200')).toBe(1);
    expect(compareDecimalStrings('0.001', '0.01')).toBe(-1);
    expect(compareDecimalStrings('1.5', '1.50')).toBe(0);
  });

  it('addDecimalStrings preserves precision', () => {
    expect(addDecimalStrings('1.5', '2.25')).toBe('3.75');
    expect(addDecimalStrings('100', '200')).toBe('300');
    expect(addDecimalStrings('0.001', '0.002')).toBe('0.003');
    expect(addDecimalStrings('999999999999999999', '1')).toBe('1000000000000000000');
  });
});
