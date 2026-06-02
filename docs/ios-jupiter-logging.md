# Jupiter iOS WalletConnect — local logging & debug workflow

This is the iOS equivalent of an `adb logcat | grep` session. It lets you watch
**every step** of the Jupiter (Reown WalletConnect) flow on a real device from a
terminal, so you can see exactly where and why a step fails — it didn't open
Jupiter, the relay never delivered, the wallet didn't bring you back, the
payload/response was wrong, etc.

> Jupiter is a real App Store wallet, so it can't be installed on the Simulator —
> **use a physical device** for the full round-trip.

## What changed (so logs actually reach the terminal)

- `AgenticIOSLog` now emits via **`NSLog`** (was `print()`), so lines appear in
  `idevicesyslog`, Console.app, **and** the Xcode console. `print()` only reached
  an attached Xcode debugger.
- Every native step in the Jupiter path logs a deterministic line:
  `[AgentIOSApp] [Component] method | STEP phase=INFO|FAIL message="…" k=v …`
- JS connect/sign steps are bridged into the same native log stream (via
  `AgenticSystem.devLog`) and appear as `[AgentIOSApp] [JS:jupiter] …`.
- Secrets are redacted by default. **Debug builds** (and any build with
  `logLevel='debug'`) additionally log full base64 payloads/signatures for a
  local session; Release builds stay redacted.

## One-time setup

```bash
brew install libimobiledevice   # provides idevicesyslog + idevice_id
```

Connect the device over USB, unlock it, and tap **Trust** when prompted.

## Build & install (via Xcode)

```bash
# from the repo root
cd apps/ios-capacitor
pnpm copy-web && pnpm sync       # copy the web build + sync the native bridge
open ios/App/App.xcodeproj       # then select your device + Run (Debug config)
# (SPM-based Capacitor: it's App.xcodeproj, not a .xcworkspace. Xcode resolves
#  the Swift packages — the bridge + reown-swift — on first open; let it finish.)
```

Building the **Debug** configuration turns on full-payload logging automatically.

## Stream the logs (the `adb logcat | grep` analog)

**Tab 1 — filtered live stream** (everything Agentic, native + JS):

```bash
./scripts/ios-jupiter-logs.sh
# equivalent to:
idevicesyslog -u "$(idevice_id -l | head -n1)" | grep --line-buffered -E "\[AgentIOSApp\]"
```

Narrow to the WalletConnect path only:

```bash
idevicesyslog -u "$(idevice_id -l | head -n1)" \
  | grep --line-buffered -E "\[AgenticWalletConnect\]|\[AgenticBridge\]|\[JS:jupiter\]|\[BridgeOrigin\]"
```

**Tab 2 — full capture to a file** (grep afterwards):

```bash
idevicesyslog -u "$(idevice_id -l | head -n1)" > /tmp/agentic-ios.log
# …reproduce the issue, Ctrl+C, then:
grep -E "\[AgentIOSApp\]" /tmp/agentic-ios.log
```

**Launch the app:** tap the icon, or `xcrun devicectl device process launch --device <UDID> com.agentic.wallet`.

### Fallbacks if `idevicesyslog` shows nothing
- **Console.app**: open it, pick your device in the sidebar, set the search to
  `process:App` or message `AgentIOSApp`, click **Start**. Zero install.
- **Xcode console**: keep the app attached and Run — the same `NSLog` lines print
  there. Stops when you detach.

## Decoder ring — each step and what a failure means

Read top-to-bottom; a healthy connect→sign produces this sequence.

| Log line (STEP) | Means | If it's missing / FAIL |
| --- | --- | --- |
| `ensureConfigured NO_PROJECT_ID` (FAIL) | `/api/mobile-config` returned no WalletConnect project id | Set `WALLETCONNECT_PROJECT_ID` in Render env; nothing else can work without it |
| `connect START` / `connect PAIRING_CREATED` | Native created the `wc:` pairing URI | No START → `ensureConfigured` failed; no PAIRING_CREATED → relay/SDK error (see `WC_RELAY_FAILED`) |
| `[JS:jupiter] connect wc_launch_done launched=true` | iOS opened Jupiter for pairing | `launched=false` → `jupiter://` not openable (Jupiter not installed / scheme) |
| `waitForSession WAITING` → `activateSession DONE` | Session settled over the relay | `waitForSession TIMEOUT` (FAIL) → user never approved, or relay never delivered the settle |
| `activateSession … peerRedirectNative=true/false` | Jupiter's own redirect (used to foreground it for requests) | both `false` → we fall back to bare `jupiter://` when foregrounding for a request |
| `sendRequest START …` (txB64Len/prefix, paramKeys) | A sign/sign-send request is being sent | shows the exact payload shape (full base64 in debug builds) |
| `sendRequest REQUEST_SENT` | Relay accepted the request | missing → `Sign.instance.request` threw (see FAIL + `WC_RELAY_FAILED`) |
| `launchCurrentWalletForRequest START`/`ATTEMPT`/`DONE` | Foregrounding Jupiter for the request | `CANDIDATE_REFUSED`/`FAIL` → iOS refused the scheme; `NO_URL` → no peer redirect and no fallback |
| `waitForResponse RESPONSE result=keys=…` | Wallet returned a signed result over the relay | `waitForResponse ERROR wcErrorCode=… ` (FAIL) → wallet **rejected** or errored; never appears → relay never delivered the response |
| `signMessage/…/RESULT` or `RESULT_MISSING_*` (FAIL) | Parsed the response | `RESULT_MISSING_*` → response present but missing the expected field (see the RESPONSE shape just above) |
| `notifyReturn POST appState=background` | Posting the tappable return notification | `SKIP_FOREGROUND` → app was already active (auto-return worked); no line → result hadn't arrived yet |
| **`AgenticBridge handleOpenUrl INBOUND_URL scheme=agenticwallet …`** | **Jupiter (or iOS) reopened Agentic** | **Never appears after approval → Jupiter did NOT bounce us back; the return notification is the path home (expected on iOS 18)** |
| `backgroundTask BEGAN/ENDED` / `EXPIRED` (FAIL) | Relay socket kept alive while in Jupiter | `EXPIRED` → app was suspended before the response arrived; it will be re-delivered when you return |
| `BridgeOrigin validate REJECT` (FAIL) | The WebView origin isn't allow-listed | Every `wc*` call is being rejected — fix the loaded origin / `AGENTIC_ALLOWED_ORIGINS` |

Key mental model: the signed result **always** arrives over the relay
(`waitForResponse RESPONSE`) regardless of app-switching. The only hard part is
*foregrounding Agentic again* — so if you see `RESPONSE` but no
`handleOpenUrl INBOUND_URL`, the signing worked and only the auto-return didn't
(the notification covers it).
