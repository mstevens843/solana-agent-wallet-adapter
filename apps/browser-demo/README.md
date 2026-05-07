# Agentic Browser Website

Public website and live browser workspace for Agentic, the Solana Agent Wallet Adapter. The site explains the local
signing boundary, links public CLI, desktop, and Android release paths, and keeps the existing Wallet Standard demo
available below the homepage.

## Local Development

```sh
pnpm demo:browser
```

Open `http://127.0.0.1:5174`. The workspace discovers installed Solana wallets, connects one account, signs a demo message, signs devnet memo transactions, and can talk to the local bridge when a runtime is running.

Build the deployable static site with:

```sh
pnpm -F @solana-agent-wallet-adapter/browser-demo build
```

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

The desktop app and CLI still run locally on the user's machine. Render only hosts the public static website.

## Android App

The Android section links GitHub Release artifacts with these expected asset names:

- `agentic-android.apk`
- `agentic-android.aab`

The Android app defaults to launching this hosted app experience at `https://agenticwalletadapter.com/#app`. The native
Solana Mobile Wallet Adapter example host remains available for local testing with
`AGENTIC_ANDROID_SHOW_EXAMPLE_APP=true pnpm android:install`.
Production trusted web mode still requires `/.well-known/assetlinks.json` to contain the release signing certificate fingerprint.
Generate it with:

```sh
pnpm android:assetlinks:write -- --keystore /absolute/path/agentic-release.jks --alias agentic --storepass "$AGENTIC_ANDROID_STORE_PASSWORD"
```

## Render Deployment

This app is deployable as a Render Static Site using the root `render.yaml` blueprint. Manual Render settings are:

- Root directory: repository root
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Publish directory: `apps/browser-demo/dist`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`
- Rewrite rule: `/*` to `/index.html`

See [Render deployment notes](../../docs/deploy/render.md) for the full handoff.

## Workspace Tabs

- `Agent Plan`: wallet-gated agent request flow with off-chain approval proofs and bridge-backed approval queue actions.
- `Wallet Flow`: Wallet Standard discovery, account connection, message signing, transaction signing, and devnet sign-and-send.
- `Approval Inbox`: prepared actions and recurring manual-approval schedules from the local bridge.
- `Agent Labs`: deterministic wallet-signed artifacts for agent safety, policy, receipt, and outcome concepts.

Android mobile web remains additive: run `pnpm dev:mobile` from the repo root, open the printed LAN URL in Android
Chrome, and `@solana-agent-wallet-adapter/mwa-mobile-web` registers Mobile Wallet Adapter as another Wallet Standard
option. Desktop extension wallets continue to work as before.
