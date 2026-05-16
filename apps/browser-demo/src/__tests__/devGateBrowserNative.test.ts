// Phase 5/6 — eligibility matrix for browser-native Device Agent runtime.
//
// Note on flag-positive cases: `VITE_AGENTIC_DEVICE_AGENT` is replaced at Vite
// build-time via `define` in apps/browser-demo/vite.config.ts. That means even
// `vi.stubEnv` + `vi.resetModules` cannot flip the value at runtime — by
// production design, the flag is locked at bundle time. The legacy wrapper
// tests below cover every observable branch reachable with flags=off (the test
// bundle default); the pure surface helper covers the flag-positive matrix.

import { describe, expect, it } from 'vitest';

import {
  browserNativeRuntimeEligibleForSurface,
  DEVICE_AGENT_WALLET_ALLOWLIST,
  isBrowserNativeRuntimeEligible,
} from '../devGate.js';

const ALLOWLISTED_WALLET = DEVICE_AGENT_WALLET_ALLOWLIST[0] ?? '';
const NON_ALLOWLISTED_WALLET = 'WalletAddressDeliberatelyOutsideAllowlist';

describe('isBrowserNativeRuntimeEligible', () => {
  it('is a function exported from devGate', () => {
    expect(typeof isBrowserNativeRuntimeEligible).toBe('function');
  });

  it('returns false when isAndroidApp is true even with an allowlisted wallet', () => {
    expect(isBrowserNativeRuntimeEligible(ALLOWLISTED_WALLET, true)).toBe(false);
  });

  it('returns false when wallet is undefined', () => {
    expect(isBrowserNativeRuntimeEligible(undefined, false)).toBe(false);
  });

  it('returns false when wallet is null', () => {
    expect(isBrowserNativeRuntimeEligible(null, false)).toBe(false);
  });

  it('returns false when wallet is an empty string', () => {
    expect(isBrowserNativeRuntimeEligible('', false)).toBe(false);
  });

  it('returns false when wallet is not in the allowlist', () => {
    expect(isBrowserNativeRuntimeEligible(NON_ALLOWLISTED_WALLET, false)).toBe(false);
  });

  it('returns false when build flags are off even with an allowlisted wallet (test env default)', () => {
    // This is the production contract: with VITE_AGENTIC_DEVICE_AGENT and/or
    // VITE_AGENTIC_BROWSER_DEVICE_AGENT off, eligibility is never granted —
    // regardless of wallet membership. The default test bundle has both off.
    expect(isBrowserNativeRuntimeEligible(ALLOWLISTED_WALLET, false)).toBe(false);
  });
});

describe('browserNativeRuntimeEligibleForSurface', () => {
  it('allows an allowlisted browser wallet when both runtime flags are on', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
      deviceAgentWalletAllowlisted: true,
    })).toBe(true);
  });

  it('requires the umbrella Device Agent flag', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: false,
      browserDeviceAgentEnabled: true,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
      deviceAgentWalletAllowlisted: true,
    })).toBe(false);
  });

  it('requires the browser-native runtime flag', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: false,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
      deviceAgentWalletAllowlisted: true,
    })).toBe(false);
  });

  it('does not allow browser-native runtime inside the Android app', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: true,
      showDevControls: false,
      deviceAgentWalletAllowlisted: true,
    })).toBe(false);
  });

  it('allows dev controls to expose the browser runtime even without allowlist membership', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: NON_ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: true,
      deviceAgentWalletAllowlisted: false,
    })).toBe(true);
  });

  it('keeps browser-native runtime unavailable without allowlist membership or dev controls', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: NON_ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
      deviceAgentWalletAllowlisted: false,
    })).toBe(false);
  });

  it('keeps browser-native runtime unavailable when no wallet is present outside dev controls', () => {
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: undefined,
      isAndroidApp: false,
      showDevControls: false,
    })).toBe(false);
  });

  it('keeps Android precedence even when showDevControls is true and wallet is allowlisted', () => {
    // Android bridge always wins — showDevControls cannot promote a browser-native
    // routing decision inside the Android TWA.
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: true,
      showDevControls: true,
      deviceAgentWalletAllowlisted: true,
    })).toBe(false);
  });

  it('falls through to isDeviceAgentWallet when deviceAgentWalletAllowlisted is omitted', () => {
    // Without an explicit deviceAgentWalletAllowlisted flag, the helper queries
    // the production wallet allowlist via isDeviceAgentWallet(walletAddress).
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
    })).toBe(true);
    expect(browserNativeRuntimeEligibleForSurface({
      deviceAgentEnabled: true,
      browserDeviceAgentEnabled: true,
      walletAddress: NON_ALLOWLISTED_WALLET,
      isAndroidApp: false,
      showDevControls: false,
    })).toBe(false);
  });
});
