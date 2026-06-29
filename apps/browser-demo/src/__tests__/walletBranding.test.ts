import { describe, expect, it } from 'vitest';

import {
  androidWalletDisplayNameFromStatus,
  walletLogoIdFromAndroidStatus,
  walletLogoIdForProviderName,
} from '../walletBranding.js';

const SEED_VAULT_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADY...' +
  'QChlppOaiUo1Z22pIwKl0xN6leqUK+T8P/q4PWPnCdaVAAAAAElFTkSuQmCC';

const ESCAPED_SEED_VAULT_ICON =
  'data:image\\/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADY\\n...' +
  'QChlppOaiUo1Z22pIwKl0xN6leqUK+T8P\\/q4PWPnCdaVAAAAAElFTkSuQmCC';

describe('wallet branding helpers', () => {
  it('maps native wallet connected-toast providers to bundled wallet logos', () => {
    expect(walletLogoIdForProviderName('Phantom')).toBe('phantom');
    expect(walletLogoIdForProviderName('Solflare')).toBe('solflare');
    expect(walletLogoIdForProviderName('Backpack')).toBe('backpack');
    expect(walletLogoIdForProviderName('Jupiter')).toBe('jupiter');
    expect(walletLogoIdForProviderName('Seed Vault')).toBe('seedVault');

    expect(androidWalletDisplayNameFromStatus({ walletPackage: 'app.phantom' })).toBe('Phantom');
    expect(androidWalletDisplayNameFromStatus({ walletPackage: 'com.solflare.mobile' })).toBe('Solflare');
    expect(androidWalletDisplayNameFromStatus({ walletPackage: 'com.backpack.mobile' })).toBe('Backpack');
    expect(androidWalletDisplayNameFromStatus({ walletUriBase: 'https://jup.ag/wc' })).toBe('Jupiter');
    expect(androidWalletDisplayNameFromStatus({ walletType: 50 })).toBe('Seed Vault');
  });

  it('maps Solflare Android package names to the Solflare display name and logo', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletType: 25,
        walletPackage: 'com.solflare.mobile',
        accountLabel: 'Trading wallet',
      }),
    ).toBe('Solflare');
    expect(walletLogoIdForProviderName('Solflare')).toBe('solflare');
    expect(walletLogoIdForProviderName('com.solflare.mobile')).toBe('solflare');
  });

  it('maps desktop browser-session provider labels to bundled wallet logos', () => {
    expect(walletLogoIdForProviderName('Backpack (browser)')).toBe('backpack');
    expect(walletLogoIdForProviderName('Phantom (browser)')).toBe('phantom');
    expect(walletLogoIdForProviderName('Jupiter (browser)')).toBe('jupiter');
    expect(walletLogoIdForProviderName('Solflare (browser)')).toBe('solflare');
  });

  it('maps Solflare Android wallet metadata when package names are missing', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletType: 25,
        accountLabel: 'CT89vd7XfM',
      }),
    ).toBe('Solflare');
    expect(
      androidWalletDisplayNameFromStatus({
        walletUriBase: 'https://solflare.com/ul/v1',
        accountLabel: 'CT89vd7XfM',
      }),
    ).toBe('Solflare');
    expect(
      androidWalletDisplayNameFromStatus({
        walletIcon: 'https:\\/\\/solflare.com\\/favicon.ico',
        accountLabel: 'CT89vd7XfM',
      }),
    ).toBe('Solflare');
  });

  it('maps Seed Vault Android package names to Seed Vault before account labels', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletType: 50,
        walletPackage: 'com.solanamobile.seedvaultimpl',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(walletLogoIdForProviderName('Seed Vault')).toBe('seedVault');
    expect(walletLogoIdForProviderName('com.solanamobile.seedvaultimpl')).toBe('seedVault');
    expect(walletLogoIdForProviderName('solanamobilewallet:/v1/authorize')).toBe('seedVault');
  });

  it('maps Seed Vault Android wallet metadata when package names are missing', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletType: 50,
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(
      androidWalletDisplayNameFromStatus({
        walletUriBase: 'solanamobilewallet:/v1/authorize',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(
      androidWalletDisplayNameFromStatus({
        walletIcon: 'https://intercom.help/seedvaultwallet/assets/favicon',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(
      androidWalletDisplayNameFromStatus({
        walletIcon: SEED_VAULT_ICON,
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(
      walletLogoIdFromAndroidStatus({
        walletIcon: SEED_VAULT_ICON,
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('seedVault');
    expect(
      walletLogoIdFromAndroidStatus({
        walletType: 0,
        walletPackage: '',
        walletUriBase: '',
        walletIcon: ESCAPED_SEED_VAULT_ICON,
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('seedVault');
    expect(
      walletLogoIdFromAndroidStatus({
        walletIcon:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADYnot-a-known-wallet-tail',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBeUndefined();
  });

  it('falls back to account labels for unknown Android wallet packages', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletPackage: 'com.example.wallet',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('cofeelme.skr');
    expect(walletLogoIdForProviderName('cofeelme.skr')).toBeUndefined();
  });
});
