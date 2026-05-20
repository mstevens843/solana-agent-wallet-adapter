import { describe, expect, it } from 'vitest';

import {
  MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED,
  mobileAiModeDisabledReason,
  mobileAiPathTabLabel,
  normalizeAiModeForMobileSurface,
  shouldUseMobileAiPathPolicy,
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

  it('disables Hosted BYOK on mobile until Agentic Cloud sign-in', () => {
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
