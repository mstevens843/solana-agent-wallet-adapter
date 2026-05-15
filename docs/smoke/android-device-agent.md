# Android Device Agent Smoke

This smoke verifies the gated Android-native Device Agent drafting path for Seeker and Android test devices after the
runtime, bridge, provider, browser client, and integration phases have landed. Device Agent drafts only. It cannot
approve, sign, submit, or move funds. Every generated transfer must still move through Needs Approval and the installed
wallet approval flow.

## Required Test Data

- Allowlisted wallet A: `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd`
- Allowlisted wallet B: `7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w`
- Safe devnet recipient: use a wallet you control.
- Safe amount: `0.001 SOL`.
- Provider setup: OpenAI, Anthropic, Gemini, OpenRouter, or a custom OpenAI-compatible gateway key that is safe for
  development testing.

Never paste a wallet seed phrase, private key, recovery phrase, unrestricted credential, or production-only key into an
AI prompt, Device Agent field, bridge process, Render env, or support log.

## Enabled Android Or Seeker Build

Build and install the enabled APK:

```sh
pnpm android:build -- -PagenticDeviceAgent=true
adb devices
pnpm android:install -- -PagenticDeviceAgent=true
```

Expected install state:

1. `adb devices` shows the Seeker or Android test device as `device`.
2. Launching Agentic opens the native app, not the raw MWA harness.
3. Android logs include `deviceAgentEnabled=true`.

Run the Device Agent flow:

1. Launch Agentic.
2. Select `devnet` for the first smoke unless the release candidate explicitly requires another cluster.
3. Tap `Connect wallet` and approve with the installed wallet.
4. Open `Connect AI`.
5. In the route card grid, select `Device Agent AI`, or use the `AI path` picker and choose
   `Device Agent - drafts via device`.
6. Pick a provider preset and model.
7. Paste the provider key into `Device Agent key`.
8. Tap `Use key for drafts`.
9. Confirm the Device Agent status card shows `Device Agent config ready`, runtime `android-native`, and the selected
   provider/model. The key itself must not be displayed.
10. Tap `Confirm planner`.
11. Confirm the toast says `Planner confirmed` and the Device Agent status is `running`.
12. Open `New Request`.
13. Select the `Send SOL` template.
14. Enter:
    - amount: `0.001`
    - recipient: the safe devnet recipient
    - memo or note: `Device Agent smoke transfer`
15. Tap `Draft with AI`.
16. Expected draft state:
    - The browser calls Android through `AgenticAndroid.deviceAgentRequest`.
    - Android resolves `generatePlan` through the native Device Agent runtime.
    - The draft appears under `Check request`.
    - The amount, recipient, route, risk, and approval language are visible.
    - The draft says wallet approval is required before signing.
17. Tap `Ask agent`.
18. Expected review state:
    - Android resolves `reviewPlan` through the native Device Agent runtime.
    - `Agent review` appears.
    - The decision is one of approve, deny, or needs input.
    - A deny or needs-input result must block trust in the draft until corrected, but the user can still choose to send
      with an override proof.
19. Open `Ask agent about this request` and ask:

```text
Why is wallet approval still required?
```

20. Expected answer:
    - Android resolves `ask` through the native Device Agent runtime.
    - The answer says the Device Agent only drafts or reviews.
    - It does not claim to sign, submit, approve, or move funds.
21. Tap `Send for approval`.
22. Open `Needs Approval`.
23. Confirm the queued transfer shows `0.001 SOL`, the recipient, the connected wallet, and the Device Agent review
    context.
24. Tap the approval button and complete the wallet approval.
25. Expected final state:
    - Wallet approval opens in the installed wallet.
    - The wallet, not Device Agent, signs the transaction.
    - Done/proof history records the completed approval.

Fail the enabled Android smoke if any Device Agent generation path returns `agent_not_implemented`,
`Device Agent generation arrives in a later phase.`, or `Device Agent provider execution for generatePlan is not wired in
this build.` Those are incomplete integration states, not acceptable second-iteration outcomes.

## Disabled Android Build

Build and install the default disabled APK:

```sh
pnpm android:build
pnpm android:install
```

Expected state:

