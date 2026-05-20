/**
 * Remote configuration served to the Android APK at startup. The APK ships hardcoded
 * defaults that mirror this payload byte-for-byte (see
 * `apps/android-twa/.../config/RemoteConfigDefaults.kt`) so the app continues to work
 * if the server is unreachable on first launch.
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
 */

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

export const ANDROID_REMOTE_CONFIG: AndroidRemoteConfig = {
  version: ANDROID_CONFIG_VERSION,
  walletRegistry: WALLET_REGISTRY,
  memoProofRouter: MEMO_PROOF_ROUTER,
  featureFlags: {},
};

export function getAndroidRemoteConfig(): AndroidRemoteConfig {
  return ANDROID_REMOTE_CONFIG;
}
