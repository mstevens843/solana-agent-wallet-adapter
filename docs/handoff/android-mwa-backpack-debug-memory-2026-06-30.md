# Android MWA Backpack Debug Memory - 2026-06-30

## Scope

This note records the Android Mobile Wallet Adapter debugging path for Agentic's Backpack connect failures. It focuses on the Android TWA / WebView app package `com.agentic.wallet`, identity URI `https://agentic-signer.com`, and Backpack standalone package `app.backpack.mobile.standalone`.

The work was intentionally scoped away from iOS, desktop, browser extension, injected web wallets, and normal web wallet flows.

## Original Problem

Android MWA connect to Backpack was unreliable. The user-facing symptom was that tapping connect launched or attempted to launch Backpack, then Agentic returned an error instead of completing the authorization.

The important log context:

- Backpack standalone was installed: `app.backpack.mobile.standalone`, version `2.77.0`, version code `400`.
- Legacy Backpack package `app.backpack.mobile` was not installed.
- Agentic used identity URI `https://agentic-signer.com`.
- The cluster was `mainnet-beta`.
- Digital Asset Links fetch returned HTTP 200 with JSON content.
- Assetlinks preflight found package `com.agentic.wallet` and matched the signing certificate fingerprint.
- Android App Links state for `agentic-signer.com` was still `NONE`.

That meant the remote `assetlinks.json` file looked correct from our own fetch, but Android's OS-level domain verification state was not verified.

## First Distinct Issue: False Picker / Handoff Failure

One attempt showed a timing bug in our app, not in Backpack's approval path.

Sequence from the logs:

- Agentic started native MWA connect and opened Backpack.
- The native client saw repeated `127.0.0.1` WebSocket `ECONNREFUSED` messages while Backpack was still starting. This is noisy but not itself fatal because the client retries until the wallet local server comes up.
- Backpack eventually established an encrypted MWA session.
- Backpack completed authorization successfully:
  - `Authorize request completed successfully; issued auth`
  - auth record for identity `Agentic`, URI `https://agentic-signer.com`
- But before that result was accepted by Agentic, the JS layer had already emitted:
  - `reason="picker_dismissed" elapsedMs=5007`
- The native watchdog also produced:
  - `MWA_HANDOFF_RETURNED_WITHOUT_RESULT`

Root cause:

The JS and native watchdogs treated a valid Backpack handoff as if the Android picker had been dismissed. The old logic used a short grace window, so slow wallet startup or delayed MWA result delivery could be rejected even though Backpack later returned a valid authorization.

Fix implemented:

- Removed the WebView JS 5s picker-dismiss grace rejection from `apps/browser-demo/src/androidNative.ts`.
- Kept the hard native request timeout at 120s.
- Changed native Android watchdog discrimination in `MwaController.kt`:
  - If the host activity never reaches `onStop`, treat it as a quick picker dismissal and reject quickly as `USER_REJECTED`.
  - If the host activity reaches `onStop`, a real wallet foreground happened, so wait up to 120s for the MWA result instead of failing after about 2.5s.

Expected result:

Backpack can take several seconds to start, open its local WebSocket, complete encrypted session setup, and return authorization without Agentic falsely rejecting first.

## Second Distinct Issue: Backpack Identity Verification Failure

A later attempt showed a deeper wallet-side identity failure.

Sequence from the logs:

- Agentic preflight fetched `https://agentic-signer.com/.well-known/assetlinks.json`.
- Preflight logged success:
  - package entry found
  - namespace OK
  - relation found
  - signing fingerprint matched `11:99:47:93:2D:24:79:E3:DD:AE:C3:E4:55:6B:37:56:61:47:0D:FD:24:65:68:F6:2E:66:D7:AE:28:97:CE:EE`
- But Android App Links state was still:
  - `appLinksHostState="NONE"`
- Backpack then logged:
  - `Package verification failed for package=com.agentic.wallet, clientIdentityUri=https://agentic-signer.com`
- MWA returned:
  - `JsonRpc20RemoteException: -1/authorization request failed`
- Agentic classified it as:
  - `WALLET_IDENTITY_VERIFICATION_LIKELY`

Root cause:

Backpack appears to rely on Android's domain-verification state for the identity URI host, not only on fetching and parsing `assetlinks.json` itself. Our assetlinks file was reachable and contained the right fingerprint, but Android did not consider `agentic-signer.com` verified for `com.agentic.wallet`.

