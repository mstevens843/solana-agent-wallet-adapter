# Agentic iOS Capacitor App

This is the production iOS app path while `CAPACITOR_IOS_APP=true` (or the legacy alias `CAPACITATOR_IOS_APP=true`). It wraps the `apps/browser-demo` web shell with native Capacitor plugins from `packages/ios-capacitor-bridge`, mirroring the Android TWA architecture.

Wallet transport (intentionally different from Android MWA):

- **Phantom / Solflare / Backpack** — encrypted deeplinks with `agenticwallet://callback/...`.
- **Jupiter** — WalletConnect v2 via the Reown Swift SDK (gated behind `#if canImport(WalletConnectSign)`; see "Enabling Reown" below).
- **Auth cache** — Keychain-backed via `AgenticSecureState`, with browser localStorage fallback for development.

Native plugins shipped (Capacitor 8 auto-discovers them via `packageClassList` in `ios/App/App/capacitor.config.json`):

| Plugin | Purpose |
| --- | --- |
| `AgenticSecureState` | Keychain-backed key/value store (after-first-unlock-this-device-only). |
| `AgenticBiometric` | LAContext-backed Face ID / Touch ID gating. |
| `AgenticSystem` | openExternal, systemInfo, clipboardWrite, haptic, showNotification, appLifecycleState. |
| `AgenticRemoteConfig` | Fetches `/api/mobile-config?platform=ios`, hydrates Keychain cache. |
| `AgenticDeviceAgent` | Native Swift agent runtime (Anthropic / OpenAI-compatible / Gemini providers). |
| `AgenticStreamingSession` | Ed25519 voucher signing via libsodium + Keychain. |
| `AgenticWalletConnect` | Jupiter WalletConnect v2 via Reown SDK. |

## Local dev

```sh
pnpm ios:mode      # toggle CAPACITOR_IOS_APP mode
pnpm ios:build     # build the web shell
pnpm ios:sync      # pnpm copy-web && cap sync ios (runs ensure-ios.mjs)
pnpm ios:open      # open in Xcode
```

The deployment target is iOS 16. Required for BGTaskScheduler, os.OSAllocatedUnfairLock, and the native bridge dependencies.

## Bridge tests (XCTest)

```sh
cd packages/ios-capacitor-bridge
node scripts/sync-fixtures.mjs    # copies packages/shared-test-fixtures/ into Tests/Fixtures/
xcodebuild test \
  -scheme SolanaAgentWalletAdapterIosCapacitorBridge \
  -destination 'platform=iOS Simulator,name=iPhone 15,OS=latest' \
  CODE_SIGNING_ALLOWED=NO
```

Parity assertions live in `Tests/CanonicalJSONAndVoucherTests.swift`,
`Tests/DeviceAgentSystemPromptsTests.swift`, `Tests/SecretRedactorTests.swift`,
and `Tests/Base58Tests.swift` — every assertion reads from
`packages/shared-test-fixtures/fixtures/` so Android and iOS can never silently diverge.

## Release pipeline

CI workflow: `.github/workflows/ios-release.yml`. Triggers on tags matching `v*-ios` or manual dispatch with `lane=beta|release`.

Required GitHub Actions secrets:

- `APP_STORE_CONNECT_API_KEY_BASE64` — base64-encoded `.p8` key from App Store Connect → Users and Access → Keys.
- `APP_STORE_CONNECT_API_KEY_ID` — 10-char key id.
- `APP_STORE_CONNECT_ISSUER_ID` — UUID from App Store Connect.
- `MATCH_GIT_URL` — private git repo URL holding encrypted certs/profiles.
- `MATCH_PASSWORD` — encryption password for match storage.
- `MATCH_KEYCHAIN_PASSWORD` — temp keychain password for CI runners.
- `APPLE_TEAM_ID` — 10-char team identifier.

Apple Developer capabilities must be enabled before regenerating the match
profile:

- Associated Domains for `applinks:agentic-signer.com`.
- App Group `group.com.agentic.wallet` for the Reown WalletConnect store.

The production web service must serve
`https://agentic-signer.com/.well-known/apple-app-site-association`. Configure
Render with either `AGENTIC_IOS_ASSOCIATED_APP_ID=<TEAMID>.com.agentic.wallet`
or `APPLE_TEAM_ID=<TEAMID>` plus `AGENTIC_IOS_BUNDLE_ID=com.agentic.wallet`.

Fastlane lanes (`fastlane/Fastfile`):

- `bundle exec fastlane beta` — build, sign, upload to TestFlight (no review submission).
- `bundle exec fastlane release` — beta + submit for App Store review using `fastlane/metadata/en-US` and `app-store-assets/screenshots`.
- `bundle exec fastlane screenshots` — regenerate marketing screenshots into `app-store-assets/screenshots/`.
- `bundle exec fastlane match_setup` — one-time interactive certificate setup (run locally).

## WalletConnect / Reown

The bridge package pins Reown Swift `1.0.5` so `AgenticWalletConnect` can compile for Jupiter without pulling newer AppKit/Yttrium binary artifacts. Set `WALLETCONNECT_PROJECT_ID` in the Render environment so `/api/mobile-config?platform=ios` hydrates the native project id before pairing.

## Compliance

- Privacy Manifest: `ios/App/App/PrivacyInfo.xcprivacy` covers UserDefaults, FileTimestamp, SystemBootTime, DiskSpace; Firebase AnalyticsCore is wired without IDFA/ad-personalization support.
- App Privacy questionnaire: see `app-store-assets/listing.md` — mirror Phantom/Solflare disclosure stance per stored team decision.
- Encryption export: `ITSAppUsesNonExemptEncryption=false` (standard SSL plus bundled cryptographic libraries, no custom encryption protocol).

## Switching to ios-native (legacy)

Set `CAPACITOR_IOS_APP=false` to route the root iOS scripts to the SwiftUI scaffold in `apps/ios-native`. Kept as a Swift reference for the deeplink crypto core; not the production target.
