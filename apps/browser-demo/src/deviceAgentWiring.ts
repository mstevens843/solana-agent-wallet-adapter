import type { DeviceAgentRuntimeKind } from './deviceAgentClient.js';

export interface DeviceAgentRuntimeSurface {
  isAndroidApp: boolean;
  androidBridgeAvailable: boolean;
  isTauriApp: boolean;
  tauriBridgeAvailable: boolean;
  browserDeviceAgentEnabled: boolean;
  browserNativeEligible: boolean;
  cloudSessionMatchesWallet: boolean;
}

export type DeviceAgentRequestRoute =
  | 'android-native'
  | 'tauri-native'
  | 'browser-native'
  | 'none';
export type AiModeSurfaceDefault = 'hosted' | 'session' | 'bridge' | 'device-agent';

export function canUseDeviceAgentBrowserNative(surface: Pick<
  DeviceAgentRuntimeSurface,
  'isAndroidApp' | 'isTauriApp' | 'browserDeviceAgentEnabled' | 'browserNativeEligible'
>): boolean {
  // Tauri webviews are still browser environments — if the user configured a
  // BYOK provider and tauri-native isn't picked (bridge unreachable), the
  // browser-native direct-fetch path is a valid fallback. Only Android is
  // excluded because there it must go through the MWA bridge.
  return Boolean(
    surface.browserDeviceAgentEnabled &&
      !surface.isAndroidApp &&
      surface.browserNativeEligible,
  );
}

export function canUseDeviceAgentTauriNative(surface: Pick<
  DeviceAgentRuntimeSurface,
  'isTauriApp' | 'tauriBridgeAvailable'
>): boolean {
  return Boolean(surface.isTauriApp && surface.tauriBridgeAvailable);
}

export function chooseDeviceAgentRequestRoute(surface: DeviceAgentRuntimeSurface): DeviceAgentRequestRoute {
  if (surface.isAndroidApp && surface.androidBridgeAvailable) return 'android-native';
  if (canUseDeviceAgentTauriNative(surface)) return 'tauri-native';
  if (canUseDeviceAgentBrowserNative(surface)) return 'browser-native';
  return 'none';
}

export function defaultDeviceAgentRuntimeForSurface(surface: Pick<
  DeviceAgentRuntimeSurface,
  'isAndroidApp' | 'isTauriApp' | 'tauriBridgeAvailable' | 'browserDeviceAgentEnabled' | 'browserNativeEligible' | 'cloudSessionMatchesWallet'
>): DeviceAgentRuntimeKind {
  if (surface.isAndroidApp) return 'android-native';
  if (canUseDeviceAgentTauriNative(surface)) return 'tauri-native';
  if (canUseDeviceAgentBrowserNative(surface)) return 'browser-native';
  if (surface.cloudSessionMatchesWallet) return 'render-gated';
  return 'browser-dev';
}

export interface DeviceAgentVisibilitySurface {
  deviceAgentEnabled: boolean;
  androidDeviceAgentEnabled: boolean;
  browserDeviceAgentEnabled: boolean;
  showDevControls: boolean;
  isAndroidApp: boolean;
  androidDeviceAgentRuntimeEnabled: boolean;
  walletIsDeviceAgentAllowlisted: boolean;
  browserNativeEligible: boolean;
}

export function deviceAgentModeVisibleForSurface(surface: DeviceAgentVisibilitySurface): boolean {
  const legacyDeviceAgentEnabled = surface.deviceAgentEnabled || surface.androidDeviceAgentEnabled;
  if (!legacyDeviceAgentEnabled && !surface.browserNativeEligible) {
    return false;
  }
  if (surface.showDevControls) return true;
  if (surface.isAndroidApp && surface.androidDeviceAgentRuntimeEnabled) return true;
  if (surface.browserNativeEligible) return true;
  return legacyDeviceAgentEnabled && surface.walletIsDeviceAgentAllowlisted;
}

export function defaultAiModeForSurface(surface: {
  isAndroidApp: boolean;
  androidDeviceAgentRuntimeEnabled: boolean;
  isLocalBrowserOrigin: boolean;
  isTauriApp?: boolean;
  hasCloudSession?: boolean;
}): AiModeSurfaceDefault {
  if (surface.isAndroidApp) {
    return surface.androidDeviceAgentRuntimeEnabled ? 'device-agent' : 'session';
  }
  if (surface.isTauriApp) {
    return surface.hasCloudSession ? 'hosted' : 'device-agent';
  }
  return surface.isLocalBrowserOrigin ? 'bridge' : 'hosted';
}

export interface BrowserNativeProviderTier {
  className: string;
  label: string;
  title: string;
}

export function browserNativeProviderTierForProvider(provider: string): BrowserNativeProviderTier {
  switch (provider) {
    case 'openrouter':
    case 'gemini':
      return {
        className: 'ai-provider-tier-recommended',
        label: 'Recommended browser tier',
        title: 'Designed for direct browser use or known to support browser CORS for this route.',
      };
    case 'openai':
    case 'anthropic':
      return {
        className: 'ai-provider-tier-dangerous-direct',
        label: 'Direct-browser caution',
        title: 'This provider works from the tab only through vendor-flagged direct browser access.',
      };
    default:
      return {
        className: 'ai-provider-tier-neutral',
        label: 'CORS depends on gateway',
        title: 'Your custom OpenAI-compatible gateway must allow browser CORS.',
      };
  }
}
