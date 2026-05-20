/**
 * Typed wrappers around the Android JS bridge for remote config + Phase 2 system
 * primitives. The native bridge surface is frozen at APK submission, so the goal
 * here is just to make calls type-safe and to wrap the one async method
 * (biometricPrompt) in a Promise.
 *
 * On non-Android contexts (web browser, iOS), every helper returns null/undefined
 * — callers should check for that and fall back to web defaults.
 */

interface BridgeShape {
  remoteConfigGet?: () => string;
  remoteConfigRefresh?: () => string;
  remoteConfigStatus?: () => string;
  openExternal?: (url: string) => boolean;
  systemInfo?: () => string;
  clipboardWrite?: (text: string) => boolean;
  haptic?: (pattern: string) => boolean;
  showNotification?: (payloadJson: string) => string;
  biometricStatus?: () => string;
  biometricPrompt?: (requestId: string, payloadJson: string) => void;
  appLifecycleState?: () => string;
}

function bridge(): BridgeShape | undefined {
  const globalAny = globalThis as typeof globalThis & {
    AgenticAndroid?: BridgeShape;
  };
  return globalAny.AgenticAndroid;
}

export interface AndroidWalletConfigEntry {
  id: number;
  name: string;
  packageNames: string[];
  uriPatterns: string[];
  iconSha256First8: string | null;
  supportsSignMessages: boolean;
  supportsSiws: boolean;
  forceSignThenRpc: boolean;
}

export interface AndroidMemoProofConfig {
  envelopeVersion: string;
  proofMemoPrefix: string;
  fallbackOnBlankPackage: boolean;
}

export interface AndroidRemoteConfigSnapshot {
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletRegistry: AndroidWalletConfigEntry[];
  memoProofRouter: AndroidMemoProofConfig;
  featureFlags: Record<string, boolean>;
}

export interface AndroidRemoteConfigStatus {
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletCount: number;
  envelopeVersion: string;
}

/** Read the current remote-config snapshot. Returns null off-Android or on parse failure. */
export function getRemoteConfig(): AndroidRemoteConfigSnapshot | null {
  const fn = bridge()?.remoteConfigGet;
  if (!fn) return null;
  try {
    const raw = fn();
    if (!raw) return null;
    return JSON.parse(raw) as AndroidRemoteConfigSnapshot;
  } catch {
    return null;
  }
}

/** Lightweight status snapshot — version, source, fetchedAtMs, walletCount. */
export function getRemoteConfigStatus(): AndroidRemoteConfigStatus | null {
  const fn = bridge()?.remoteConfigStatus;
  if (!fn) return null;
  try {
    return JSON.parse(fn()) as AndroidRemoteConfigStatus;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget refresh. Native side dispatches an async fetch and returns the
 * current status synchronously. Caller can poll [getRemoteConfigStatus] to detect
 * when fresh config lands (compare `fetchedAtMs`).
 */
export function refreshRemoteConfig(): AndroidRemoteConfigStatus | null {
  const fn = bridge()?.remoteConfigRefresh;
  if (!fn) return null;
  try {
    return JSON.parse(fn()) as AndroidRemoteConfigStatus;
  } catch {
    return null;
  }
}

/** Read a boolean feature flag. Returns the fallback when the flag is unset or off-Android. */
export function getFeatureFlag(name: string, fallback = false): boolean {
  const cfg = getRemoteConfig();
  if (!cfg) return fallback;
  const value = cfg.featureFlags?.[name];
  return typeof value === 'boolean' ? value : fallback;
}

// ── Phase 2 system primitives ─────────────────────────────────────────────────

export function openExternalUrl(url: string): boolean {
  return Boolean(bridge()?.openExternal?.(url));
}

export interface AndroidSystemInfo {
  manufacturer: string;
  model: string;
  device: string;
  sdkInt: number;
  release: string;
  locale: string;
  timezone: string;
  batteryPercent: number;
  networkType: 'wifi' | 'cellular' | 'ethernet' | 'offline' | 'other' | 'unknown';
  packageName: string;
}

export function getSystemInfo(): AndroidSystemInfo | null {
  const raw = bridge()?.systemInfo?.();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AndroidSystemInfo;
  } catch {
    return null;
  }
}

export function clipboardWrite(text: string): boolean {
  return Boolean(bridge()?.clipboardWrite?.(text));
}

export type HapticPattern = 'light' | 'medium' | 'heavy';
export function haptic(pattern: HapticPattern = 'light'): boolean {
  return Boolean(bridge()?.haptic?.(pattern));
}

export interface AndroidNotificationPayload {
  title: string;
  body: string;
  tag?: string;
  channelId?: string;
}

export interface AndroidNotificationResult {
  ok: boolean;
  id?: number;
  tag?: string | null;
  error?: string;
}

export function showNotification(
  payload: AndroidNotificationPayload,
): AndroidNotificationResult {
  const fn = bridge()?.showNotification;
  if (!fn) return { ok: false, error: 'bridge_not_available' };
  try {
    return JSON.parse(fn(JSON.stringify(payload))) as AndroidNotificationResult;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'parse_failed' };
  }
}

