import { describe, expect, it } from 'vitest';

import {
  browserNativeProviderTierForProvider,
  chooseDeviceAgentRequestRoute,
  defaultAiModeForSurface,
  defaultDeviceAgentRuntimeForSurface,
  deviceAgentModeVisibleForSurface,
} from '../deviceAgentWiring.js';

describe('Phase 6 browser-native Device Agent wiring helpers', () => {
  it('keeps Android native ahead of browser-native when both are present', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: true,
      androidBridgeAvailable: true,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('android-native');
  });

  it('uses iOS native after Android and ahead of browser-native when the bridge is present', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isIosApp: true,
      iosBridgeAvailable: true,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('ios-native');
  });

  it('uses browser-native after Android and before the fallback paths', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('browser-native');
  });

  it('does not select a runtime request route when browser-native is not eligible', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: true,
    })).toBe('none');
  });

  it('selects tauri-native when running inside a Tauri shell with a reachable local bridge', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isTauriApp: true,
      tauriBridgeAvailable: true,
      browserDeviceAgentEnabled: false,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: false,
    })).toBe('tauri-native');
  });

  it('falls back to browser-native when Tauri bridge is unreachable but browser-native is eligible', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isTauriApp: true,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: false,
    })).toBe('browser-native');
  });

  it('returns none when Tauri bridge is unreachable and no browser-native fallback is eligible', () => {
    expect(chooseDeviceAgentRequestRoute({
      isAndroidApp: false,
      androidBridgeAvailable: false,
      isTauriApp: true,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: false,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: false,
    })).toBe('none');
  });

  it('chooses default runtime by surface precedence', () => {
    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: true,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('android-native');

    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: false,
      isIosApp: true,
      iosBridgeAvailable: true,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('ios-native');

    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: false,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: true,
      browserNativeEligible: true,
      cloudSessionMatchesWallet: true,
    })).toBe('browser-native');

    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: false,
      isTauriApp: true,
      tauriBridgeAvailable: true,
      browserDeviceAgentEnabled: false,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: true,
    })).toBe('tauri-native');

    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: false,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: false,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: true,
    })).toBe('render-gated');

    expect(defaultDeviceAgentRuntimeForSurface({
      isAndroidApp: false,
      isTauriApp: false,
      tauriBridgeAvailable: false,
      browserDeviceAgentEnabled: false,
      browserNativeEligible: false,
      cloudSessionMatchesWallet: false,
    })).toBe('browser-dev');
  });

  it('keeps Device Agent mode hidden when browser flag is on but the wallet is missing', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: true,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: true,
      showDevControls: false,
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      walletIsDeviceAgentAllowlisted: false,
      browserNativeEligible: false,
    })).toBe(false);
  });

  it('does not show Device Agent for browser flag alone without umbrella eligibility', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: false,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: true,
      showDevControls: false,
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      walletIsDeviceAgentAllowlisted: true,
      browserNativeEligible: false,
    })).toBe(false);
  });

  it('shows Device Agent mode for an eligible browser-native wallet', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: true,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: true,
      showDevControls: false,
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      walletIsDeviceAgentAllowlisted: true,
      browserNativeEligible: true,
    })).toBe(true);
  });

  it('shows Device Agent mode inside Android when the native runtime is enabled without requiring wallet allowlist membership', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: true,
      androidDeviceAgentEnabled: true,
      browserDeviceAgentEnabled: false,
      showDevControls: false,
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: true,
      walletIsDeviceAgentAllowlisted: false,
      browserNativeEligible: false,
    })).toBe(true);
  });

  it('shows Device Agent mode inside iOS when the native runtime is enabled without requiring wallet allowlist membership', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: true,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: false,
      showDevControls: false,
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isIosApp: true,
      iosDeviceAgentRuntimeEnabled: true,
      walletIsDeviceAgentAllowlisted: false,
      browserNativeEligible: false,
    })).toBe(true);
  });

  it('keeps Device Agent hidden inside Android when the native runtime is explicitly disabled', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: false,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: false,
      showDevControls: false,
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: false,
      walletIsDeviceAgentAllowlisted: true,
      browserNativeEligible: false,
    })).toBe(false);
  });

  it('shows Device Agent mode when dev controls expose the browser-native runtime', () => {
    expect(deviceAgentModeVisibleForSurface({
      deviceAgentEnabled: true,
      androidDeviceAgentEnabled: false,
      browserDeviceAgentEnabled: true,
      showDevControls: true,
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      walletIsDeviceAgentAllowlisted: false,
      browserNativeEligible: true,
    })).toBe(true);
  });

  it('defaults Android app AI mode to Device Agent when the native runtime is enabled', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: false,
    })).toBe('device-agent');
  });

  it('defaults Android app AI mode to Android Session when the native runtime is explicitly disabled', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
    })).toBe('session');
  });

  it('defaults iOS app AI mode to Device Agent when the native runtime is enabled', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isIosApp: true,
      iosDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: false,
    })).toBe('device-agent');
  });

  it('defaults iOS app AI mode to Session when the native runtime is disabled', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isIosApp: true,
      iosDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
    })).toBe('session');
  });

  it('keeps non-Android default AI mode behavior unchanged', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: true,
      deviceAgentVisible: false,
    })).toBe('bridge');
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: false,
      deviceAgentVisible: false,
    })).toBe('hosted');
  });

  it('defaults web AI mode to Device Agent when visible and the provider supports it', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
      deviceAgentVisible: true,
      providerSupportsDeviceAgent: true,
    })).toBe('device-agent');
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: true,
      deviceAgentVisible: true,
      providerSupportsDeviceAgent: true,
    })).toBe('device-agent');
  });

  it('falls back to the non-Device-Agent default when the provider does not support Device Agent', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
      deviceAgentVisible: true,
      providerSupportsDeviceAgent: false,
    })).toBe('hosted');
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: true,
      deviceAgentVisible: true,
      providerSupportsDeviceAgent: false,
    })).toBe('bridge');
    expect(defaultAiModeForSurface({
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: false,
      deviceAgentVisible: true,
      providerSupportsDeviceAgent: false,
    })).toBe('session');
  });

  it('defaults Tauri desktop AI mode to hosted when an Agentic Cloud session is present', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: true,
      isTauriApp: true,
      hasCloudSession: true,
    })).toBe('hosted');
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
      isTauriApp: true,
      hasCloudSession: true,
    })).toBe('hosted');
  });

  it('defaults Tauri desktop AI mode to device-agent when no Agentic Cloud session exists', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: true,
      isTauriApp: true,
      hasCloudSession: false,
    })).toBe('device-agent');
    expect(defaultAiModeForSurface({
      isAndroidApp: false,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
      isTauriApp: true,
    })).toBe('device-agent');
  });

  it('keeps Android AI mode ahead of Tauri when both surface flags are set', () => {
    expect(defaultAiModeForSurface({
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: true,
      isLocalBrowserOrigin: false,
      isTauriApp: true,
      hasCloudSession: true,
    })).toBe('device-agent');
    expect(defaultAiModeForSurface({
      isAndroidApp: true,
      androidDeviceAgentRuntimeEnabled: false,
      isLocalBrowserOrigin: false,
      isTauriApp: true,
      hasCloudSession: true,
    })).toBe('session');
  });

  it('labels browser-native providers by direct-browser support tier', () => {
    expect(browserNativeProviderTierForProvider('openrouter')).toMatchObject({
      className: 'ai-provider-tier-recommended',
      label: 'Recommended browser tier',
    });
    expect(browserNativeProviderTierForProvider('gemini')).toMatchObject({
      className: 'ai-provider-tier-recommended',
      label: 'Recommended browser tier',
    });
    expect(browserNativeProviderTierForProvider('openai')).toMatchObject({
      className: 'ai-provider-tier-dangerous-direct',
      label: 'Direct-browser caution',
    });
    expect(browserNativeProviderTierForProvider('anthropic')).toMatchObject({
      className: 'ai-provider-tier-dangerous-direct',
      label: 'Direct-browser caution',
    });
    expect(browserNativeProviderTierForProvider('custom-openai-compatible')).toMatchObject({
      className: 'ai-provider-tier-neutral',
      label: 'CORS depends on gateway',
    });
  });
});
