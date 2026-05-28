import { describe, expect, it } from 'vitest';

import {
  formatLedgerSolBalance,
  ledgerAccountPaths,
  ledgerDerivationPath,
  mergeLedgerAccountCandidates,
  mergeLedgerDerivedAccounts,
  rankLedgerAccounts,
  toLedgerAccountCandidate,
  type LedgerDerivedAccount,
} from '../ledgerAccounts.js';

function derived(input: Partial<LedgerDerivedAccount> = {}): LedgerDerivedAccount {
  return {
    derivationPath: `m/44'/501'/0'/0'`,
    family: 'default',
    index: 0,
    order: 0,
    address: 'Addr0',
    publicKeyB64: 'AAAA',
    ...input,
  };
}

describe('ledgerDerivationPath', () => {
  it('builds default and legacy Solana Ledger paths', () => {
    expect(ledgerDerivationPath('default', 3)).toBe(`m/44'/501'/3'/0'`);
    expect(ledgerDerivationPath('legacy', 3)).toBe(`m/44'/501'/3'`);
  });

  it('rejects invalid indexes', () => {
    expect(() => ledgerDerivationPath('default', -1)).toThrow(/non-negative/);
    expect(() => ledgerDerivationPath('default', 1.5)).toThrow(/non-negative/);
  });
});

describe('ledgerAccountPaths', () => {
  it('generates default paths before legacy paths with stable global order', () => {
    const paths = ledgerAccountPaths({
      defaultStart: 40,
      defaultCount: 2,
      legacyStart: 40,
      legacyCount: 2,
    });
    expect(paths.map((path) => path.derivationPath)).toEqual([
      `m/44'/501'/40'/0'`,
      `m/44'/501'/41'/0'`,
      `m/44'/501'/40'`,
      `m/44'/501'/41'`,
    ]);
    expect(paths.map((path) => path.order)).toEqual([40, 41, 10040, 10041]);
  });
});

describe('mergeLedgerDerivedAccounts', () => {
  it('attaches path metadata returned by IPC path', () => {
    const paths = ledgerAccountPaths({
      defaultStart: 0,
      defaultCount: 1,
      legacyStart: 0,
      legacyCount: 0,
    });
    const merged = mergeLedgerDerivedAccounts(paths, [{
      derivationPath: `m/44'/501'/0'/0'`,
      address: 'Addr0',
      publicKeyB64: 'AAAA',
    }]);
    expect(merged[0]).toMatchObject({
      family: 'default',
      index: 0,
      address: 'Addr0',
    });
  });
});

describe('formatLedgerSolBalance', () => {
  it('formats zero, small, and unavailable balances', () => {
    expect(formatLedgerSolBalance(0)).toBe('0.00 SOL');
    expect(formatLedgerSolBalance(5_077_400)).toBe('0.0050774 SOL');
    expect(formatLedgerSolBalance(null)).toBe('Balance unavailable');
  });
});

describe('rankLedgerAccounts', () => {
  it('prioritizes last selected, nonzero SOL, activity, then path order', () => {
    const accounts = [
      toLedgerAccountCandidate(derived({ address: 'unused', order: 0 }), {
        solBalanceLamports: 0,
        hasActivity: false,
      }),
      toLedgerAccountCandidate(derived({ address: 'active', order: 1 }), {
        solBalanceLamports: 0,
        hasActivity: true,
      }),
      toLedgerAccountCandidate(derived({ address: 'funded', order: 2 }), {
        solBalanceLamports: 10,
        hasActivity: false,
      }),
      toLedgerAccountCandidate(derived({ address: 'last', order: 3 }), {
        solBalanceLamports: 0,
        hasActivity: false,
      }),
    ];
    const ranked = rankLedgerAccounts(accounts, { lastSelectedAddress: 'last' });
    expect(ranked.map((account) => account.address)).toEqual(['last', 'funded', 'active', 'unused']);
    expect(ranked[0]!.lastSelected).toBe(true);
    expect(ranked[0]!.recentRank).toBe(0);
  });

  it('keeps the two most recent addresses ahead of funded accounts', () => {
    const accounts = [
      toLedgerAccountCandidate(derived({ address: 'funded', order: 0 }), {
        solBalanceLamports: 10,
        hasActivity: false,
      }),
      toLedgerAccountCandidate(derived({ address: 'previous', order: 1 }), {
        solBalanceLamports: 0,
        hasActivity: false,
      }),
      toLedgerAccountCandidate(derived({ address: 'last', order: 2 }), {
        solBalanceLamports: 0,
        hasActivity: false,
      }),
    ];
    const ranked = rankLedgerAccounts(accounts, { recentAddresses: ['last', 'previous'] });
    expect(ranked.map((account) => account.address)).toEqual(['last', 'previous', 'funded']);
    expect(ranked.map((account) => account.recentRank)).toEqual([0, 1, null]);
    expect(ranked[0]!.lastSelected).toBe(true);
    expect(ranked[1]!.lastSelected).toBe(false);
  });
});

describe('mergeLedgerAccountCandidates', () => {
  it('replaces duplicate derivation paths while preserving unique rows', () => {
    const existing = [
      toLedgerAccountCandidate(derived({ derivationPath: 'a', address: 'old' })),
    ];
    const incoming = [
      toLedgerAccountCandidate(derived({ derivationPath: 'a', address: 'new' })),
      toLedgerAccountCandidate(derived({ derivationPath: 'b', address: 'b' })),
    ];
    expect(mergeLedgerAccountCandidates(existing, incoming).map((entry) => entry.address)).toEqual(['new', 'b']);
  });
});
