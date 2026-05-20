/**
 * Remote configuration served to the Android APK at startup. The APK ships hardcoded
 * defaults (`apps/android-twa/.../config/RemoteConfigDefaults.kt`) that mirror the
 * *static* slice of this payload — wallet table, memo-proof router, and
 * `STATIC_FEATURE_FLAGS` — byte-for-byte at APK build time. That guarantees the app
 * keeps working when the server is unreachable on first launch.
 *
 * The server's response may be a *superset* of the bundled defaults when
 * env-conditional flags are active (e.g. `skrEnabled` / `skrSkillBountyActive` /
 * `skrSessionDefault` when `SKR_TOKEN_MINT` is set on Render). The APK tolerates the
 * extra fields via field-by-field parsing — unknown flags pass through the parser
 * and are readable via `getFeatureFlag(name, fallback)` without code changes.
 *
 * Changes here ship via Render redeploy and reach installed APKs on the next config
 * refresh (foreground app, every hour, or via explicit `bridge.remoteConfigRefresh()`).
 *
 * Contract invariants:
 *   - Bumping `version` is informational only; the APK reads field-by-field.
 *   - `memoProofRouter.proofMemoPrefix` MUST appear in `auth.ts`
 *     `ACCEPTED_ENVELOPE_PREFIXES`. Server has to accept everything any shipped APK
 *     might send forever, because old APKs in the dApp Store keep sending old
 *     versions.
 *   - Adding a wallet to `walletRegistry` lets shipped APKs route a wallet they
 *     don't yet know about — they fall back to `inferPackage()` heuristics in
 *     `WalletRegistry.kt`, but the routing flags from this config win when a
 *     match is found.
 *   - `STATIC_FEATURE_FLAGS` MUST mirror `RemoteConfigDefaults.FEATURE_FLAGS`
 *     byte-for-byte. Env-conditional flags (added by `buildFeatureFlags(env)`)
 *     are NOT mirrored — they only exist when their gating env vars are set.
 */

import { isSkrSessionDefaultActive, isSkrSkillBountyActive, readSkrMint } from './skrConfig.js';

export const ANDROID_CONFIG_VERSION = 1;

export interface AndroidWalletEntry {
  /** Numeric ID matching WalletRegistry.kt constants (PHANTOM=20, SOLFLARE=25, ...). */
  readonly id: number;
  readonly name: string;
  readonly packageNames: readonly string[];
  readonly uriPatterns?: readonly string[];
  /** First-8-bytes-of-SHA256 fingerprint of the wallet icon (for fingerprint matching). */
  readonly iconSha256First8?: string;
  /** Whether the wallet's MWA `sign_messages` handler works without hanging. */
  readonly supportsSignMessages: boolean;
  /** Whether SIWS (sign-in-with-Solana) is reliable; false routes through memo-tx. */
  readonly supportsSiws: boolean;
  /** Whether to bypass the wallet's `sign_and_send_transactions` and use sign-then-RPC. */
  readonly forceSignThenRpc: boolean;
}

export interface AndroidMemoProofRouterConfig {
  readonly envelopeVersion: string;
  readonly proofMemoPrefix: string;
  readonly fallbackOnBlankPackage: boolean;
}

export interface AndroidRemoteConfig {
  readonly version: number;
  readonly walletRegistry: readonly AndroidWalletEntry[];
  readonly memoProofRouter: AndroidMemoProofRouterConfig;
  readonly featureFlags: Readonly<Record<string, boolean>>;
}

const WALLET_REGISTRY: readonly AndroidWalletEntry[] = [
  {
    id: 20,
    name: 'phantom',
    packageNames: ['app.phantom'],
    uriPatterns: ['phantom.app'],
    supportsSignMessages: false,
    supportsSiws: true,
    forceSignThenRpc: false,
  },
  {
    id: 25,
    name: 'solflare',
    packageNames: ['com.solflare.mobile'],
    uriPatterns: ['solflare.com'],
    iconSha256First8: '245123d8a7fd8aa5',
    supportsSignMessages: false,
    supportsSiws: false,
    forceSignThenRpc: false,
  },
  {
    id: 36,
    name: 'backpack',
    packageNames: ['app.backpack.mobile'],
    uriPatterns: ['backpack.app'],
    supportsSignMessages: true,
    supportsSiws: true,
    forceSignThenRpc: true,
  },
  {
    id: 40,
    name: 'jupiter',
    packageNames: ['ag.jup.jupiter.android'],
    uriPatterns: ['jup.ag', 'jupiter'],
    supportsSignMessages: true,
    supportsSiws: true,
    forceSignThenRpc: true,
  },
  {
    id: 50,
    name: 'seedvault',
    packageNames: ['com.solanamobile.seedvaultimpl'],
    uriPatterns: ['seedvault', 'seed-vault', 'seedvaultwallet', 'solanamobilewallet'],
    supportsSignMessages: false,
    supportsSiws: false,
    forceSignThenRpc: false,
  },
];

