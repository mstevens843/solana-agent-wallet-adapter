/**
 * Remote configuration served to the iOS Capacitor app at startup. Mirrors the
 * intent of `androidConfig.ts` but uses iOS-shaped wallet metadata (deeplink
 * schemes + App Store IDs) instead of Android packageName + icon hashes.
 *
 * The iOS bridge ships hardcoded defaults
 * (`packages/ios-capacitor-bridge/ios/Plugin/AgenticRemoteConfigStore.swift`
 * `AgenticRemoteConfigDefaults.bundled`) that mirror this slice byte-for-byte
 * at build time. That guarantees the app keeps working when the server is
 * unreachable on first launch.
 *
 * Contract invariants (mirror androidConfig.ts):
 *   - Bumping `version` is informational only; the iOS app reads field-by-field.
 *   - `memoProofRouter.proofMemoPrefix` MUST stay byte-identical to the Android
 *     equivalent (`auth.ts` `ACCEPTED_ENVELOPE_PREFIXES` validates both).
 *   - Adding a wallet to `walletRegistry` lets shipped iOS apps recognise a
 *     wallet they don't yet know about.
 *   - `STATIC_FEATURE_FLAGS` MUST mirror Android `STATIC_FEATURE_FLAGS` for
 *     cross-platform flags; iOS-specific flags can be added freely.
 *
 * The wallet transport boundary is intentionally different from Android:
 *   - Phantom/Solflare/Backpack use **encrypted deeplinks** (NaCl box).
 *   - Jupiter uses **WalletConnect v2** (Reown SDK).
 *
 * Per user constraint: "the difference would only be the mwa vs ios wallet
 * methods. that should be kept different."
 */

import { isSkrSessionDefaultActive, isSkrSkillBountyActive, readSkrMint } from './skrConfig.js';

export const IOS_CONFIG_VERSION = 1;

export interface IosWalletEntry {
  /** Stable id matching apps/ios-native enum + iosNative.ts wallet picker. */
  readonly id: string;
  readonly name: string;
  /** Custom URL schemes used for `canOpenURL` detection. */
  readonly deeplinkSchemes?: readonly string[];
  /** Numeric App Store ID for fallback "install wallet" links. */
  readonly appStoreId?: string;
  /** Whether the wallet's deeplink `signMessage` handler is reliable. */
  readonly supportsSignMessages: boolean;
  /** Whether SIWS (sign-in-with-Solana) is reliable via this wallet's deeplink. */
  readonly supportsSiws: boolean;
  /** When true, route this wallet via WalletConnect v2 even if a deeplink exists. */
  readonly forceWalletConnectFallback?: boolean;
}

export interface IosMemoProofRouterConfig {
  readonly envelopeVersion: string;
  readonly proofMemoPrefix: string;
  /** When the wallet identifier is empty, treat as needing the fallback path. */
  readonly fallbackOnBlankPackage: boolean;
}

export interface IosRemoteConfig {
  readonly version: number;
  readonly walletRegistry: readonly IosWalletEntry[];
  readonly memoProofRouter: IosMemoProofRouterConfig;
  readonly featureFlags: Readonly<Record<string, boolean>>;
  /** WalletConnect Reown project id; consumed by AgenticWalletConnectPlugin. */
  readonly walletConnectProjectId?: string;
  /** Pairing timeout for WalletConnect v2 (milliseconds). */
  readonly walletConnectPairingTimeoutMs?: number;
  /** Reown relay host used by the native iOS WalletConnect bridge. */
  readonly walletConnectRelayHost?: string;
  /** Origin header used by native iOS relay WebSocket requests. */
  readonly walletConnectRelayOrigin?: string;
}

const WALLET_REGISTRY: readonly IosWalletEntry[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    deeplinkSchemes: ['phantom', 'https'],
    appStoreId: '1598432977',
    supportsSignMessages: true,
    supportsSiws: true,
    forceWalletConnectFallback: false,
  },
  {
    id: 'solflare',
    name: 'Solflare',
    deeplinkSchemes: ['solflare', 'https'],
    appStoreId: '1580902717',
    supportsSignMessages: true,
    supportsSiws: false,
    forceWalletConnectFallback: false,
  },
  {
    id: 'backpack',
    name: 'Backpack',
    deeplinkSchemes: ['backpack', 'https'],
    appStoreId: '6445964121',
    supportsSignMessages: true,
    supportsSiws: true,
    forceWalletConnectFallback: false,
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    deeplinkSchemes: ['wc'],
    appStoreId: '6484069059',
    supportsSignMessages: true,
    supportsSiws: false,
    forceWalletConnectFallback: true,
  },
];

