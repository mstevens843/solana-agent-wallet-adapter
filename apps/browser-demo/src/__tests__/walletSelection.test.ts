import { describe, expect, it } from 'vitest';

import {
  BROWSER_WALLET_PLACEHOLDER_LABEL,
  browserWalletPickerOptions,
  browserWalletRestoreName,
  createBrowserWalletSession,
  hasDiscoveredBrowserWalletSelection,
  isPersistedBrowserWalletSession,
  reconcileBrowserWalletSelection,
  visibleBrowserWallets,
} from '../walletSelection.js';

const discoveredWallets = [{ name: 'Backpack' }, { name: 'Phantom' }, { name: 'Solflare' }];
const mixedDiscoveredWallets = [
  { name: 'Backpack' },
  { name: 'MetaMask' },
  { name: 'Phantom' },
  { name: 'Solflare' },
  { name: 'Leap Wallet' },
  { name: 'Magic Eden' },
  { name: 'MagicEden Wallet' },
];

describe('browser wallet selection helpers', () => {
  it('does not auto-select the first discovered wallet', () => {
    expect(reconcileBrowserWalletSelection(discoveredWallets, '')).toBe('');
    expect(hasDiscoveredBrowserWalletSelection(discoveredWallets, '')).toBe(false);
  });

  it('keeps an explicit selected wallet when it is still discovered', () => {
    expect(reconcileBrowserWalletSelection(discoveredWallets, 'Phantom')).toBe('Phantom');
    expect(hasDiscoveredBrowserWalletSelection(discoveredWallets, 'Phantom')).toBe(true);
  });

  it('clears a selected wallet that is no longer installed', () => {
    expect(reconcileBrowserWalletSelection(discoveredWallets, 'Glow')).toBe('');
    expect(hasDiscoveredBrowserWalletSelection(discoveredWallets, 'Glow')).toBe(false);
  });

  it('shows an explicit placeholder before discovered providers', () => {
    const options = browserWalletPickerOptions(discoveredWallets);

    expect(options[0]).toMatchObject({
      value: '',
      label: BROWSER_WALLET_PLACEHOLDER_LABEL,
      disabled: true,
    });
    expect(options.slice(1).map((option) => option.label)).toEqual(['Backpack', 'Phantom', 'Solflare']);
  });

  it('hides unsupported browser wallet providers', () => {
    expect(visibleBrowserWallets(mixedDiscoveredWallets).map((wallet) => wallet.name)).toEqual([
      'Backpack',
      'Phantom',
      'Solflare',
    ]);
  });

  it('uses only explicit connected wallet sessions for restore', () => {
    expect(browserWalletRestoreName(discoveredWallets, undefined, 'mainnet-beta')).toBe('');

    const session = createBrowserWalletSession('Phantom', 'mainnet-beta', '2026-05-09T00:00:00.000Z');
    expect(browserWalletRestoreName(discoveredWallets, session, 'mainnet-beta')).toBe('Phantom');
  });

  it('rejects legacy selected-only state as a browser restore session', () => {
    expect(isPersistedBrowserWalletSession({ selectedWalletName: 'Backpack' })).toBe(false);
  });

  it('does not restore a wallet remembered for another cluster', () => {
    const session = createBrowserWalletSession('Phantom', 'devnet', '2026-05-09T00:00:00.000Z');
    expect(browserWalletRestoreName(discoveredWallets, session, 'mainnet-beta')).toBe('');
  });
});
