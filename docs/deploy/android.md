# Build Agentic For Android

Agentic's Android app defaults to the bundled app shell, so it opens the same Agentic Home, Docs, CLI, Desktop App,
Launch Demo, and Launch App surfaces without a browser URL bar. Production signing uses native Solana Mobile Wallet
Adapter through the Android app bridge; browser wallet injection, desktop local bridge signing, and hosted web/TWA are
fallback or development paths only. The raw native MWA controls remain available as an optional `MWA` tab behind
`AGENTIC_ANDROID_SHOW_EXAMPLE_TAB=true`, and the hosted web/TWA fallback remains disabled unless
`AGENTIC_ANDROID_ENABLE_WEB_FALLBACK=true` is set for that APK build.

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

## Android Studio

Open `apps/android-twa` as the Android Studio project. Do not open the repository root for this app; the Gradle root is
`apps/android-twa/settings.gradle.kts`, and that project imports the `:app` module.

If Android Studio opens the Run configuration with `Module: <no module>`, it is local IDE state rather than a missing
Gradle module. Wait for Gradle sync to finish, then edit the `app` run configuration:

- Module: `AgenticAndroid.app`
- Deploy: `Default APK`
- Launch: `Default Activity`

If the module list is still empty, close Android Studio, reopen `apps/android-twa`, and run **File > Sync Project with
Gradle Files**. The command-line path remains valid even when Android Studio's run configuration is stale:

```sh
pnpm android:install
```

Build a release bundle/APK:

```sh
pnpm android:release
```

Release signing is required by default for release output. Set:

```sh
export AGENTIC_ANDROID_KEYSTORE=/absolute/path/agentic-release.jks
export AGENTIC_ANDROID_KEY_ALIAS=agentic
export AGENTIC_ANDROID_STORE_PASSWORD=...
export AGENTIC_ANDROID_KEY_PASSWORD=...
export AGENTIC_ANDROID_VERSION_CODE=2
export AGENTIC_ANDROID_VERSION_NAME=0.2.1
pnpm android:release
```

`AGENTIC_ANDROID_VERSION_CODE` must be a positive integer. `AGENTIC_ANDROID_VERSION_NAME` is the user-visible release
label. Release builds also require `AGENTIC_ANDROID_LAUNCH_URL` to be a non-local HTTPS URL. Set
`AGENTIC_ANDROID_REQUIRE_SIGNING=0` only for deliberate unsigned local release diagnostics; production CI must leave
signing required.

Override the hosted fallback URL for a build:

```sh
pnpm android:debug -- -PagenticLaunchUrl=https://agentic-signer.com/app
```

The release workflow builds with `AGENTIC_ANDROID_LAUNCH_URL=https://agentic-signer.com/app`. The fallback URL is used
only when web fallback is explicitly enabled, not as the default Android launcher.

Override the Agentic Cloud API origin used by the bundled Android shell:

```sh
AGENTIC_ANDROID_CLOUD_API_BASE_URL=https://agentic-signer.com pnpm android:install
pnpm android:install -- -PAGENTIC_ANDROID_CLOUD_API_BASE_URL=https://agentic-signer.com
```

The default is `https://agentic-signer.com`. Release builds require an HTTPS cloud API origin. The bundled shell runs at
`https://agentic.local/`, so cloud storage and Hosted BYOK use bearer-authenticated cross-origin API calls instead of
same-site cookies.

Enable the hosted web/TWA fallback for a debug build:

```sh
AGENTIC_ANDROID_ENABLE_WEB_FALLBACK=true pnpm android:install
pnpm android:install -- -PagenticEnableWebFallback=true
```

`AGENTIC_ANDROID_ENABLE_WEB_FALLBACK` defaults to `false`. When false, the APK disables `WebLaunchActivity`, hides the
fallback button, and does not claim the hosted website link.

Show or hide the raw native MWA tab:

```sh
pnpm android:install
AGENTIC_ANDROID_SHOW_EXAMPLE_TAB=false pnpm android:install
pnpm android:install -- -PagenticShowExampleTab=false
```

`AGENTIC_ANDROID_SHOW_EXAMPLE_TAB` defaults to `true` for local debug/install builds and `false` for release builds.
The flag is separate from the website's `VITE_AGENTIC_DEV_CONTROLS` setting and only affects Android APKs built after
the value is set.

For LAN testing the native Android app can connect to the local bridge URL printed by `pnpm dev:mobile`. The web
fallback can still open the deployed HTTPS origin or the LAN URL in Android Chrome when
`AGENTIC_ANDROID_ENABLE_WEB_FALLBACK=true` is set for the APK build.

