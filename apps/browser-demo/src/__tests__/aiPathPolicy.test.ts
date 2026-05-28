import { describe, expect, it } from 'vitest';

import {
  DESKTOP_BROWSER_SESSION_DISABLED_REASON,
  MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED,
  desktopAiModeDisabledReason,
  mobileAiModeDisabledReason,
  mobileAiPathTabLabel,
  normalizeAiModeForDesktopSurface,
  normalizeAiModeForMobileSurface,
  shouldUseDesktopAiPathPolicy,
  shouldUseMobileAiPathPolicy,
  visibleDesktopAiPathModes,
  visibleMobileAiPathModes,
} from '../aiPathPolicy.js';

describe('mobile AI path policy', () => {
  it('applies to Android app and mobile wallet browser surfaces', () => {
    expect(shouldUseMobileAiPathPolicy({
      isAndroidApp: true,
      isAndroid: false,
      androidNativeBridgeAvailable: false,
      isIos: false,
      isIosNative: false,
      supportsMwaMobileWeb: false,
      supportsIosWalletStandardFallback: false,
    })).toBe(true);

    expect(shouldUseMobileAiPathPolicy({
      isAndroidApp: false,
      isAndroid: false,
      androidNativeBridgeAvailable: false,
      isIos: false,
      isIosNative: false,
      supportsMwaMobileWeb: true,
      supportsIosWalletStandardFallback: false,
    })).toBe(true);
  });

  it('applies to Android and iOS mobile browser user agents', () => {
    expect(shouldUseMobileAiPathPolicy({
      isAndroidApp: false,
      isAndroid: true,
      androidNativeBridgeAvailable: false,
      isIos: false,
      isIosNative: false,
      supportsMwaMobileWeb: false,
      supportsIosWalletStandardFallback: false,
    })).toBe(true);

    expect(shouldUseMobileAiPathPolicy({
      isAndroidApp: false,
      isAndroid: false,
      androidNativeBridgeAvailable: false,
      isIos: true,
      isIosNative: false,
      supportsMwaMobileWeb: false,
      supportsIosWalletStandardFallback: false,
    })).toBe(true);
  });

  it('does not apply to desktop web by itself', () => {
    expect(shouldUseMobileAiPathPolicy({
      isAndroidApp: false,
      isAndroid: false,
      androidNativeBridgeAvailable: false,
      isIos: false,
      isIosNative: false,
      supportsMwaMobileWeb: false,
      supportsIosWalletStandardFallback: false,
    })).toBe(false);
  });

  it('keeps the full path set outside the mobile policy', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: false,
      deviceAgentVisible: true,
    })).toEqual(['hosted', 'bridge', 'session', 'device-agent']);
  });

  it('shows only Device Agent and Hosted BYOK on mobile when Device Agent is available', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
    })).toEqual(['device-agent', 'hosted']);
  });

  it('labels the two mobile AI path tabs with full names', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
    }).map(mobileAiPathTabLabel)).toEqual(['Device Agent AI', 'Hosted BYOK']);
  });

  it('keeps Device Agent and Hosted BYOK as the only visible mobile paths when Device Agent is unavailable', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: false,
    })).toEqual(['device-agent', 'hosted']);
  });

  it('disables Hosted BYOK on mobile until Cloud sign-in matches the wallet', () => {
    expect(mobileAiModeDisabledReason({
      mobileAiPathPolicy: true,
      mode: 'hosted',
      cloudSessionMatchesWallet: false,
    })).toBe(MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED);

    expect(mobileAiModeDisabledReason({
      mobileAiPathPolicy: true,
      mode: 'hosted',
      cloudSessionMatchesWallet: true,
    })).toBe('');
  });

  it('normalizes hidden mobile bridge and session modes to the best visible path', () => {
    expect(normalizeAiModeForMobileSurface({
      mode: 'bridge',
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
      fallbackMode: 'bridge',
    })).toBe('device-agent');

    expect(normalizeAiModeForMobileSurface({
      mode: 'session',
      mobileAiPathPolicy: true,
      deviceAgentVisible: false,
      fallbackMode: 'session',
    })).toBe('hosted');
  });
});

describe('desktop AI path policy', () => {
  it('applies to the Tauri desktop app', () => {
    expect(shouldUseDesktopAiPathPolicy({ isTauriApp: true })).toBe(true);
    expect(shouldUseDesktopAiPathPolicy({ isTauriApp: false })).toBe(false);
  });

  it('keeps the full path set outside the desktop policy', () => {
    expect(visibleDesktopAiPathModes({
      desktopAiPathPolicy: false,
      deviceAgentVisible: true,
    })).toEqual(['hosted', 'bridge', 'session', 'device-agent']);
  });

  it('hides Browser Session on the desktop and puts Local Bridge first', () => {
    expect(visibleDesktopAiPathModes({
      desktopAiPathPolicy: true,
      deviceAgentVisible: true,
    })).toEqual(['bridge', 'device-agent', 'hosted']);
  });

  it('disables Browser Session AI on the desktop with a clear reason', () => {
    expect(desktopAiModeDisabledReason({
      desktopAiPathPolicy: true,
      mode: 'session',
    })).toBe(DESKTOP_BROWSER_SESSION_DISABLED_REASON);

    expect(desktopAiModeDisabledReason({
      desktopAiPathPolicy: true,
      mode: 'bridge',
    })).toBe('');

    expect(desktopAiModeDisabledReason({
      desktopAiPathPolicy: false,
      mode: 'session',
    })).toBe('');
  });

  it('migrates a persisted session mode to the desktop fallback (Local Bridge)', () => {
    expect(normalizeAiModeForDesktopSurface({
      mode: 'session',
      desktopAiPathPolicy: true,
      fallbackMode: 'bridge',
    })).toBe('bridge');

    expect(normalizeAiModeForDesktopSurface({
      mode: 'hosted',
      desktopAiPathPolicy: true,
      fallbackMode: 'bridge',
    })).toBe('hosted');

    expect(normalizeAiModeForDesktopSurface({
      mode: 'session',
      desktopAiPathPolicy: false,
      fallbackMode: 'bridge',
    })).toBe('session');
  });
});
