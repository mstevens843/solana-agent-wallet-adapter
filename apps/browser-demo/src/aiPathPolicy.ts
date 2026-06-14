export type AiPathMode = 'hosted' | 'session' | 'bridge' | 'device-agent';

export const MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED =
  'Cloud sign-in required for Hosted BYOK relay. Your AI key is not stored.';

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
  isAndroidApp?: boolean;
}): AiPathMode[] {
  if (!input.mobileAiPathPolicy) return ['hosted', 'bridge', 'session', 'device-agent'];
  // Native/mobile app shells should expose only the supported product paths.
  // Session AI is a direct-from-WebView browser path and should not appear in
  // Android/iOS app setup. Local Bridge also stays hidden on mobile.
  return ['device-agent', 'hosted'];
}

// Hosted BYOK requires an Agentic Cloud session because the API key is relayed
// through the backend (agentic-signer.com) rather than called direct from the
// device. The cloud session is wallet-bound, so wallet disconnect closes the
// gate automatically — no separate key cleanup is needed for this path.
export function mobileAiModeDisabledReason(input: {
  mobileAiPathPolicy: boolean;
  mode: AiPathMode;
  cloudSessionMatchesWallet: boolean;
}): string {
  if (!input.mobileAiPathPolicy) return '';
  if (input.mode === 'bridge') {
    return 'This AI path is not available in the native mobile app or mobile web.';
  }
  return '';
}

export function normalizeAiModeForMobileSurface(input: {
  mode: AiPathMode;
  mobileAiPathPolicy: boolean;
  deviceAgentVisible: boolean;
  fallbackMode: AiPathMode;
  isAndroidApp?: boolean;
}): AiPathMode {
  // `bridge` and `session` are hidden on mobile app surfaces — coerce either to
  // the primary supported native path so a persisted older mode never leaves the
  // picker on an invisible/unsupported option.
  if (
    input.mobileAiPathPolicy &&
    (input.mode === 'bridge' || input.mode === 'session')
  ) {
    return 'device-agent';
  }
  if (input.mode === 'device-agent' && !input.deviceAgentVisible) {
    return input.mobileAiPathPolicy ? 'device-agent' : input.fallbackMode;
  }
  return input.mode;
}

export const DESKTOP_BROWSER_SESSION_DISABLED_REASON =
  'Browser Session AI is not available in the desktop app. Use Local Bridge or Hosted BYOK.';

export interface DesktopAiPathSurface {
  isTauriApp: boolean;
}

export function shouldUseDesktopAiPathPolicy(surface: DesktopAiPathSurface): boolean {
  return Boolean(surface.isTauriApp);
}

// Desktop runs the local bridge sidecar by default and uses Tauri's system
// webview, which enforces the same CORS rules as Chrome — so Browser Session
// AI is broken (OpenAI blocked, no web search) and strictly redundant with
// Local Bridge. Cut it from the desktop picker.
export function visibleDesktopAiPathModes(input: {
  desktopAiPathPolicy: boolean;
  deviceAgentVisible: boolean;
}): AiPathMode[] {
  if (!input.desktopAiPathPolicy) return ['hosted', 'bridge', 'session', 'device-agent'];
  return ['bridge', 'device-agent', 'hosted'];
}

export function desktopAiModeDisabledReason(input: {
  desktopAiPathPolicy: boolean;
  mode: AiPathMode;
}): string {
  if (!input.desktopAiPathPolicy) return '';
  if (input.mode === 'session') return DESKTOP_BROWSER_SESSION_DISABLED_REASON;
  return '';
}

export function normalizeAiModeForDesktopSurface(input: {
  mode: AiPathMode;
  desktopAiPathPolicy: boolean;
  fallbackMode: AiPathMode;
}): AiPathMode {
  if (input.desktopAiPathPolicy && input.mode === 'session') {
    return input.fallbackMode;
  }
  return input.mode;
}