Enable LAN bridge access in a bundled APK when the app itself needs to call the local bridge over the phone's network:

```sh
AGENTIC_ANDROID_ALLOW_LAN_BRIDGE=true pnpm android:install
pnpm android:install -- -PagenticAllowLanBridge=true
```

This is enabled by default for debug/install builds and disabled by default for release builds. For release-candidate
APK testing against a laptop bridge, set it explicitly. The app still accepts only localhost, private LAN IPs, and
`.local` bridge hosts for cleartext HTTP bridge traffic.

Android users can use the app planner without an AI key through templates. In debug/install builds, Device Agent BYOK
is the default no-desktop-bridge AI path so provider calls run through the Android-native runtime. Release builds keep
that path hidden unless explicitly enabled and allowlisted. Android session BYOK, Hosted BYOK, and Desktop local
bridge AI remain available as alternate paths. Hosted BYOK is
available after signing in to Agentic Cloud with the connected wallet; the API key is relayed only for that request and
is not synced. See `docs/ai-byok.md`.

Device Agent is enabled by default for Android debug/install builds and disabled by default for release builds:

```sh
pnpm android:build
pnpm android:install
```

Debug builds default `AGENTIC_ANDROID_DEVICE_AGENT` on for local smoke coverage. Release builds default it off; set
`AGENTIC_ANDROID_DEVICE_AGENT=1` and `AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=...` only for an explicitly approved
Device Agent release candidate. Runtime config is stored in encrypted Android Keystore-backed storage. Device Agent
cannot approve, sign, submit, or move funds, and the wallet user still approves every transaction through the normal
flow.

Before treating an APK as Device Agent release-ready, run the Device Agent smoke and verify the native Android
bridge routes `generatePlan`, `reviewPlan`, and `ask` through the runtime queue. Any source-check failure or native
generation failure blocks Device Agent release readiness.

To build an opt-in APK for Device Agent regression testing, pass `-PagenticDeviceAgent=true` and set an explicit
allowlist. In opt-out builds, the bundled web app keeps the Device Agent AI path hidden and native Device Agent calls
report unavailable.

MWA authorization records and Android cloud bearer sessions are stored in app-private encrypted storage backed by
Android Keystore. Upgraded installs migrate the older plaintext MWA cache on first read, delete the plaintext file after
a successful encrypted write, and ask the user to reconnect if encrypted cache decryption fails.

## Store Listing

Use `apps/android-twa/play-assets/listing.md` for the Android listing form copy. The canonical ready-to-upload assets
live in `assets/agentic`:

- dApp icon: `assets/agentic/app-icon-512.png`
- Banner: `assets/agentic/banner-1200x600.png`
- Preview images: `assets/agentic/previews/`

## Digital Asset Links

The optional TWA fallback reaches full trusted mode only when the deployed origin serves:

```text
https://agentic-signer.com/.well-known/assetlinks.json
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
3. Install the native APK with `AGENTIC_ANDROID_ALLOW_LAN_BRIDGE=true pnpm android:install` for LAN bridge testing, or a signed release-candidate APK with the same flag set.
4. Launch Agentic.
5. Tap `Connect wallet` and approve in the installed wallet.
6. Close and relaunch Agentic. It should restore the cached encrypted authorization automatically without a button press.
7. Use `Disconnect` to return to a local idle state while keeping the cache, then `Reconnect cached` to restore it.
   Cached records include the auth token and wallet URI inside Android Keystore-backed encrypted storage so later
   operations can route back to the intended wallet when the wallet supports endpoint-specific MWA links.
8. Use `Get capabilities`, `Connect + SIWS`, `Sign transaction`, and `Sign and send` with a devnet transaction payload.
9. Connect the bridge with the LAN bridge URL and token, then request a signature from the agent host.
10. Use `Clear transient`, `Full reset`, and `Clear all accounts` to verify state/cache semantics. `Full reset`
    attempts remote MWA deauthorization before clearing local cached state.
11. Confirm logcat includes `native activity launched` with `mode="app_native"` and `webFallbackEnabled="false"`.

Wallet caveats match the Unity/Godot/Unreal native SDKs: Backpack uses sign-then-RPC for sign-and-send, Phantom and
Solflare may not support MWA message signing, Jupiter does not support standalone `sign_transactions`, and Phantom
native sign-and-send requires a `minContextSlot` workaround. Mainnet-beta release-candidate tests should start with
no-value memo transactions before any capped value transfer.

iOS MWA and generic Android WebView wrappers are intentionally out of scope.
