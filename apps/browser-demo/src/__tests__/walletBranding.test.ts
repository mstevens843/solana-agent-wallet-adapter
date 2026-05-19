import { describe, expect, it } from 'vitest';

import {
  androidWalletDisplayNameFromStatus,
  walletLogoIdForProviderName,
} from '../walletBranding.js';

describe('wallet branding helpers', () => {
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
        walletIcon: 'https://solflare.com/favicon.ico',
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
