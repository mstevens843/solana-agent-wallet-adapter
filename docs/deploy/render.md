# Deploy Agentic on Render

Agentic's public homepage is a static Vite build from `apps/browser-demo`. Render hosts the website only; the CLI,
desktop app, bridge, and wallet host run locally on the user's machine after installation. The Android app is a
Trusted Web Activity wrapper around this hosted origin.

## Blueprint Deploy

Use the root `render.yaml` as a Render Blueprint. It defines one static web service:

- Service name: `agentic`
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Publish directory: `apps/browser-demo/dist`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`
- Rewrite rule: `/*` to `/index.html`

## Manual Static Site Settings

If configuring Render manually, use:

- Root directory: repository root
- Build command: `pnpm install --frozen-lockfile --ignore-scripts && pnpm render:build`
- Publish directory: `apps/browser-demo/dist`
- Environment variable: `SKIP_INSTALL_DEPS=true`
- Production UI env: `VITE_AGENTIC_DEV_CONTROLS=false`
- Optional Android trust env: `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS`
- Production Android trust guard: `AGENTIC_ANDROID_REQUIRE_TRUST=1`
- Auto deploy: enabled for the production branch
- Redirects/Rewrites: rewrite `/*` to `/index.html`

## Release Links Used by the Website

The website links GitHub Release assets directly from:

```text
https://github.com/mstevens843/solana-agent-wallet-adapter/releases/latest/download/<asset-name>
```

Expected CLI assets:

- `solana-agent-wallet-macos-arm64.tar.gz`
- `solana-agent-wallet-macos-x64.tar.gz`
- `solana-agent-wallet-linux-x64.tar.gz`
- `solana-agent-wallet-windows-x64.zip`

Expected desktop assets:

- `agentic-desktop-macos-arm64.dmg`
- `agentic-desktop-macos-x64.dmg`
- `agentic-desktop-windows-x64.msi`
- `agentic-desktop-linux-x64.AppImage`

Expected Android assets:

- `agentic-android.apk`
- `agentic-android.aab`

Until release automation publishes those artifacts, the npm CLI path remains the primary public install path:

```sh
npm exec @solana-agent-wallet-adapter/cli -- app
```

## Android Trust File

The static site must serve Digital Asset Links at:

```text
https://agenticwalletadapter.com/.well-known/assetlinks.json
```

The checked-in file is a safe placeholder until a release signing certificate exists. Render can generate the production
file during build when this environment variable is set:

```sh
AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:..."
```

`pnpm render:prepare` writes `apps/browser-demo/public/.well-known/assetlinks.json` from that fingerprint before the
static build. If the env var is absent, the build keeps the safe placeholder and Android TWA trusted mode will not be
active.

Set `AGENTIC_ANDROID_REQUIRE_TRUST=1` for production Render builds that back an Android release. With that guard
enabled, `pnpm render:prepare` fails instead of deploying the placeholder trust file.

The native Android APK uses `https://agenticwalletadapter.com/#app` only for its explicit web fallback. Keep the Render
static rewrite rule `/*` to `/index.html` enabled so direct browser visits to client-side routes such as `/app` and
`/demo` also resolve.

## Local Verification

Before deploying, run:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm render:build
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
pnpm verify:release-links
```

Then smoke `/`, `/docs`, `/cli`, `/desktop`, `/android`, and `/demo` at desktop and mobile widths.
