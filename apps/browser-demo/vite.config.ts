import { defineConfig, loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpDevApiPlugin } from './vite.acpDevApi.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function packageVersion(packageJsonPath: string): string {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, packageJsonPath), 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`${packageJsonPath} is missing a package version`);
  }
  return packageJson.version;
}

const capacitorIosApp =
  process.env.VITE_CAPACITOR_IOS_APP ??
  process.env.VITE_CAPACITATOR_IOS_APP ??
  process.env.CAPACITOR_IOS_APP ??
  process.env.CAPACITATOR_IOS_APP ??
  'true';
const androidApp = process.env.VITE_AGENTIC_ANDROID_APP ?? process.env.AGENTIC_ANDROID_APP ?? 'false';
const tauriApp = (() => {
  const explicit = process.env.VITE_AGENTIC_TAURI_APP ?? process.env.AGENTIC_TAURI_APP;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return process.env.TAURI_ENV_PLATFORM ? 'true' : 'false';
})();
const androidShowExampleTab =
  process.env.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB ??
  process.env.AGENTIC_ANDROID_SHOW_EXAMPLE_TAB ??
  'false';
const androidAllowLanBridge =
  process.env.VITE_AGENTIC_ANDROID_ALLOW_LAN_BRIDGE ??
  process.env.AGENTIC_ANDROID_ALLOW_LAN_BRIDGE ??
  'false';
const androidDeviceAgent =
  process.env.VITE_AGENTIC_ANDROID_DEVICE_AGENT ??
  process.env.AGENTIC_ANDROID_DEVICE_AGENT ??
  'false';
const deviceAgent =
  process.env.VITE_AGENTIC_DEVICE_AGENT ??
  process.env.AGENTIC_DEVICE_AGENT ??
  'false';
const browserDeviceAgent =
  process.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT ??
  'false';
const deviceAgentWalletAllowlist =
  process.env.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ??
  process.env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ??
  '';
const cloudApiBaseUrl =
  process.env.VITE_AGENTIC_CLOUD_API_BASE_URL ??
  process.env.AGENTIC_CLOUD_API_BASE_URL ??
  '';
const appSurface = process.env.VITE_AGENTIC_APP_SURFACE ?? process.env.AGENTIC_APP_SURFACE ?? '';
const gaMeasurementId = process.env.VITE_AGENTIC_GA_MEASUREMENT_ID ?? process.env.AGENTIC_GA_MEASUREMENT_ID ?? '';
const cliReleaseTag =
  process.env.VITE_AGENTIC_CLI_RELEASE_TAG ??
  process.env.AGENTIC_CLI_RELEASE_TAG ??
  `cli-v${packageVersion('packages/cli/package.json')}`;
const legacyAppReleaseTag = process.env.VITE_AGENTIC_APP_RELEASE_TAG ?? process.env.AGENTIC_APP_RELEASE_TAG;
const desktopReleaseTag =
  process.env.VITE_AGENTIC_DESKTOP_RELEASE_TAG ??
  process.env.AGENTIC_DESKTOP_RELEASE_TAG ??
  (legacyAppReleaseTag?.startsWith('desktop-v')
    ? legacyAppReleaseTag
    : `desktop-v${packageVersion('apps/desktop-shell/package.json')}`);
const androidReleaseTag =
  process.env.VITE_AGENTIC_ANDROID_RELEASE_TAG ??
  process.env.AGENTIC_ANDROID_RELEASE_TAG ??
  (legacyAppReleaseTag?.startsWith('v') && !legacyAppReleaseTag.startsWith('desktop-v')
    ? legacyAppReleaseTag
    : `v${packageVersion('apps/desktop-shell/package.json')}`);
const appReleaseTag = legacyAppReleaseTag ?? androidReleaseTag;
// `loadEnv` reads `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local`
// from the project root. Used here for the WalletConnect project ID so
// developers can drop it into `.env.local` without re-exporting it in their
// shell before every `pnpm desktop:tauri:dev`. The `defineConfig` callback
// receives `mode` (e.g. "development" / "production"), which `loadEnv` uses
// to pick the right `.env.<mode>` file.
const envFromDotfiles = loadEnv(
  process.env.NODE_ENV ?? 'development',
  resolve(dirname(fileURLToPath(import.meta.url))),
  'VITE_',
);
const walletConnectProjectId =
  process.env.VITE_AGENTIC_WC_PROJECT_ID ??
  process.env.AGENTIC_WC_PROJECT_ID ??
  envFromDotfiles.VITE_AGENTIC_WC_PROJECT_ID ??
  '';

export default defineConfig({
  plugins: [acpDevApiPlugin()],
  define: {
    'import.meta.env.VITE_CAPACITOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_CAPACITATOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_APP': JSON.stringify(androidApp),
    'import.meta.env.VITE_AGENTIC_TAURI_APP': JSON.stringify(tauriApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB': JSON.stringify(androidShowExampleTab),
    'import.meta.env.VITE_AGENTIC_ANDROID_ALLOW_LAN_BRIDGE': JSON.stringify(androidAllowLanBridge),
    'import.meta.env.VITE_AGENTIC_ANDROID_DEVICE_AGENT': JSON.stringify(androidDeviceAgent),
    'import.meta.env.VITE_AGENTIC_DEVICE_AGENT': JSON.stringify(deviceAgent),
    'import.meta.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT': JSON.stringify(browserDeviceAgent),
    'import.meta.env.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST': JSON.stringify(deviceAgentWalletAllowlist),
    'import.meta.env.VITE_AGENTIC_CLOUD_API_BASE_URL': JSON.stringify(cloudApiBaseUrl),
    'import.meta.env.VITE_AGENTIC_APP_SURFACE': JSON.stringify(appSurface),
    'import.meta.env.VITE_AGENTIC_GA_MEASUREMENT_ID': JSON.stringify(gaMeasurementId),
    'import.meta.env.VITE_AGENTIC_WC_PROJECT_ID': JSON.stringify(walletConnectProjectId),
    __AGENTIC_CLI_RELEASE_TAG__: JSON.stringify(cliReleaseTag),
    __AGENTIC_APP_RELEASE_TAG__: JSON.stringify(appReleaseTag),
    __AGENTIC_DESKTOP_RELEASE_TAG__: JSON.stringify(desktopReleaseTag),
    __AGENTIC_ANDROID_RELEASE_TAG__: JSON.stringify(androidReleaseTag),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('@solana/web3.js') ||
            id.includes('@noble') ||
            id.includes('bn.js') ||
            id.includes('borsh')
          ) {
            return 'solana-runtime';
          }
          if (id.includes('@solana-mobile') || id.includes('mwa-mobile-web')) {
            return 'mobile-wallet-adapter';
          }
          if (id.includes('@wallet-standard') || id.includes('wallet-standard')) {
            return 'wallet-standard';
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
  },
});
