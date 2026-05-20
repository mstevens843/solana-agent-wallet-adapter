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

function isAndroidRemoteConfigSnapshot(value: unknown): value is AndroidRemoteConfigSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'number' &&
    (v.source === 'server' || v.source === 'cache' || v.source === 'bundled') &&
    typeof v.fetchedAtMs === 'number' &&
    Array.isArray(v.walletRegistry) &&
    typeof v.memoProofRouter === 'object' &&
    v.memoProofRouter !== null
  );
}

function isAndroidRemoteConfigStatus(value: unknown): value is AndroidRemoteConfigStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === 'number' &&
    (v.source === 'server' || v.source === 'cache' || v.source === 'bundled') &&
    typeof v.fetchedAtMs === 'number' &&
    typeof v.walletCount === 'number' &&
    typeof v.envelopeVersion === 'string'
  );
}

/** Read the current remote-config snapshot. Returns null off-Android or on parse failure. */
export function getRemoteConfig(): AndroidRemoteConfigSnapshot | null {
  const fn = bridge()?.remoteConfigGet;
  if (!fn) return null;
  try {
    const raw = fn();
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isAndroidRemoteConfigSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Lightweight status snapshot — version, source, fetchedAtMs, walletCount. */
export function getRemoteConfigStatus(): AndroidRemoteConfigStatus | null {
  const fn = bridge()?.remoteConfigStatus;
  if (!fn) return null;
  try {
    const parsed: unknown = JSON.parse(fn());
    return isAndroidRemoteConfigStatus(parsed) ? parsed : null;
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
    const parsed: unknown = JSON.parse(fn());
    return isAndroidRemoteConfigStatus(parsed) ? parsed : null;
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

function isAndroidSystemInfo(value: unknown): value is AndroidSystemInfo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.manufacturer === 'string' &&
    typeof v.model === 'string' &&
    typeof v.sdkInt === 'number' &&
    typeof v.networkType === 'string'
  );
}

export function getSystemInfo(): AndroidSystemInfo | null {
  const raw = bridge()?.systemInfo?.();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAndroidSystemInfo(parsed) ? parsed : null;
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

function isAndroidNotificationResult(value: unknown): value is AndroidNotificationResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.ok === 'boolean';
}

export function showNotification(
  payload: AndroidNotificationPayload,
): AndroidNotificationResult {
  const fn = bridge()?.showNotification;
  if (!fn) return { ok: false, error: 'bridge_not_available' };
  try {
    const parsed: unknown = JSON.parse(fn(JSON.stringify(payload)));
    if (!isAndroidNotificationResult(parsed)) {
      return { ok: false, error: 'invalid_response_shape' };
    }
    return parsed;
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

function isBiometricStatus(value: unknown): value is BiometricStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === 'number' && typeof v.kind === 'string';
}

export function getBiometricStatus(): BiometricStatus | null {
  const raw = bridge()?.biometricStatus?.();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isBiometricStatus(parsed) ? parsed : null;
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
// Belt-and-suspenders cap to bound the map size in pathological "fire lots of
// prompts and never resolve" scenarios. Map is a Map<string, PendingBiometric>
// so we know iteration order is insertion order — drop the oldest first.
const PENDING_BIOMETRIC_MAX_ENTRIES = 100;

function rejectPending(pending: PendingBiometric, kind: BiometricResultKind, message: string): void {
  if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
  pending.resolve({ ok: false, kind, message });
}

/** Settle every in-flight biometric promise and clear the map. */
function purgePendingBiometric(reason: string): void {
  if (PENDING_BIOMETRIC.size === 0) return;
  for (const pending of PENDING_BIOMETRIC.values()) {
    rejectPending(pending, 'USER_CANCELED', `biometric prompt purged: ${reason}`);
  }
  PENDING_BIOMETRIC.clear();
}

let unloadHandlerInstalled = false;
function installUnloadHandlerOnce(): void {
  if (unloadHandlerInstalled) return;
  unloadHandlerInstalled = true;
  // SPA unmount / tab close / WebView teardown. addEventListener is a no-op if
  // the host doesn't have window (Android JSC, tests via jsdom both have it).
  const w = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: () => void) => void;
  };
  w.addEventListener?.('beforeunload', () => purgePendingBiometric('beforeunload'));
  w.addEventListener?.('pagehide', () => purgePendingBiometric('pagehide'));
}

function installBiometricBridge(): void {
  const globalAny = globalThis as typeof globalThis & {
    __agenticAndroidBiometricBridge?: {
      resolve(requestId: string, envelope: BiometricResult): void;
    };
  };
  installUnloadHandlerOnce();
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
 * Show the native biometric prompt. Resolves with the auth result. Always settles —
 * on dispatch failure or off-Android, resolves with kind=ERROR or
 * HARDWARE_UNAVAILABLE so callers don't need a try/catch.
 *
 * **SECURITY: this is a UX gate, not a security boundary.** The result envelope
 * arrives via `window.__agenticAndroidBiometricBridge.resolve()`, which any code
 * in the same JS realm can call — there is no cryptographic binding between the
 * native hardware auth and the result this Promise observes. Use for confirmation
 * UX only (transaction review, sensitive setting toggles). Do NOT gate release
 * of secrets or transaction-signing authorization with this. See the
 * `BiometricBridge.kt` header for what a true security boundary would look like.
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
    // Belt-and-suspenders eviction: if a runaway caller never settles the
    // promise (e.g., the native side stops calling back), drop the oldest entry
    // to prevent unbounded growth. Map iteration is insertion-order.
    if (PENDING_BIOMETRIC.size >= PENDING_BIOMETRIC_MAX_ENTRIES) {
      const oldestKey = PENDING_BIOMETRIC.keys().next().value;
      if (oldestKey) {
        const evicted = PENDING_BIOMETRIC.get(oldestKey);
        PENDING_BIOMETRIC.delete(oldestKey);
        if (evicted) {
          rejectPending(evicted, 'ERROR', 'evicted by newer biometric prompt (cap exceeded)');
        }
      }
    }
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

function isAppLifecycleSnapshot(value: unknown): value is AppLifecycleSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.state === 'string' && typeof v.hasFocus === 'boolean';
}

export function getAppLifecycle(): AppLifecycleSnapshot | null {
  const raw = bridge()?.appLifecycleState?.();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAppLifecycleSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
