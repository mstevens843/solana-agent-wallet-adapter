# Agentic Browser Website

Public website and live browser workspace for Agentic, the Solana Agent Wallet Adapter. The site explains the local
signing boundary, links public CLI, desktop, and Android release paths, and keeps the existing Wallet Standard demo
available below the homepage.

## Local Development

```sh
pnpm demo:browser
```

Open `http://127.0.0.1:5174`. The workspace discovers installed Solana wallets, connects one account, signs a demo message, signs devnet memo transactions, and can talk to the local bridge when private local mode is explicitly selected.

Build the deployable browser assets with:

```sh
pnpm render:build
```

The Render build writes route fallback files for `/app`, `/docs`, `/cli`, `/desktop`, `/demo`, `/terms`, and
`/privacy`. The deployed Node service in `apps/render-web` also serves `index.html` for SPA hard refreshes and exposes
the hosted BYOK AI planning endpoint plus same-origin Agentic Cloud session/workflow APIs.

## Public CLI Paths

The website presents npm as the primary CLI path:

```sh
npm install -g @solana-agent-wallet-adapter/cli
```

Users who do not want a global install can run the local approval app through npm exec:

```sh
npm exec @solana-agent-wallet-adapter/cli -- app
```

Standalone binaries are linked from GitHub Releases with these expected asset names:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Contributor-only fallbacks stay separate from public install copy:

```sh
pnpm cli -- app
pnpm desktop:dev
```

## Desktop App

The desktop section links release artifacts from GitHub Releases with these expected asset names:

- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`

The desktop app and CLI still run locally on the user's machine. Render hosts the public website, hosted BYOK AI
planning proxy, and Agentic Cloud workflow APIs for signed-in one-time approvals.

## Android App

The Android section links GitHub Release artifacts with these expected asset names:

- `agentic-android.apk`
- `agentic-android.aab`

The canonical hosted Agentic Cloud origin is `https://agentic-signer.com`. The Android app still defaults to the bundled
Agentic app shell and keeps the legacy hosted fallback at `https://agenticwalletadapter.com/#app` behind an explicit
fallback button unless the native build overrides `AGENTIC_ANDROID_LAUNCH_URL`. The raw native Solana Mobile Wallet
Adapter controls remain available as the optional `MWA` tab with
`AGENTIC_ANDROID_SHOW_EXAMPLE_TAB=true pnpm android:install`.
Production trusted web mode still requires `/.well-known/assetlinks.json` to contain the release signing certificate fingerprint.
Generate it with:

```sh
pnpm android:assetlinks:write -- --keystore /absolute/path/agentic-release.jks --alias agentic --storepass "$AGENTIC_ANDROID_STORE_PASSWORD"
```

## Render Deployment

This app is deployed behind the same-origin Render Node service in `apps/render-web` using the root `render.yaml`
blueprint. Manual Render settings are:

- Root directory: repository root
- Runtime: Node
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Start command: `pnpm -F @solana-agent-wallet-adapter/render-web start`
- Health check path: `/api/ai/status`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- Required production env: `DATABASE_URL`, `SESSION_SECRET`, `AGENTIC_PUBLIC_ORIGIN=https://agentic-signer.com`
- Optional recurring worker env: `AGENTIC_ENABLE_WEB_SCHEDULER=1`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Production analytics env: `VITE_AGENTIC_GA_MEASUREMENT_ID=G-MJ3VZ7VEX7`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`

See [Render deployment notes](../../docs/deploy/render.md) for the full handoff.

Production should answer `200` from `/api/ai/status` and `/api/session`; a `404` there means the custom domain is still
serving a static site instead of the Node web service. Direct visits to `/app`, `/docs`, and `/demo` should return the
app shell HTML.

## Workspace Tabs

- `Agent Plan`: wallet-gated agent request flow with off-chain approval proofs and cloud-backed one-time approval queue actions when signed in.
- `Wallet Flow`: Wallet Standard discovery, account connection, message signing, transaction signing, and devnet sign-and-send.
- `Approval Inbox`: signed-in one-time cloud approvals, browser-local fallback approvals when signed out, or private local bridge approvals when selected.
- `Create Recurring`: recurring approval setup. Signed-in schedules sync to Agentic Cloud; each due occurrence lands in Approval Inbox for wallet review. Signed-out schedules stay in the browser fallback.
- `Artifacts`: `Create Artifact` and `Signed Artifacts` views for deterministic wallet-signed audit records.

## Workflow Storage Modes

- `Agentic Cloud`: the default signed-in path. The wallet signs a login message that proves ownership only; one-time drafts, approvals, and completed history sync through same-origin APIs without localhost.
- `Browser workflow`: the signed-out fallback. Drafts, queued approvals, recurring fallback data, and receipts stay in this browser on this device.
- `Private local mode`: optional local-only workflow storage. Start the CLI or desktop runtime, connect the bridge, then explicitly select private local mode in the left rail.

Android mobile web remains additive: run `pnpm dev:mobile` from the repo root, open the printed LAN URL in Android
Chrome, and `@solana-agent-wallet-adapter/mwa-mobile-web` registers Mobile Wallet Adapter as another Wallet Standard
option. Desktop extension wallets continue to work as before.