1. Launch Agentic.
2. Connect a wallet.
3. Open `Connect AI`.
4. `Device Agent AI` is not present in the route card grid.
5. The `AI path` picker does not include `Device Agent - drafts via device`.
6. Hosted BYOK, Android Session, and Local Bridge options still appear normally.
7. If a stale session or URL tries to force `device-agent`, the status must be unavailable with
   `Device Agent is not enabled for this build or wallet.`
8. No foreground notification named `Agentic Device Agent` should appear.

## Render Allowlist Gate

Render Device Agent is status/control only. It must never run provider calls, store provider API keys, sign, submit, or
start a cloud worker.

Use a Render or local Node web service with both runtime and browser gates enabled:

```sh
AGENTIC_DEVICE_AGENT=1 \
AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w \
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd,7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w \
pnpm render:build
```

For each allowlisted wallet:

1. Sign in to Agentic Cloud with the wallet.
2. Open `Connect AI`.
3. Confirm `Device Agent AI` is visible.
4. Select `Device Agent AI`.
5. Tap `Refresh`.
6. Expected status text: `Device Agent runtime is gated on Render; no cloud daemon is started.`
7. Enter provider/model config and tap `Use key for drafts`.
8. Expected behavior:
    - The status/control route can stage non-secret config.
    - Provider API keys are not persisted on Render.
    - `Draft with AI`, review, and ask must not run a Render Device Agent provider call.

For a non-allowlisted wallet:

1. Sign in to Agentic Cloud with a wallet that is not wallet A or wallet B.
2. Confirm `Device Agent AI` is hidden.
3. Direct status calls to `/api/device-agent/status` return 403 with `Device Agent is not enabled for this wallet.`

With `AGENTIC_DEVICE_AGENT` unset or not `1`:

1. `/api/device-agent/status` returns 403.
2. Expected error contains `Device Agent is not enabled on this server.`

## Local Bridge Regression

Device Agent and Local Bridge must remain separate routes.

```sh
pnpm dev:mobile
```

1. Open the mobile LAN URL or Android app.
2. Connect the wallet.
3. Open `Connect AI`.
4. Select `Local Bridge AI`.
5. Confirm the setup panel asks for the local runtime and shows `Check local bridge`.
6. Confirm `Local bridge not connected` appears until the local runtime is running and reachable.
7. Select `Device Agent AI`.
8. Confirm the Device Agent status card does not ask for a bridge URL or bridge token.
9. Switch back to `Local Bridge AI`.
10. Confirm the bridge URL/token and LAN/local runtime requirements are still present.

Passing state:

- Device Agent does not satisfy Local Bridge checks.
- Local Bridge does not configure or start Device Agent.
- Bridge approval requests still require the LAN/local runtime.
- Device Agent requests still stay inside the Android-native or Render-gated Device Agent boundary.

## Validator

Run the deterministic Device Agent QA gate before manual device testing:

```sh
node scripts/android-device-agent-smoke.mjs
node scripts/android-device-agent-smoke.mjs '--filter=android-*'
node scripts/android-device-agent-smoke.mjs '--filter=render-*'
```

The validator checks this document, the nested Device Agent smoke fixtures, and source-completion tripwires for the
Android bridge/provider wiring and Render status/control boundary. It fails if the
Android bridge still contains the `agent_not_implemented` generation stub or if Render grows Device Agent generation
routes.

## Log Checks

Android logs:

```sh
adb logcat | grep -iE "(AgentRuntime|Device Agent|Agentic Device Agent|AgentAndroidMWA|MainActivity)"
```

Expected:

- No provider API key appears in logs.
- No seed phrase, private key, recovery phrase, or transaction secret appears in logs.
- Device Agent config logs may include provider/model/key-present booleans only.
- Signing logs come from the wallet approval path, not the Device Agent runtime.

## Pass Criteria

- Default Android builds hide Device Agent.
- Enabled Android builds can expose and configure `Device Agent AI`.
- Enabled Android builds can draft/review/ask through the Android-native runtime.
- Source-completion tripwires fail if native generation regresses to stubbed or scaffold-only behavior.
- Render shows Device Agent only to allowlisted wallets and reports status/control only.
- Local Bridge remains a separate LAN/local runtime path.
- Every transaction still goes through `Needs Approval` and wallet approval.