// Must match Android proofMemoPrefix byte-for-byte. The server-side verifier
// in auth.ts accepts both.
const MEMO_PROOF_ROUTER: IosMemoProofRouterConfig = {
  envelopeVersion: 'v1',
  proofMemoPrefix: 'Agentic plan review proof v1\nSHA-256: ',
  fallbackOnBlankPackage: true,
};

const STATIC_FEATURE_FLAGS: Readonly<Record<string, boolean>> = {
  // Mirrors Android forceMemoTxFallback semantics but applies to the iOS
  // WalletConnect fallback path: when true, route every wallet through WC
  // even if a deeplink exists. Used during a deeplink-wallet incident.
  forceWalletConnectFallback: false,
};

const DEFAULT_WALLETCONNECT_RELAY_HOST = 'relay.walletconnect.com';
const DEFAULT_WALLETCONNECT_RELAY_ORIGIN = 'https://agentic-signer.com';

function buildFeatureFlags(env: NodeJS.ProcessEnv): Readonly<Record<string, boolean>> {
  const skrConfigured = readSkrMint(env).length > 0;
  if (!skrConfigured) return STATIC_FEATURE_FLAGS;
  return Object.freeze({
    ...STATIC_FEATURE_FLAGS,
    skrEnabled: true,
    skrSkillBountyActive: isSkrSkillBountyActive(env),
    skrSessionDefault: isSkrSessionDefaultActive(env),
  });
}

function readWalletConnectProjectId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.WALLETCONNECT_PROJECT_ID ?? env.WC_PROJECT_ID ?? '').trim();
  if (!raw) return undefined;
  // Reown project ids are 32 hex chars; reject anything that's obviously not one.
  if (!/^[0-9a-f]{8,64}$/i.test(raw)) return undefined;
  return raw;
}

function readWalletConnectRelayHost(env: NodeJS.ProcessEnv): string {
  const raw = (env.WALLETCONNECT_RELAY_HOST ?? env.REOWN_RELAY_HOST ?? '').trim();
  if (!raw) return DEFAULT_WALLETCONNECT_RELAY_HOST;
  const host = raw.replace(/^wss?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/i.test(host)) return DEFAULT_WALLETCONNECT_RELAY_HOST;
  return host;
}

function readWalletConnectRelayOrigin(env: NodeJS.ProcessEnv): string {
  const raw = (
    env.WALLETCONNECT_RELAY_ORIGIN ??
    env.REOWN_RELAY_ORIGIN ??
    env.AGENTIC_PUBLIC_ORIGIN ??
    ''
  ).trim();
  if (!raw) return DEFAULT_WALLETCONNECT_RELAY_ORIGIN;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return DEFAULT_WALLETCONNECT_RELAY_ORIGIN;
    return parsed.origin;
  } catch {
    return DEFAULT_WALLETCONNECT_RELAY_ORIGIN;
  }
}

export const IOS_REMOTE_CONFIG: IosRemoteConfig = {
  version: IOS_CONFIG_VERSION,
  walletRegistry: WALLET_REGISTRY,
  memoProofRouter: MEMO_PROOF_ROUTER,
  featureFlags: STATIC_FEATURE_FLAGS,
  walletConnectProjectId: undefined,
  walletConnectPairingTimeoutMs: 120_000,
  walletConnectRelayHost: DEFAULT_WALLETCONNECT_RELAY_HOST,
  walletConnectRelayOrigin: DEFAULT_WALLETCONNECT_RELAY_ORIGIN,
};

export function getIosRemoteConfig(env: NodeJS.ProcessEnv = process.env): IosRemoteConfig {
  const featureFlags = buildFeatureFlags(env);
  const wcProject = readWalletConnectProjectId(env);
  const relayHost = readWalletConnectRelayHost(env);
  const relayOrigin = readWalletConnectRelayOrigin(env);
  if (
    featureFlags === STATIC_FEATURE_FLAGS &&
    wcProject === undefined &&
    relayHost === DEFAULT_WALLETCONNECT_RELAY_HOST &&
    relayOrigin === DEFAULT_WALLETCONNECT_RELAY_ORIGIN
  ) {
    return IOS_REMOTE_CONFIG;
  }
  return {
    version: IOS_CONFIG_VERSION,
    walletRegistry: WALLET_REGISTRY,
    memoProofRouter: MEMO_PROOF_ROUTER,
    featureFlags,
    walletConnectProjectId: wcProject,
    walletConnectPairingTimeoutMs: 120_000,
    walletConnectRelayHost: relayHost,
    walletConnectRelayOrigin: relayOrigin,
  };
}
