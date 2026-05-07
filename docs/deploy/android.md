# Build Agentic For Android

Agentic's Android app is a Trusted Web Activity wrapper around the hosted browser app. This keeps the Solana Mobile Wallet Adapter path in Android Chrome/Chrome PWA territory instead of a generic WebView, which is important because MWA mobile web support is Android Chrome-based.

## Prerequisites

- Android SDK platform 36. The app compiles against API 36 and intentionally targets API 35, which satisfies the
  current Google Play target API requirement for new mobile apps and updates.
- Android build tools and platform tools.
- Java available on `PATH`.
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` set. On macOS, the helper defaults to `$HOME/Library/Android/sdk` when those variables are unset.

The root Android helper uses system `gradle` when available. If Gradle is not installed, it downloads Gradle into the ignored local `.gradle/agentic-android` cache.

## Commands

```sh
pnpm android:build
pnpm android:debug
pnpm android:install
```

Build a release bundle/APK:

```sh
pnpm android:release
```

Release signing is optional for local output. To sign release builds, set:

```sh
export AGENTIC_ANDROID_KEYSTORE=/absolute/path/agentic-release.jks
export AGENTIC_ANDROID_KEY_ALIAS=agentic
export AGENTIC_ANDROID_STORE_PASSWORD=...
export AGENTIC_ANDROID_KEY_PASSWORD=...
export AGENTIC_ANDROID_REQUIRE_SIGNING=1
export AGENTIC_ANDROID_VERSION_CODE=2
export AGENTIC_ANDROID_VERSION_NAME=0.1.0
pnpm android:release
```

`AGENTIC_ANDROID_VERSION_CODE` must be a positive integer. `AGENTIC_ANDROID_VERSION_NAME` is the user-visible release
label. Release builds also require `AGENTIC_ANDROID_LAUNCH_URL` to be a non-local HTTPS URL. Set
`AGENTIC_ANDROID_REQUIRE_SIGNING=1` in production CI so incomplete signing configuration fails before artifacts are
staged.

Override the hosted launch URL for a build:

```sh
pnpm android:debug -- -PagenticLaunchUrl=https://agentic.onrender.com/app
```

The default launch URL opens `/app`; set a full custom-domain URL such as `https://agenticwalletadapter.com/app` for
production releases.

For LAN testing, prefer `pnpm dev:mobile` and open the printed URL directly in Android Chrome. The packaged TWA is intended for the deployed HTTPS origin.

## Store Listing

Use `apps/android-twa/play-assets/listing.md` for the Android listing form copy. The ready-to-upload assets live beside
that file:

- dApp icon: `apps/android-twa/play-assets/icon-512.png`
- Banner: `apps/android-twa/play-assets/feature-1200x600.png`
- Preview images: `apps/android-twa/play-assets/previews/`

## Digital Asset Links

The TWA reaches full trusted mode only when the deployed origin serves:

```text
https://agentic.onrender.com/.well-known/assetlinks.json
```

The checked-in browser-demo file contains a safe placeholder fingerprint. Replace it with the release signing certificate before production deployment.

Print the debug fingerprint and ready-to-copy JSON:

```sh
pnpm android:fingerprint
```

Debug and release variants both use package id `com.agentic.wallet` so the printed JSON can be used for local debug trust testing after replacing the fingerprint.

Print a release keystore fingerprint:

```sh
pnpm android:fingerprint /absolute/path/agentic-release.jks agentic "$AGENTIC_ANDROID_STORE_PASSWORD"
```

Generate Digital Asset Links JSON without editing files:

```sh
pnpm android:assetlinks -- --keystore /absolute/path/agentic-release.jks --alias agentic --storepass "$AGENTIC_ANDROID_STORE_PASSWORD"
```

Write the deployed website's assetlinks file:

```sh
pnpm android:assetlinks:write -- --keystore /absolute/path/agentic-release.jks --alias agentic --storepass "$AGENTIC_ANDROID_STORE_PASSWORD"
pnpm android:assetlinks:verify
```

CI can also provide fingerprints directly:

```sh
AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:..." pnpm android:assetlinks:write
```

Do not ship the checked-in placeholder to production. Replace
`apps/browser-demo/public/.well-known/assetlinks.json` with the release signing certificate fingerprint before the
Render website build that backs a trusted Android release.

Render can do this during the static build when `AGENTIC_ANDROID_SHA256_CERT_FINGERPRINTS` is set in the Render
environment; `pnpm render:prepare` writes and verifies the file before Vite builds.
Set `AGENTIC_ANDROID_REQUIRE_TRUST=1` for production Render builds that back the Android release so a missing
fingerprint fails the build instead of deploying the placeholder file.

## GitHub Release Assets

The Android release workflow publishes:

- `agentic-android.apk`
- `agentic-android.aab`
- `assetlinks.json`

Set these repository secrets before running `.github/workflows/android-release.yml`:

- `AGENTIC_ANDROID_KEYSTORE_BASE64`
- `AGENTIC_ANDROID_KEY_ALIAS`
- `AGENTIC_ANDROID_STORE_PASSWORD`
- `AGENTIC_ANDROID_KEY_PASSWORD`

The workflow fails if it cannot produce a signed release APK and AAB.

## Android MWA Smoke

1. Deploy the website or run the LAN dev flow from `docs/smoke/android-mwa-web.md`.
2. Install an MWA-compatible Android wallet such as Phantom, Solflare, or Seed Vault Wallet.
3. Install the debug APK with `pnpm android:install`.
4. Launch Agentic.
5. Tap `Discover Wallets`.
6. Confirm the MWA panel says Android MWA is ready or registered.
7. Select Mobile Wallet Adapter, connect, and approve in the wallet.
8. Request message or transaction signing from the workspace.

iOS MWA and generic Android WebView wrappers are intentionally out of scope.
