# Build Agentic For Android

Agentic's Android app defaults to launching the hosted web app at `AGENTIC_ANDROID_LAUNCH_URL`. The native Solana
Mobile Wallet Adapter example host remains available behind the Android build-time flag
`AGENTIC_ANDROID_SHOW_EXAMPLE_APP=true`.

## Prerequisites

- Android SDK platform 36. The app compiles against API 36 and intentionally targets API 35, which satisfies the
  current Google Play target API requirement for new mobile apps and updates.
- Android min SDK is 24 because `com.solanamobile:mobile-wallet-adapter-clientlib-ktx:2.0.8` requires API 24 or newer.
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
pnpm android:debug -- -PagenticLaunchUrl=https://agenticwalletadapter.com/#app
```

The default launch URL opens `https://agenticwalletadapter.com/#app`. The hash route avoids static-host 404s when a
deployed site has not yet applied its client-side routing rewrite.

Switch the launcher between the regular app and the native example host:

```sh
pnpm android:install
AGENTIC_ANDROID_SHOW_EXAMPLE_APP=true pnpm android:install
pnpm android:install -- -PagenticShowExampleApp=true
```

`AGENTIC_ANDROID_SHOW_EXAMPLE_APP` defaults to `false`, so live Android builds open the regular web app. The flag is
separate from the website's `VITE_AGENTIC_DEV_CONTROLS` setting and only affects Android APKs built after the value is
set.

For LAN testing the native Android app can connect to the local bridge URL printed by `pnpm dev:mobile`. The web
fallback can still open the deployed HTTPS origin or the LAN URL in Android Chrome.

Android users can use the app planner without an AI key through templates. If they want AI planning without a
desktop bridge, they can paste a provider or gateway key into the session-only BYOK field; see `docs/ai-byok.md`.

## Store Listing

Use `apps/android-twa/play-assets/listing.md` for the Android listing form copy. The ready-to-upload assets live beside
that file:

- dApp icon: `apps/android-twa/play-assets/icon-512.png`
- Banner: `apps/android-twa/play-assets/feature-1200x600.png`
- Preview images: `apps/android-twa/play-assets/previews/`

## Digital Asset Links

The TWA reaches full trusted mode only when the deployed origin serves:

```text
https://agenticwalletadapter.com/.well-known/assetlinks.json
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

## Android Native MWA Smoke

1. Start the local bridge/browser flow with `pnpm dev:mobile` when testing bridge approvals from a phone.
2. Install an MWA-compatible Android wallet such as Phantom, Solflare, or Seed Vault Wallet.
3. Install the native example debug APK with `AGENTIC_ANDROID_SHOW_EXAMPLE_APP=true pnpm android:install`.
4. Launch Agentic.
5. Tap `Connect wallet` and approve in the installed wallet.
6. Close and relaunch Agentic. It should restore the cached authorization automatically without a button press.
7. Use `Disconnect` to return to a local idle state while keeping the cache, then `Reconnect cached` to restore it.
   Cached records include the auth token and wallet URI so later operations can route back to the intended wallet when
   the wallet supports endpoint-specific MWA links.
8. Use `Get capabilities`, `Connect + SIWS`, `Sign transaction`, and `Sign and send` with a devnet transaction payload.
9. Connect the bridge with the LAN bridge URL and token, then request a signature from the agent host.
10. Use `Clear transient`, `Full reset`, and `Clear all accounts` to verify state/cache semantics. `Full reset`
    attempts remote MWA deauthorization before clearing local cached state.

Wallet caveats match the Unity/Godot/Unreal native SDKs: Backpack uses sign-then-RPC for sign-and-send, Phantom and
Solflare may not support MWA message signing, Jupiter does not support standalone `sign_transactions`, and Phantom
native sign-and-send requires a `minContextSlot` workaround.

iOS MWA and generic Android WebView wrappers are intentionally out of scope.
