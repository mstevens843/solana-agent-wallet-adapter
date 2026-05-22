/**
 * Typed wrappers around the iOS `AgenticRemoteConfig` Capacitor plugin. Mirrors
 * the surface of `androidConfigClient.ts` so cross-platform call sites can use
 * one shape via `mobileConfigClient.ts`.
 *
 * On non-iOS contexts every helper returns null/undefined and callers fall back
 * to web defaults.
 */

import { registerPlugin } from '@capacitor/core';

interface IosRemoteConfigPluginShape {
  get(): Promise<unknown>;
  refresh(options?: { force?: boolean }): Promise<IosRemoteConfigStatus>;
  status(): Promise<IosRemoteConfigStatus>;
}

let cachedPlugin: IosRemoteConfigPluginShape | null = null;

function plugin(): IosRemoteConfigPluginShape | null {
  if (cachedPlugin) return cachedPlugin;
  try {
    cachedPlugin = registerPlugin<IosRemoteConfigPluginShape>('AgenticRemoteConfig');
    return cachedPlugin;
  } catch {
    return null;
  }
}

export interface IosWalletConfigEntry {
  id: string;
  name: string;
  deeplinkSchemes: string[] | null;
  appStoreId: string | null;
  supportsSignMessages: boolean;
  supportsSiws: boolean;
  forceWalletConnectFallback: boolean;
}

export interface IosMemoProofConfig {
  envelopeVersion: string;
  proofMemoPrefix: string;
  fallbackOnBlankPackage: boolean;
}

export interface IosRemoteConfigSnapshot {
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletRegistry: IosWalletConfigEntry[];
  memoProofRouter: IosMemoProofConfig;
  featureFlags: Record<string, boolean>;
  walletConnectProjectId: string | null;
  walletConnectPairingTimeoutMs: number | null;
}

export interface IosRemoteConfigStatus {
  version: number;
  source: 'server' | 'cache' | 'bundled';
  fetchedAtMs: number;
  walletCount: number;
  envelopeVersion: string;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

function asWalletEntry(value: unknown): IosWalletConfigEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const id = asString(v.id);
  const name = asString(v.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    deeplinkSchemes: asStringArray(v.deeplinkSchemes),
    appStoreId: asString(v.appStoreId),
    supportsSignMessages: v.supportsSignMessages !== false,
    supportsSiws: v.supportsSiws === true,
    forceWalletConnectFallback: v.forceWalletConnectFallback === true,
  };
}

function asMemoProof(value: unknown): IosMemoProofConfig {
  if (!value || typeof value !== 'object') {
    return {
      envelopeVersion: 'v1',
      proofMemoPrefix: 'Agentic plan review proof v1\nSHA-256: ',
      fallbackOnBlankPackage: true,
    };
  }
  const v = value as Record<string, unknown>;
  return {
    envelopeVersion: typeof v.envelopeVersion === 'string' ? v.envelopeVersion : 'v1',
    proofMemoPrefix:
      typeof v.proofMemoPrefix === 'string' ? v.proofMemoPrefix : 'Agentic plan review proof v1\nSHA-256: ',
    fallbackOnBlankPackage: v.fallbackOnBlankPackage !== false,
  };
}

function asFeatureFlags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function asStatus(value: unknown): IosRemoteConfigStatus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const version = typeof v.version === 'number' ? v.version : 0;
  const source = (v.source === 'server' || v.source === 'cache' ? v.source : 'bundled') as
    | 'server'
    | 'cache'
    | 'bundled';
  return {
    version,
    source,
    fetchedAtMs: typeof v.fetchedAtMs === 'number' ? v.fetchedAtMs : 0,
    walletCount: typeof v.walletCount === 'number' ? v.walletCount : 0,
    envelopeVersion: typeof v.envelopeVersion === 'string' ? v.envelopeVersion : 'v1',
  };
}

export async function getIosRemoteConfig(): Promise<IosRemoteConfigSnapshot | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const raw = await p.get();
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as Record<string, unknown>;
    const meta = (v.__meta as Record<string, unknown> | undefined) ?? {};
    const wallets = Array.isArray(v.walletRegistry)
      ? v.walletRegistry.map(asWalletEntry).filter((w): w is IosWalletConfigEntry => w !== null)
      : [];
    return {
      version: typeof v.version === 'number' ? v.version : 0,
      source: ((meta.source as string) ?? 'bundled') as 'server' | 'cache' | 'bundled',
      fetchedAtMs: typeof meta.fetchedAtMs === 'number' ? meta.fetchedAtMs : 0,
      walletRegistry: wallets,
      memoProofRouter: asMemoProof(v.memoProofRouter),
      featureFlags: asFeatureFlags(v.featureFlags),
      walletConnectProjectId: asString(v.walletConnectProjectId),
      walletConnectPairingTimeoutMs:
        typeof v.walletConnectPairingTimeoutMs === 'number' ? v.walletConnectPairingTimeoutMs : null,
    };
  } catch {
    return null;
  }
}

export async function getIosRemoteConfigStatus(): Promise<IosRemoteConfigStatus | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return asStatus(await p.status());
  } catch {
    return null;
  }
}

export async function refreshIosRemoteConfig(force = false): Promise<IosRemoteConfigStatus | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return asStatus(await p.refresh({ force }));
  } catch {
    return null;
  }
}