export type BiometricStatusKind =
  | 'AVAILABLE'
  | 'NO_HARDWARE'
  | 'HARDWARE_UNAVAILABLE'
  | 'NO_ENROLLED'
  | 'SECURITY_UPDATE_REQUIRED'
  | 'UNSUPPORTED'
  | 'UNKNOWN'
  | 'OTHER';

export interface BiometricStatus {
  status: number;
  kind: BiometricStatusKind;
}

export function getBiometricStatus(): BiometricStatus | null {
  const raw = bridge()?.biometricStatus?.();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BiometricStatus;
  } catch {
    return null;
  }
}

export interface BiometricPromptPayload {
  title: string;
  subtitle?: string;
  description?: string;
  negativeButton?: string;
  allowDeviceCredential?: boolean;
}

export type BiometricResultKind =
  | 'AUTH_SUCCEEDED'
  | 'USER_CANCELED'
  | 'LOCKED_OUT'
  | 'NO_ENROLLED'
  | 'HARDWARE_UNAVAILABLE'
  | 'NO_DEVICE_CREDENTIAL'
  | 'ERROR';

export interface BiometricResult {
  ok: boolean;
  kind: BiometricResultKind;
  code?: number | string;
  message?: string;
  authType?: number;
}

interface PendingBiometric {
  resolve(result: BiometricResult): void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const PENDING_BIOMETRIC = new Map<string, PendingBiometric>();
const BIOMETRIC_TIMEOUT_MS = 120_000;

function installBiometricBridge(): void {
  const globalAny = globalThis as typeof globalThis & {
    __agenticAndroidBiometricBridge?: {
      resolve(requestId: string, envelope: BiometricResult): void;
    };
  };
  if (globalAny.__agenticAndroidBiometricBridge) return;
  globalAny.__agenticAndroidBiometricBridge = {
    resolve(requestId, envelope) {
      const pending = PENDING_BIOMETRIC.get(requestId);
      if (!pending) return;
      PENDING_BIOMETRIC.delete(requestId);
      if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
      pending.resolve(envelope);
    },
  };
}

/**
 * Show the native biometric prompt. Resolves with the auth result. Always settles
 * — on dispatch failure or off-Android, resolves with kind=ERROR or
 * HARDWARE_UNAVAILABLE so callers don't need a try/catch.
 */
export function biometricPrompt(payload: BiometricPromptPayload): Promise<BiometricResult> {
  const fn = bridge()?.biometricPrompt;
  if (!fn) {
    return Promise.resolve({
      ok: false,
      kind: 'HARDWARE_UNAVAILABLE',
      message: 'biometric bridge not available',
    });
  }
  installBiometricBridge();
  const requestId = `biometric-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return new Promise<BiometricResult>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      if (!PENDING_BIOMETRIC.has(requestId)) return;
      PENDING_BIOMETRIC.delete(requestId);
      resolve({
        ok: false,
        kind: 'ERROR',
        code: 'timeout',
        message: `biometric prompt did not resolve within ${BIOMETRIC_TIMEOUT_MS}ms`,
      });
    }, BIOMETRIC_TIMEOUT_MS);
    PENDING_BIOMETRIC.set(requestId, { resolve, timeoutHandle });
    try {
      fn(requestId, JSON.stringify(payload));
    } catch (err) {
      PENDING_BIOMETRIC.delete(requestId);
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        kind: 'ERROR',
        code: 'dispatch_failed',
        message: err instanceof Error ? err.message : 'unknown dispatch error',
      });
    }
  });
}

export interface AppLifecycleSnapshot {
  state: 'initialized' | 'created' | 'started' | 'resumed' | 'destroyed';
  hasFocus: boolean;
}

export function getAppLifecycle(): AppLifecycleSnapshot | null {
  const raw = bridge()?.appLifecycleState?.();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AppLifecycleSnapshot;
  } catch {
    return null;
  }
}
