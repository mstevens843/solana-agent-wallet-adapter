export type AiPathMode = 'hosted' | 'session' | 'bridge' | 'device-agent';

export const MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED =
  'Sign in to Agentic Cloud to use Hosted BYOK';

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

// Hosted BYOK on mobile requires an Agentic Cloud session because the API key is
// relayed through the backend (agentic-signer.com) rather than called direct from
// device. The cloud session is wallet-bound, so wallet disconnect closes the gate
// automatically — no separate key cleanup is needed for this path.
export function mobileAiModeDisabledReason(input: {
  mobileAiPathPolicy: boolean;
  mode: AiPathMode;
  cloudSessionMatchesWallet: boolean;
}): string {
  if (!input.mobileAiPathPolicy) return '';
  if (input.mode === 'hosted' && !input.cloudSessionMatchesWallet) {
    return MOBILE_HOSTED_BYOK_CLOUD_SIGNIN_REQUIRED;
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