Fix implemented:

- Added a verification-only Android App Links activity:
  - `apps/android-twa/app/src/main/java/com/agentic/wallet/AppLinkVerificationActivity.kt`
- Added an always-enabled HTTPS App Links intent filter for the app's identity host in:
  - `apps/android-twa/app/src/main/AndroidManifest.xml`
- Changed the filter to host-wide verification:
  - scheme: `https`
  - host: `agentic-signer.com`
  - no path restriction
- Kept the normal web launch activity disabled, so this does not turn Agentic into a broad web fallback for normal browsing.

Expected result:

After a fresh install or OS re-verification, Android should be able to mark `agentic-signer.com` as verified or user-selected for `com.agentic.wallet`. That should satisfy Backpack's identity verification path.

## Earlier Instrumentation and Support Work

Before the final two fixes, several debugging improvements were added or refined so the logs could identify the real failure points:

- `MwaIdentityPreflight.kt` logs identity inputs before wallet launch.
- It records:
  - app package
  - identity name, URI, origin, and icon URI
  - signing certificate SHA-256 fingerprint
  - Android App Links host state
  - target wallet package and resolved package
  - Backpack standalone and legacy install/version metadata
  - `assetlinks.json` HTTP status, content type, body size, hash, and parse result
- Render server routing was adjusted so `/.well-known/assetlinks.json` is served as static Digital Asset Links JSON instead of being swallowed by generic API or `/.well-known` routing.
- Static cache control for `assetlinks.json` was kept short:
  - `public, max-age=60, must-revalidate`

These logs proved that the file content itself matched, while Android App Links state remained the remaining problem.

## Current Implementation State

Important changed files:

- `apps/android-twa/app/src/main/java/com/agentic/wallet/mwa/MwaController.kt`
  - Uses `walletForegrounded()` based on `onStop`.
  - Fast picker-dismiss watchdog only applies when no wallet foreground happened.
  - Real wallet handoff gets a 120s result window.

- `apps/browser-demo/src/androidNative.ts`
  - Removed JS focus/visibility picker-grace reject path.
  - Native callback success/reject and 120s hard timeout remain.

- `apps/android-twa/app/src/main/AndroidManifest.xml`
  - Adds host-wide App Links verification activity for `agentic-signer.com`.

- `apps/android-twa/app/src/main/java/com/agentic/wallet/AppLinkVerificationActivity.kt`
  - Immediately finishes; exists only to give Android an enabled HTTPS handler for domain verification.

- `apps/browser-demo/src/__tests__/androidSurface.test.ts`
  - Covers that Android native connect remains pending past the old 5s false-reject window.
  - Covers that the 120s hard timeout still rejects.

- `apps/android-twa/app/src/test/java/com/agentic/wallet/mwa/MwaWatchdogTest.kt`
  - Covers quick picker dismissal versus real wallet foreground behavior.

## Verification Completed

Android verification command:

```sh
apps/android-twa/gradlew -p apps/android-twa :app:processDebugMainManifest :app:compileDebugKotlin :app:testDebugUnitTest
```

Result:

- Passed.
- Debug manifest contained host-wide `agentic-signer.com` App Links verification.
- `WebLaunchActivity` remained disabled.

Browser test command:

```sh
pnpm -F @solana-agent-wallet-adapter/browser-demo test -- androidSurface
```

Result:

- Passed.
- Vitest reported all tests in that project passing.

Browser typecheck command:

```sh
pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck
```

Result:

- Passed.
- Existing warning remained that `node_modules` is not fully in sync with the lockfile.

## Latest Device Attempt: June 30, 2026 04:25 to 04:28

The latest supplied logs cover the initial handoff around `06-30 04:25:21` through `06-30 04:25:25`, plus the final failure around `06-30 04:28:38`.

What was tried:

- Retested the Android Backpack MWA handoff after the watchdog and App Links verification changes.
- Agentic attempted to connect to Backpack's local MWA WebSocket at `127.0.0.1:62544`.
- Android launched Backpack standalone via:
  - `act=android.intent.action.VIEW`
  - `dat=solana-wallet:/...`
  - `cmp=app.backpack.mobile.standalone/.MainActivity`

What the logs show:

- The MWA client initially hit repeated local WebSocket failures:
  - `ECONNREFUSED`
  - `Failed to connect to '127.0.0.1:62544'`
- This happened while Backpack was still cold-starting.
- Android then started Backpack's process:
  - `Start proc 20743:app.backpack.mobile.standalone`
- Backpack moved into foreground:
  - `state:RESUMED`
  - `foreground:app.backpack.mobile.standalone`
- Backpack loaded native libraries and app assets.
- A later slice shows the decisive MWA result:
  - `JsonRpc20RemoteException: -1/authorization request failed`
  - Agentic classified the result as `WALLET_IDENTITY_VERIFICATION_LIKELY`
  - The WebView callback was rejected with:
    - `Wallet authorization failed before approval; identity verification is likely. Check identityUri Digital Asset Links for this app package and signing certificate.`
- Backpack then closed and Android returned foreground to `com.agentic.wallet`.

Result of this attempt:

- Confirmed failure, not inconclusive.
- The old JS-side `picker_dismissed` false rejection did not appear.
- The native handoff watchdog did not appear to prematurely fail the request.
- The failure mode is now the deeper identity-verification path:
  - Backpack returned `authorization request failed`
  - Agentic surfaced `WALLET_IDENTITY_VERIFICATION_LIKELY`
- The repeated `ECONNREFUSED` lines remain expected during Backpack cold start and are not the final failure.

Interpretation:

- The timing/watchdog fix appears to have done its job: the attempt survived long enough to receive a real wallet result.
- The remaining blocker is Android/Backpack identity verification for `https://agentic-signer.com` and package `com.agentic.wallet`.
- Next evidence needed is the preflight line from this exact install showing `appLinksHostState` for `agentic-signer.com`, plus any Backpack line from `SolanaMobileDigitalAssetLinksModule` such as `Package verification failed`.

Current working conclusion:

- Agentic appears to be getting as far as it can in the MWA flow:
  - the Android handoff launches Backpack
  - the request survives long enough for Backpack to return a real JSON-RPC result
  - the old false `picker_dismissed` path is not the observed failure
- The remaining failure is Backpack rejecting authorization before user approval because identity verification does not pass from Backpack's perspective.
- If the exact installed build still reports Android App Links state `NONE`, the next local step is to force/retry Android domain verification or reinstall after the host-wide App Links manifest change.
- If Android App Links reports `VERIFIED` or `SELECTED` and Backpack still returns `authorization request failed`, this is likely as far as Agentic can take it locally. At that point Backpack likely needs to adjust or clarify its identity-verification behavior for MWA clients whose Digital Asset Links file is valid but still rejected.

## Android App Links State Check: June 30, 2026

Command run against the installed local debug build:

```sh
adb -s 10.0.0.139:34233 shell pm get-app-links --user 0 com.agentic.wallet
```

Observed output:

```text
com.agentic.wallet:
  Signatures: [11:99:47:93:2D:24:79:E3:DD:AE:C3:E4:55:6B:37:56:61:47:0D:FD:24:65:68:F6:2E:66:D7:AE:28:97:CE:EE]
  Domain verification state:
    agentic-signer.com: 1024
  User 0:
    Verification link handling allowed: true
    Selection state:
      Disabled:
        agentic-signer.com
```

Then forced re-verification:

```sh
adb -s 10.0.0.139:34233 shell pm verify-app-links --re-verify com.agentic.wallet
sleep 10
adb -s 10.0.0.139:34233 shell pm get-app-links --user 0 com.agentic.wallet
```

Result:

- No change.
- `agentic-signer.com` remained state `1024`.
- User selection remained `Disabled`.

Interpretation:

- Android still does not show the domain as clearly `verified` or user `selected` for the installed `com.agentic.wallet` build.
- The signing certificate shown by Android matches the certificate already present in `assetlinks.json`.
- Because Android user state says the host is disabled, Backpack's identity verification failure is expected from this device state.
- One remaining local check is to manually enable `agentic-signer.com` for Agentic in Android App Links settings, then retry. If enabling the domain still leaves Backpack rejecting authorization, the remaining issue is very likely Backpack-side verification behavior.

## Manual Android App Links Override: June 30, 2026

Commands run:

```sh
adb -s 10.0.0.139:34233 shell pm reset-app-links --user 0 com.agentic.wallet
adb -s 10.0.0.139:34233 shell pm set-app-links-allowed --user 0 --package com.agentic.wallet true
adb -s 10.0.0.139:34233 shell pm set-app-links --package com.agentic.wallet 2 agentic-signer.com
adb -s 10.0.0.139:34233 shell pm set-app-links-user-selection --user 0 --package com.agentic.wallet true agentic-signer.com
adb -s 10.0.0.139:34233 shell pm get-app-links --user 0 com.agentic.wallet
```

Observed output:

```text
com.agentic.wallet:
  Signatures: [11:99:47:93:2D:24:79:E3:DD:AE:C3:E4:55:6B:37:56:61:47:0D:FD:24:65:68:F6:2E:66:D7:AE:28:97:CE:EE]
  Domain verification state:
    agentic-signer.com: approved
  User 0:
    Verification link handling allowed: true
    Selection state:
      Enabled:
        agentic-signer.com
```

Interpretation:

- The local Android App Links state was successfully overridden for testing.
- This changes the device state from verifier custom error `1024` and user `Disabled` to domain `approved` and user `Enabled`.
- This is not proof that natural Android verification succeeds; it is a shell/device override.
- Next test should retry Backpack connect without reinstalling first.
- If Backpack succeeds after this override, Agentic's MWA code path is working and the remaining issue is natural Android domain verification state.
- If Backpack still returns `WALLET_IDENTITY_VERIFICATION_LIKELY` after this override, that is strong evidence Backpack is not accepting the OS-approved/user-enabled state and the remaining issue is Backpack-side identity verification behavior.

## Post-Override Backpack Retry: June 30, 2026

After Android App Links was manually overridden to:

- domain state: `approved`
- user selection: `Enabled`
- link handling allowed: `true`

Backpack connect was retried without reinstalling first.

Observed result:

- The connect attempt still failed with the same identity-verification error path:
  - `WALLET_IDENTITY_VERIFICATION_LIKELY`
  - wallet-side authorization failure before approval

Interpretation:

- This rules out the old timing/watchdog issue for this retry.
- It also makes the Android user-level App Links disabled state unlikely to be the only blocker, because the host was manually approved/enabled before retry.
- The remaining issue is now strongly likely to be Backpack's own identity-verification behavior, or a difference between Backpack's Digital Asset Links verification logic and Agentic's local preflight parser.
- To make the escalation precise, include these facts when reporting upstream:
  - Android package: `com.agentic.wallet`
  - signing SHA-256: `11:99:47:93:2D:24:79:E3:DD:AE:C3:E4:55:6B:37:56:61:47:0D:FD:24:65:68:F6:2E:66:D7:AE:28:97:CE:EE`
  - identity URI: `https://agentic-signer.com`
  - assetlinks URL: `https://agentic-signer.com/.well-known/assetlinks.json`
  - Agentic preflight confirms package/fingerprint/relation match
  - Android shell override shows `agentic-signer.com: approved` and user `Enabled`
  - Backpack still returns `authorization request failed` / `WALLET_IDENTITY_VERIFICATION_LIKELY`

## What To Check Next On Device

After installing a fresh Android build:

1. Confirm preflight no longer reports `appLinksHostState="NONE"` for `agentic-signer.com`.
2. Confirm Backpack no longer logs:
   - `Package verification failed for package=com.agentic.wallet`
3. Confirm Agentic no longer logs JS:
   - `reason="picker_dismissed"` during a real Backpack foreground.
4. Confirm a successful Backpack authorization resolves the original `connect` request instead of being rejected as:
   - `MWA_HANDOFF_RETURNED_WITHOUT_RESULT`
5. If App Links still show `NONE`, force OS re-verification or reinstall:
   - Android only verifies domains at install time or explicit verification time.

## Risk Notes

The implementation should not negatively affect other wallet providers in normal paths:

- iOS, desktop, extension, injected wallet, and normal browser flows do not use `window.AgenticAndroid.mwaRequest`.
- Other Android MWA wallets only see a longer wait after a real wallet foreground, which prevents false rejection of slow wallet results.
- Quick system picker dismissal still rejects quickly when the host never reaches `onStop`.
- The App Links change only affects Agentic's own identity host and does not alter transaction payloads, wallet discovery, signing behavior, or non-Android routes.