const MEMO_PROOF_ROUTER: AndroidMemoProofRouterConfig = {
  envelopeVersion: 'v1',
  proofMemoPrefix: 'Agentic plan review proof v1\nSHA-256: ',
  fallbackOnBlankPackage: true,
};

/**
 * Operator-rotatable kill-switches. Names must stay stable forever (shipped APKs
 * read them by string key). Add new flags by appending; never rename.
 *
 *   forceMemoTxFallback: when true, the Android side routes EVERY wallet
 *     through the memo-tx ownership-proof path regardless of
 *     `messageSigningUnsupported()` / `fallbackOnBlankPackage` heuristics.
 *     Use during a sign_messages incident (e.g. a wallet vendor ships a bad
 *     update that hangs MWA `sign_messages`). The memo-tx path is the
 *     server-verifier's most-tested branch, so falling through it is the
 *     safest possible MWA behavior. Default false — flip via Render env to
 *     mitigate incidents in seconds without an APK rebuild.
 *
 *   skrEnabled: surfaces Solana Mobile Seeker ($SKR) ecosystem token in the
 *     Android skill editor and the rest of the $SKR-aware UI. Auto-true when
 *     the Render server has `SKR_TOKEN_MINT` set; otherwise omitted entirely
 *     so non-Seeker deployments are unaffected.
 *
 *   skrSkillBountyActive: when true (and `skrEnabled`), waives the platform
 *     fee on Android installs of $SKR-priced skills (author keeps 100%).
 *     Operator flips off to end the bootstrap window. See SKR_SKILL_BOUNTY_ACTIVE.
 *
 *   skrSessionDefault: when true (and `skrEnabled`), the cloud session-create
 *     endpoint defaults streaming-session `tokenMint` to $SKR for Android
 *     clients that omit it. Web clients are unaffected.
 */
const STATIC_FEATURE_FLAGS: Readonly<Record<string, boolean>> = {
  forceMemoTxFallback: false,
};

function buildFeatureFlags(env: NodeJS.ProcessEnv): Readonly<Record<string, boolean>> {
  // A malformed `SKR_TOKEN_MINT` (operator typo) must NOT cause the Android
  // client to start advertising $SKR features — `readSkrMint` returns '' for
  // anything that isn't a base58 pubkey, keeping enablement consistent across
  // every $SKR-aware surface (install, recurring, streaming-session create).
  const skrConfigured = readSkrMint(env).length > 0;
  if (!skrConfigured) return STATIC_FEATURE_FLAGS;
  return Object.freeze({
    ...STATIC_FEATURE_FLAGS,
    skrEnabled: true,
    skrSkillBountyActive: isSkrSkillBountyActive(env),
    skrSessionDefault: isSkrSessionDefaultActive(env),
  });
}

export const ANDROID_REMOTE_CONFIG: AndroidRemoteConfig = {
  version: ANDROID_CONFIG_VERSION,
  walletRegistry: WALLET_REGISTRY,
  memoProofRouter: MEMO_PROOF_ROUTER,
  featureFlags: STATIC_FEATURE_FLAGS,
};

export function getAndroidRemoteConfig(env: NodeJS.ProcessEnv = process.env): AndroidRemoteConfig {
  const featureFlags = buildFeatureFlags(env);
  if (featureFlags === STATIC_FEATURE_FLAGS) return ANDROID_REMOTE_CONFIG;
  return {
    version: ANDROID_CONFIG_VERSION,
    walletRegistry: WALLET_REGISTRY,
    memoProofRouter: MEMO_PROOF_ROUTER,
    featureFlags,
  };
}
