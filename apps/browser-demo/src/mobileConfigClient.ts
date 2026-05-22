/**
 * Cross-platform façade for remote config. Routes to the Android JS bridge
 * (`androidConfigClient.ts`) or the iOS Capacitor plugin (`iosConfigClient.ts`)
 * based on runtime detection. Returns null when neither bridge is available
 * (e.g., plain web shell) — callers fall back to defaults.
 *
 * Use this instead of platform-specific clients in any code path that needs to
 * work on both shells.
 */

import {
  getRemoteConfig as getAndroidRemoteConfig,
  getRemoteConfigStatus as getAndroidRemoteConfigStatus,
  refreshRemoteConfig as refreshAndroidRemoteConfig,
  type AndroidWalletConfigEntry,
} from './androidConfigClient.js';
import {
  getIosRemoteConfig,
  getIosRemoteConfigStatus,
  refreshIosRemoteConfig,
  type IosWalletConfigEntry,
} from './iosConfigClient.js';

export type MobilePlatform = 'android' | 'ios' | 'none';

export interface MobileWalletConfigEntry {
  id: string;
  name: string;
  /** Android package names; iOS deeplink schemes. Empty array when N/A. */
  identifiers: string[];
  supportsSignMessages: boolean;
  supportsSiws: boolean;
  /** Android forceSignThenRpc OR iOS forceWalletConnectFallback. */
  forceFallback: boolean;
}

export interface MobileRemoteConfigSnapshot {
  platform: MobilePlatform;
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletRegistry: MobileWalletConfigEntry[];
  memoEnvelopePrefix: string;
  featureFlags: Record<string, boolean>;
  walletConnectProjectId?: string | null;
}

function detectPlatform(): MobilePlatform {
  const g = globalThis as Record<string, unknown>;
  if (g.AgenticAndroid) return 'android';
  // Capacitor presence + iOS user agent is the most reliable iOS detection.
  const cap = (g.Capacitor as { getPlatform?: () => string } | undefined);
  if (typeof cap?.getPlatform === 'function') {
    if (cap.getPlatform() === 'ios') return 'ios';
  }
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return 'ios';
  }
  return 'none';
}

function normalizeIosEntry(entry: IosWalletConfigEntry): MobileWalletConfigEntry {
  return {
    id: entry.id,
    name: entry.name,
    identifiers: entry.deeplinkSchemes ?? [],
    supportsSignMessages: entry.supportsSignMessages,
    supportsSiws: entry.supportsSiws,
    forceFallback: entry.forceWalletConnectFallback,
  };
}

export async function getMobileRemoteConfig(): Promise<MobileRemoteConfigSnapshot | null> {
  const platform = detectPlatform();
  if (platform === 'android') {
    const snapshot = getAndroidRemoteConfig();
    if (!snapshot) return null;
    return {
      platform,
      version: snapshot.version,
      source: snapshot.source,
      fetchedAtMs: snapshot.fetchedAtMs,
      walletRegistry: snapshot.walletRegistry.map((w: AndroidWalletConfigEntry) => ({
        id: String(w.id),
        name: w.name,
        identifiers: w.packageNames,
        supportsSignMessages: w.supportsSignMessages,
        supportsSiws: w.supportsSiws,
        forceFallback: w.forceSignThenRpc,
      })),
      memoEnvelopePrefix: snapshot.memoProofRouter.proofMemoPrefix,
      featureFlags: snapshot.featureFlags,
    };
  }
  if (platform === 'ios') {
    const snapshot = await getIosRemoteConfig();
    if (!snapshot) return null;
    return {
      platform,
      version: snapshot.version,
      source: snapshot.source,
      fetchedAtMs: snapshot.fetchedAtMs,
      walletRegistry: snapshot.walletRegistry.map(normalizeIosEntry),
      memoEnvelopePrefix: snapshot.memoProofRouter.proofMemoPrefix,
      featureFlags: snapshot.featureFlags,
      walletConnectProjectId: snapshot.walletConnectProjectId,
    };
  }
  return null;
}

export async function refreshMobileRemoteConfig(force = false): Promise<void> {
  const platform = detectPlatform();
  if (platform === 'android') {
    refreshAndroidRemoteConfig();
    return;
  }
  if (platform === 'ios') {
    await refreshIosRemoteConfig(force);
  }
}

export async function getMobileRemoteConfigStatus(): Promise<{
  platform: MobilePlatform;
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletCount: number;
  envelopeVersion: string;
} | null> {
  const platform = detectPlatform();
  if (platform === 'android') {
    const status = getAndroidRemoteConfigStatus();
    if (!status) return null;
    return { platform, ...status };
  }
  if (platform === 'ios') {
    const status = await getIosRemoteConfigStatus();
    if (!status) return null;
    return { platform, ...status };
  }
  return null;
}
