import { describe, expect, it } from 'vitest';

import {
  androidWalletDisplayNameFromStatus,
  walletLogoIdForProviderName,
} from '../walletBranding.js';

describe('wallet branding helpers', () => {
  it('maps Solflare Android package names to the Solflare display name and logo', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletPackage: 'com.solflare.mobile',
        accountLabel: 'Trading wallet',
      }),
    ).toBe('Solflare');
    expect(walletLogoIdForProviderName('Solflare')).toBe('solflare');
    expect(walletLogoIdForProviderName('com.solflare.mobile')).toBe('solflare');
  });

  it('maps Seed Vault Android package names to Seed Vault before account labels', () => {
    expect(
      androidWalletDisplayNameFromStatus({
        walletPackage: 'com.solanamobile.seedvaultimpl',
        accountLabel: 'cofeelme.skr',
      }),
    ).toBe('Seed Vault');
    expect(walletLogoIdForProviderName('Seed Vault')).toBe('seedVault');
    expect(walletLogoIdForProviderName('com.solanamobile.seedvaultimpl')).toBe('seedVault');
    expect(walletLogoIdForProviderName('solanamobilewallet:/v1/authorize')).toBe('seedVault');
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
