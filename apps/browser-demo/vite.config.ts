import { defineConfig, loadEnv } from 'vite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpDevApiPlugin } from './vite.acpDevApi.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// `loadEnv` reads `.env`, `.env.local`, `.env.<mode>` and `.env.<mode>.local`
// from the project root. Used here for dev-time browser constants so
// `pnpm desktop:tauri:dev` can pick up local overrides without shell exports.
const envFromDotfiles = loadEnv(
  process.env.NODE_ENV ?? 'development',
  resolve(dirname(fileURLToPath(import.meta.url))),
  'VITE_',
);

function packageVersion(packageJsonPath: string): string {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, packageJsonPath), 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`${packageJsonPath} is missing a package version`);
  }
  return packageJson.version;
}

function browserBuildCommit(): string {
  const renderCommit = process.env.RENDER_GIT_COMMIT?.trim();
  if (renderCommit) return renderCommit.slice(0, 12);
  const explicitBuildId = process.env.AGENTIC_BUILD_ID?.trim();
  if (explicitBuildId) return explicitBuildId;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
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
const iosDeviceAgent =
  process.env.VITE_AGENTIC_IOS_DEVICE_AGENT ??
  process.env.AGENTIC_IOS_DEVICE_AGENT ??
  'false';
const deviceAgent =
  process.env.VITE_AGENTIC_DEVICE_AGENT ??
  process.env.AGENTIC_DEVICE_AGENT ??
  'false';
const browserDeviceAgent =
  process.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT ??
  'false';
// Comma list of app surfaces (web,android,ios,desktop) for which the Chat tab is
// hidden and the tab layout reverts to the pre-Chat arrangement. Baked at build;
// each running app checks its runtime-detected surface against the list.
const hideChatTab = process.env.HIDE_CHAT_TAB ?? '';
// HIDE_RESEARCH_TABS: when true/1, hides the Chat tab's read-only Research surface.
// Empty/0/false keeps it visible. Baked at build so Render can stage the feature.
const hideResearchTabs = process.env.HIDE_RESEARCH_TABS ?? '';
// HIDE_DECISION_CHECK: when true/1, hides the Chat tab's one-shot Decision Planner
// entry point while the implementation is staged. Empty/0/false keeps it visible.
const hideDecisionCheck = process.env.HIDE_DECISION_CHECK ?? '';
// CHAT_AGENT: when true/1, the Chat tab uses the new agentic chat loop; when
// empty/0/false it uses the on-device planner. Baked at build so a Render redeploy
// flips it for every surface's live bundle (no native build needed).
const chatAgent = process.env.CHAT_AGENT ?? '';
const deviceAgentWalletAllowlist =
  process.env.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ??
  process.env.AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST ??
  '';
const cloudApiBaseUrl =
  process.env.VITE_AGENTIC_CLOUD_API_BASE_URL ??
  process.env.AGENTIC_CLOUD_API_BASE_URL ??
  envFromDotfiles.VITE_AGENTIC_CLOUD_API_BASE_URL ??
  '';
const qrConnectAppUrl =
  process.env.VITE_AGENTIC_QR_CONNECT_APP_URL ??
  process.env.AGENTIC_QR_CONNECT_APP_URL ??
  envFromDotfiles.VITE_AGENTIC_QR_CONNECT_APP_URL ??
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
const walletConnectProjectId =
  process.env.VITE_AGENTIC_WC_PROJECT_ID ??
  process.env.AGENTIC_WC_PROJECT_ID ??
  envFromDotfiles.VITE_AGENTIC_WC_PROJECT_ID ??
  '';
const buildCommit = browserBuildCommit();

// In local dev the cloud workflow API (/api/session, /api/auth/*, /api/plans,
// /api/chat/*, ...) is served by the render-web Node service, not by Vite. With
// no backend the web app's same-origin `/api/session` fetch fails and Workspace
// storage shows "Cloud unavailable from this host" (the sign-in button is
// disabled). Proxy /api to a locally-running render-web (`pnpm dev:cloud`,
// in-memory store — no Postgres needed) so cloud sign-in and chat cloud-sync
// work in dev. Routes the acpDevApiPlugin already simulates in-memory are
// handled by that plugin first (it calls next() only for unhandled paths), so
// they never reach this proxy. Override the target with AGENTIC_DEV_API_PROXY.
const devCloudApiTarget = process.env.AGENTIC_DEV_API_PROXY ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [
    acpDevApiPlugin(),
    {
      name: 'agentic-build-metadata',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'agentic-build.json',
          source: JSON.stringify({
            commit: buildCommit || 'unknown',
            deployedAt: process.env.RENDER_DEPLOY_TIMESTAMP ?? null,
          }),
        });
      },
    },
  ],
  define: {
    'import.meta.env.VITE_CAPACITOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_CAPACITATOR_IOS_APP': JSON.stringify(capacitorIosApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_APP': JSON.stringify(androidApp),
    'import.meta.env.VITE_AGENTIC_TAURI_APP': JSON.stringify(tauriApp),
    'import.meta.env.VITE_AGENTIC_ANDROID_SHOW_EXAMPLE_TAB': JSON.stringify(androidShowExampleTab),
    'import.meta.env.VITE_AGENTIC_ANDROID_ALLOW_LAN_BRIDGE': JSON.stringify(androidAllowLanBridge),
    'import.meta.env.VITE_AGENTIC_ANDROID_DEVICE_AGENT': JSON.stringify(androidDeviceAgent),
    'import.meta.env.VITE_AGENTIC_IOS_DEVICE_AGENT': JSON.stringify(iosDeviceAgent),
    'import.meta.env.VITE_AGENTIC_DEVICE_AGENT': JSON.stringify(deviceAgent),
    'import.meta.env.VITE_AGENTIC_BROWSER_DEVICE_AGENT': JSON.stringify(browserDeviceAgent),
    'import.meta.env.VITE_HIDE_CHAT_TAB': JSON.stringify(hideChatTab),
    'import.meta.env.VITE_HIDE_RESEARCH_TABS': JSON.stringify(hideResearchTabs),
    'import.meta.env.VITE_HIDE_DECISION_CHECK': JSON.stringify(hideDecisionCheck),
    'import.meta.env.VITE_CHAT_AGENT': JSON.stringify(chatAgent),
    'import.meta.env.VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST': JSON.stringify(deviceAgentWalletAllowlist),
    'import.meta.env.VITE_AGENTIC_CLOUD_API_BASE_URL': JSON.stringify(cloudApiBaseUrl),
    'import.meta.env.VITE_AGENTIC_QR_CONNECT_APP_URL': JSON.stringify(qrConnectAppUrl),
    'import.meta.env.VITE_AGENTIC_APP_SURFACE': JSON.stringify(appSurface),
    'import.meta.env.VITE_AGENTIC_GA_MEASUREMENT_ID': JSON.stringify(gaMeasurementId),
    'import.meta.env.VITE_AGENTIC_WC_PROJECT_ID': JSON.stringify(walletConnectProjectId),
    __AGENTIC_CLI_RELEASE_TAG__: JSON.stringify(cliReleaseTag),
    __AGENTIC_APP_RELEASE_TAG__: JSON.stringify(appReleaseTag),
    __AGENTIC_DESKTOP_RELEASE_TAG__: JSON.stringify(desktopReleaseTag),
    __AGENTIC_ANDROID_RELEASE_TAG__: JSON.stringify(androidReleaseTag),
    __AGENTIC_BROWSER_BUILD_COMMIT__: JSON.stringify(buildCommit),
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
    strictPort: true,
    proxy: {
      // changeOrigin:false keeps the Host/Origin as 127.0.0.1:5174 so render-web's
      // same-origin/CSRF checks pass and the session cookie is scoped to the dev
      // origin (works over http; the Secure flag stays off outside production).
      '/api': { target: devCloudApiTarget, changeOrigin: false },
    },
  },
});
