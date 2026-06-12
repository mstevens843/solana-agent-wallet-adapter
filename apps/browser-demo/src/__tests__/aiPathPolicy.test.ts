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
import { defaultAiModeForSurface } from '../deviceAgentWiring.js';

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

  it('shows Device Agent, Hosted BYOK, and Session AI on mobile when Device Agent is available', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
    })).toEqual(['device-agent', 'hosted', 'session']);
  });

  it('labels the mobile AI path tabs with full names', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
    }).map(mobileAiPathTabLabel)).toEqual(['Device Agent AI', 'Hosted BYOK', 'Session AI']);
  });

  it('keeps Device Agent, Hosted BYOK, and Session AI visible on mobile when Device Agent is unavailable', () => {
    expect(visibleMobileAiPathModes({
      mobileAiPathPolicy: true,
      deviceAgentVisible: false,
    })).toEqual(['device-agent', 'hosted', 'session']);
  });

  it('does not disable Session AI on mobile (key-only, no cloud sign-in)', () => {
    expect(mobileAiModeDisabledReason({
      mobileAiPathPolicy: true,
      mode: 'session',
      cloudSessionMatchesWallet: false,
    })).toBe('');
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

  it('normalizes the hidden mobile bridge mode to the best visible path', () => {
    expect(normalizeAiModeForMobileSurface({
      mode: 'bridge',
      mobileAiPathPolicy: true,
      deviceAgentVisible: true,
      fallbackMode: 'bridge',
    })).toBe('device-agent');
  });

  it('keeps Session AI as-is on mobile (now a visible key-only path)', () => {
    expect(normalizeAiModeForMobileSurface({
      mode: 'session',
      mobileAiPathPolicy: true,
      deviceAgentVisible: false,
      fallbackMode: 'session',
    })).toBe('session');
  });
});

describe('desktop AI path policy', () => {
  it('defaults the desktop app to the local bridge (connector home) regardless of cloud session', () => {
    // Regression: a cloud STORAGE session used to force the desktop default to "hosted", which hid the
    // subscription-connector picker + Start/Retry-bridge button (both gated on bridge mode).
    const base = { isAndroidApp: false, androidDeviceAgentRuntimeEnabled: false, isLocalBrowserOrigin: false, isTauriApp: true };
    expect(defaultAiModeForSurface({ ...base, hasCloudSession: true })).toBe('bridge');
    expect(defaultAiModeForSurface({ ...base, hasCloudSession: false })).toBe('bridge');
  });

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
