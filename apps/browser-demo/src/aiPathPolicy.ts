export type AiPathMode = 'hosted' | 'session' | 'bridge' | 'device-agent';

export const MOBILE_HOSTED_BYOK_CLOUD_STORAGE_REQUIRED =
  'Please connect Cloud Storage to use this Path';

export interface MobileAiPathSurface {
  isAndroidApp: boolean;
  isAndroid: boolean;
  androidNativeBridgeAvailable: boolean;
  isIos: boolean;
  isIosNative: boolean;
  supportsMwaMobileWeb: boolean;
  supportsIosWalletStandardFallback: boolean;
}

export function shouldUseMobileAiPathPolicy(surface: MobileAiPathSurface): boolean {
  return Boolean(
    surface.isAndroidApp ||
      surface.isAndroid ||
      surface.androidNativeBridgeAvailable ||
      surface.isIos ||
      surface.isIosNative ||
      surface.supportsMwaMobileWeb ||
      surface.supportsIosWalletStandardFallback,
  );
}

export function mobileAiPathTabLabel(mode: AiPathMode): string {
  switch (mode) {
    case 'device-agent':
      return 'Device Agent AI';
    case 'hosted':
      return 'Hosted BYOK';
    case 'bridge':
      return 'Local Bridge AI';
    case 'session':
      return 'Session AI';
  }
}

export function visibleMobileAiPathModes(input: {
  mobileAiPathPolicy: boolean;
  deviceAgentVisible: boolean;
}): AiPathMode[] {
  if (!input.mobileAiPathPolicy) return ['hosted', 'bridge', 'session', 'device-agent'];
  return ['device-agent', 'hosted'];
}

export function mobileAiModeDisabledReason(input: {
  mobileAiPathPolicy: boolean;
  mode: AiPathMode;
  cloudSessionMatchesWallet: boolean;
}): string {
  if (!input.mobileAiPathPolicy) return '';
  if (input.mode === 'hosted' && !input.cloudSessionMatchesWallet) {
    return MOBILE_HOSTED_BYOK_CLOUD_STORAGE_REQUIRED;
  }
  if (input.mode === 'bridge' || input.mode === 'session') {
    return 'This AI path is not available in the Android app or mobile web.';
  }
  return '';
}

export function normalizeAiModeForMobileSurface(input: {
  mode: AiPathMode;
  mobileAiPathPolicy: boolean;
  deviceAgentVisible: boolean;
  fallbackMode: AiPathMode;
}): AiPathMode {
  if (input.mode === 'device-agent' && !input.deviceAgentVisible) {
    return input.mobileAiPathPolicy ? 'hosted' : input.fallbackMode;
  }
  if (input.mobileAiPathPolicy && (input.mode === 'bridge' || input.mode === 'session')) {
    return input.deviceAgentVisible ? 'device-agent' : 'hosted';
  }
  return input.mode;
}
