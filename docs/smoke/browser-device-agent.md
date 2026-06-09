# Browser Device Agent Smoke

This smoke verifies the gated browser-native Device Agent drafting path for desktop and mobile browsers after the
runtime, storage, provider, prompts, dispatcher, main.ts wiring, and Render status block phases have landed. Device
Agent drafts only. It cannot approve, sign, submit, or move funds. Every generated transfer must still move through
Needs Approval and the installed wallet approval flow.

## Required Test Data

- Test wallet A: `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd`
- Test wallet B: `7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w`
- Safe devnet recipient: use a wallet you control.
- Safe amount: `0.001 SOL`.
- Provider setup: OpenAI, Anthropic, Gemini, OpenRouter, or a custom OpenAI-compatible gateway key that is safe for
  development testing. Each provider is exercised once.

Never paste a wallet seed phrase, private key, recovery phrase, unrestricted credential, or production-only key into an
AI prompt, Device Agent field, bridge process, Render env, or support log.

## Enabled Browser Build

Build and serve the enabled browser bundle:

```sh
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
pnpm -F @solana-agent-wallet-adapter/browser-demo dev
```

Or for a production-style preview:

```sh
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
pnpm -F @solana-agent-wallet-adapter/browser-demo build && \
pnpm -F @solana-agent-wallet-adapter/browser-demo preview
```

Expected boot state:

1. The dev URL loads in Chrome, Edge, Firefox, and Safari without console errors.
2. The Device Agent status card reports `runtime: 'browser-native'` once the wallet is connected.
3. DevTools Application → IndexedDB lists `agentic-device-agent-secrets` with empty `ciphertext` and `stateMeta`
   stores on first run.

### Per-provider run

Repeat the steps below once per provider (OpenAI → Anthropic → Gemini → OpenRouter → custom OpenAI-compatible).

1. Open the dev URL in the browser under test.
2. Tap `Connect wallet` and approve with the test wallet.
3. Open `Connect AI`.
4. In the route card grid, select `Device Agent AI`, or use the `AI path` picker and choose
   `Device Agent - drafts via device`.
5. Pick the provider preset and model. Confirm the provider tier chip is:
    - **green** for `OpenRouter` and `Gemini` (designed for browser CORS).
    - **amber** for `OpenAI` and `Claude / Anthropic` (vendor-flagged direct-from-browser access).
    - **neutral** for `Custom OpenAI-compatible` (caller's CORS responsibility).
6. Paste the provider key into `Device Agent key`.
7. Tap `Use key for drafts`.
8. Confirm the Device Agent status card shows `Device Agent config ready`, runtime `browser-native`, and the selected
   provider/model. The key itself must not be displayed.
9. Tap `Confirm planner`.
10. Confirm the toast says `Planner confirmed` and the Device Agent status is `running`.
11. Open `New Request`.
12. Select the `Send SOL` template.
13. Enter:
    - amount: `0.001`
    - recipient: the safe devnet recipient
    - memo or note: `Device Agent smoke transfer`
14. Tap `Draft with AI`.
15. Expected draft state:
    - The browser calls the selected provider through the in-tab `fetch` + WebCrypto pipeline.
    - The runtime resolves `generatePlan` through the browser-native Device Agent executor.
    - The draft appears under `Check request`.
    - The amount, recipient, route, risk, and approval language are visible.
    - The draft says wallet approval is required before signing.
16. Tap `Ask agent`.
17. Expected review state:
    - The runtime resolves `reviewPlan` through the browser-native Device Agent executor.
    - `Agent review` appears.
    - The decision is one of approve, deny, or needs input.
    - A deny or needs-input result must block trust in the draft until corrected, but the user can still choose to send
      with an override proof.
18. Open `Ask agent about this request` and ask:

```text
Why is wallet approval still required?
```

19. Expected answer:
    - The runtime resolves `ask` through the browser-native Device Agent executor.
    - The answer says the Device Agent only drafts or reviews.
    - It does not claim to sign, submit, approve, or move funds.
20. Tap `Send for approval`.
21. Open `Needs Approval`.
22. Confirm the queued transfer shows `0.001 SOL`, the recipient, the connected wallet, and the Device Agent review
    context.
23. Tap the approval button and complete the wallet approval.
24. Expected final state:
    - Wallet approval opens in the installed wallet.
    - The wallet, not Device Agent, signs the transaction.
    - Done/proof history records the completed approval.
25. Tap `Stop runtime`.
26. Expected stop state:
    - Device Agent status returns to `stopped`.
    - In-flight requests, if any, resolve as `runtime_canceled`.
    - The status card no longer advertises `running`.
27. **Reload hydrate (encrypted IndexedDB mode)**: reload the tab.
    - Expected: runtime hydrates as `stopped` with `configured=true`.
    - The previously stored key remains available because the wrapping key is held in IndexedDB.
    - Tapping `Confirm planner` brings the runtime back to `running` without re-pasting the key.
28. **Session-only toggle**: in the Device Agent card, switch the `Secret store mode` selector to `Session only`.
    - Re-paste the provider key and tap `Use key for drafts`.
    - Confirm the toggle persists in `localStorage` under `agentic-device-agent-secret-store-mode`.
    - Reload the tab.
    - Expected: the key is gone, the status is `stopped`, and `configured=false`. The user must paste the key again.
29. Switch the toggle back to `Encrypted IndexedDB` (`main.ts:13958`) for subsequent providers.

Per-provider expectations to verify in DevTools while step 14 fires:

- **OpenAI**: outbound URL is `https://api.openai.com/v1/chat/completions`. The request omits `temperature` when the
  selected model is in the `gpt-5`, `o1`, `o3`, or `o4` family. The body includes `response_format` of
  `{ "type": "json_object" }` for plan and review, and omits it for ask.
  **Known CORS limitation:** OpenAI does not include `Access-Control-Allow-Origin` on POST responses, so the
  browser blocks the response body even when the request reaches OpenAI. Direct OpenAI calls from the browser-native
  runtime will appear to hang or fail. The OpenAI CORS probe (`--filter=openai`) exits non-zero to surface this.
  Workaround: select **OpenRouter** and use one of its `openai/*` model routes (OpenRouter has correct CORS), or
  proxy through your own backend. The amber-tier UI chip warns users; the smoke checklist should EXPECT this
  failure for direct OpenAI in step 14 until the workaround is applied.
- **Anthropic**: outbound URL is `https://api.anthropic.com/v1/messages`. The request headers include
  `anthropic-dangerous-direct-browser-access: true`, `x-api-key: <redacted>`, and `anthropic-version: 2023-06-01`.
- **Gemini**: outbound URL is `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`. The request
  authenticates via `Authorization: Bearer <redacted>`.
- **OpenRouter**: outbound URL is `https://openrouter.ai/api/v1/chat/completions`. The request authenticates via
  `Authorization: Bearer <redacted>`.
- **Custom OpenAI-compatible**: outbound URL is `<your base URL>/chat/completions`. CORS is the gateway's
  responsibility. Run the CORS probe (below) with `--base-url=<url>` before trusting this in the smoke.

Fail the enabled browser smoke if any Device Agent generation path returns `agent_not_implemented`,
`Device Agent generation arrives in a later phase.`, or `Device Agent provider execution for generatePlan is not wired in
this build.`. Those are incomplete integration states, not acceptable second-iteration outcomes.

## Disabled Browser Build

Build and serve the default disabled browser bundle:

```sh
pnpm -F @solana-agent-wallet-adapter/browser-demo build
pnpm -F @solana-agent-wallet-adapter/browser-demo preview
```

Expected state:

1. Load the preview URL in the browser.
2. Connect a wallet.
3. Open `Connect AI`.
4. `Device Agent AI` is not present in the route card grid.
5. The `AI path` picker does not include `Device Agent - drafts via device`.
6. Hosted BYOK, Browser Session, and Local Bridge options still appear normally.
7. If a stale session or URL tries to force `device-agent`, the status must be unavailable with
   `Device Agent is not enabled for this build or wallet.`
8. No service worker or background tab tries to start the browser-native runtime.

## Android Precedence

When both flags are on and the page is loaded inside the Android TWA (or any WebView that injects the
`AgenticAndroid.deviceAgentRequest` bridge), Android-native must win.

Build and install the standard Android APK with the browser flag also set:

```sh
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
pnpm android:build
pnpm android:install
```

Expected state inside the TWA:

1. `defaultDeviceAgentRuntime()` returns `'android-native'`, not `'browser-native'`.
2. The Device Agent status card shows runtime `android-native`.
3. DevTools-equivalent inspection of the TWA shows traffic flowing through the Android bridge, not through in-tab
   `fetch` calls to provider chat endpoints.
4. The browser flag is inert: toggling the browser-native `Secret store mode` selector has no effect on the Android
   Keystore-backed secret store.

## Render Gate

Render Device Agent is status/control only. It must never run provider calls, store provider API keys, sign, submit, or
start a cloud worker.

Use a Render or local Node web service with both runtime and browser gates enabled:

```sh
AGENTIC_DEVICE_AGENT=1 \
AGENTIC_BROWSER_DEVICE_AGENT=1 \
VITE_AGENTIC_DEVICE_AGENT=1 \
VITE_AGENTIC_BROWSER_DEVICE_AGENT=1 \
pnpm render:build
```

For each signed-in wallet:

1. Sign in to Agentic Cloud with the wallet.
2. Open `Connect AI`.
3. Confirm `Device Agent AI` is visible.
4. Select `Device Agent AI`.
5. Tap `Refresh`.
6. Expected status text: `Device Agent runtime is gated on Render; no cloud daemon is started.`
7. Inspect the network response for `GET /api/device-agent/status` and confirm it contains:

```json
"runtimes": { "android": false, "browserNative": true }
```

   (Or `"android": true` when `AGENTIC_ANDROID_DEVICE_AGENT` is set.)

8. Enter provider/model config and tap `Use key for drafts`.
9. Expected behavior:
    - The status/control route can stage non-secret config.
    - Provider API keys are not persisted on Render.
    - `Draft with AI`, review, and ask must not run a Render Device Agent provider call.

For any other signed-in wallet:

1. Sign in to Agentic Cloud with a wallet that is not wallet A or wallet B.
2. Confirm `Device Agent AI` is visible when the browser bundle flags are enabled.
3. Direct status calls to `/api/device-agent/status` return 200.

With `AGENTIC_DEVICE_AGENT` unset or not `1`:

1. `/api/device-agent/status` returns 403.
2. Expected error contains `Device Agent is not enabled on this server.`

With `AGENTIC_DEVICE_AGENT=1` but `AGENTIC_BROWSER_DEVICE_AGENT` unset:

1. The status response reports `"runtimes": { "android": <bool>, "browserNative": false }`.
2. The browser UI keeps showing the legacy `browser-dev` scaffold path; the browser-native runtime stays hidden.

## Local Bridge Regression

Device Agent and Local Bridge must remain separate routes.

```sh
pnpm dev:mobile
```

1. Open the mobile LAN URL or browser.
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
- Device Agent requests still stay inside the browser-native or Render-gated Device Agent boundary.

## CORS Probe

Run the network probe before manual testing whenever a provider's chat endpoint may have changed:

```sh
node scripts/browser-device-agent-cors-check.mjs
node scripts/browser-device-agent-cors-check.mjs --filter=openai
node scripts/browser-device-agent-cors-check.mjs --filter=anthropic
node scripts/browser-device-agent-cors-check.mjs --filter=gemini
node scripts/browser-device-agent-cors-check.mjs --filter=openrouter
node scripts/browser-device-agent-cors-check.mjs --filter=custom-openai-compatible --base-url=https://gateway.example.com/v1
node scripts/browser-device-agent-cors-check.mjs --json --report=build/browser-device-agent-cors-check/report.json
```

Pass criteria:

- Exit 0.
- All four vendor-managed providers (OpenRouter, Gemini, OpenAI, Anthropic) report `ok`.
- The custom OpenAI-compatible provider reports `ok` when a `--base-url` is supplied, or `warn` when it is omitted.
- No real provider API key is read by or printed from the script.

## Status Probe

Run the read-only gate-derivation probe to confirm the local bundle would compute the same runtime tier the smoke
expects:

```sh
node scripts/browser-device-agent-status.mjs
node scripts/browser-device-agent-status.mjs --env-file=apps/browser-demo/.env.local
node scripts/browser-device-agent-status.mjs --wallet=4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd
node scripts/browser-device-agent-status.mjs --is-android-app --json
```

Pass criteria:

- Exit 0.
- The printed `Derived` table shows the expected flags for the local `.env` matrix.
- For a wallet without `--is-android-app`, the effective runtime is `browser-native`.
- For the same wallet with `--is-android-app`, the effective runtime is `android-native`.
- For another wallet, the effective runtime is also `browser-native` when both browser flags are on.

## Storage Probe (private mode regression)

In a Chrome or Firefox private/incognito window where IndexedDB is unavailable or blocked by browser policy:

1. Open the dev URL with both flags on.
2. Connect a wallet.
3. Open `Connect AI` → `Device Agent AI` → paste a key → `Use key for drafts`.
4. Expected runtime behavior:
    - The configure path throws with error code `storage_unavailable`. The code is emitted by the dispatcher's
      encrypted IndexedDB store and propagated to the dispatcher response surface
      (`apps/browser-demo/src/deviceAgent/dispatcher.ts:583`).
    - The Device Agent status card renders the standard error row with that code visible. The shipped UI does **not**
      include a dedicated toast that names `Session only` — the next step is manual.
5. Manual remediation:
    - Switch the `Secret store mode` selector (`main.ts:13951`) from `Encrypted IndexedDB` to `Session only`.
    - Re-paste the provider key and tap `Use key for drafts`.
6. Expected after remediation:
    - The configure path succeeds; the runtime can be confirmed and started normally without touching IndexedDB.
    - The session-only key is held only in memory and is wiped when the tab closes (`Session only` semantics, not a
      persisted store).
    - Reloading the tab returns the status to `stopped` with `configured=false`; the key is gone.

## System Health

The Device Agent system-health card in `Connect AI` surfaces remediation copy when the browser-native runtime is in an
error state. The handler lives at `apps/browser-demo/src/systemHealth.ts:337-376` and emits the reload remediation
`Reload the tab to recover the Device Agent runtime.` whenever the dispatcher reports `state: 'error'` for the
browser-native runtime. The matching test cases are
`apps/browser-demo/src/__tests__/systemHealthDeviceAgent.test.ts:114,121,130` (running, error, and unconfigured cases).

Smoke check:

1. With the runtime in `running`, open the system-health panel and confirm the Device Agent row reports OK.
2. Force an error by reloading the tab while the runtime is mid-request (or temporarily pointing the custom OpenAI
   base URL at an unreachable host and submitting a draft).
3. Confirm the system-health row flips to the error tier with the reload remediation copy above.
4. Reload the tab; the row returns to OK or to the "Start or confirm the Device Agent runtime before generating."
   row (`main.ts:14753`) depending on whether the key is still staged.

## Source-completion Tripwires

These greps fail the smoke if Phase 5/6 ever regresses to a scaffolded stub. Mirror of the Android validator's
`agent_not_implemented` guard in `scripts/android-device-agent-smoke.mjs:60-63`:

```sh
# All four greps must return zero matches in the browser-native runtime source tree.
grep -RnF "agent_not_implemented" apps/browser-demo/src/deviceAgent || echo 'tripwire clean: agent_not_implemented'
grep -RnF "Device Agent generation arrives in a later phase." apps/browser-demo/src/deviceAgent || echo 'tripwire clean: later-phase stub'
grep -RnF "Device Agent provider execution for generatePlan is not wired in this build." apps/browser-demo/src/deviceAgent || echo 'tripwire clean: provider-not-wired stub'

# These two greps must each return a positive line count, confirming the wiring is present.
grep -nF "isBrowserNativeRuntimeAvailable" apps/browser-demo/src/deviceAgentClient.ts
grep -nF "initBrowserDeviceAgent" apps/browser-demo/src/deviceAgent/dispatcher.ts
```

If any tripwire returns scaffold text inside `apps/browser-demo/src/deviceAgent/`, fail the smoke and re-open the
relevant Phase 1–6 lane.

## Log Checks

Browser DevTools and storage inspection:

- **Console**: no provider API key string, no `sk-`, `sk-proj-`, `Bearer `, JWT-shaped token (`xxx.yyy.zzz`), or
  `x-api-key:` value appears in any console log or warning.
- **Network panel**: outbound requests carry the key in the request headers only. Any logged copy of a header or body
  through a console.log call must be redacted by the runtime's `redactSecret` helper.
- **Application → IndexedDB → `agentic-device-agent-secrets`**: the `ciphertext` store holds only `Uint8Array` IVs and
  ciphertext records. Plaintext keys must not appear. The `wrappingKey` record holds a non-extractable `CryptoKey`
  (the IndexedDB viewer typically renders it as `[object CryptoKey]` with `extractable: false`).
- **Application → Storage → Local storage / Session storage**: no provider key entries. Only the
  `agentic-device-agent-secret-store-mode` selector value is allowed.
- **Service worker / fetch logs**: the redactor patterns (`Bearer …`, `sk-…`, `sk-proj-…`, JWT-shaped, generic
  `api_key=`/`token=`/`secret=`) never leak in any captured fetch payload.

## Pass Criteria

- Default browser builds hide Device Agent.
- Enabled browser builds can expose and configure `Device Agent AI` for all 5 providers.
- Enabled browser builds can draft/review/ask through the browser-native runtime for all 5 providers.
- Provider tier chips render correctly (green for OpenRouter/Gemini, amber for OpenAI/Anthropic, neutral for custom).
- Reloading the tab hydrates the runtime as `stopped` with `configured=true` in encrypted IndexedDB mode.
- The `Session only` toggle wipes the key on tab close.
- Android-native wins when both bridges are present in the same WebView.
- Render shows Device Agent status/control to signed-in wallets and reports the `runtimes` block from
  `/api/device-agent/status`.
- Render never runs a Device Agent provider call.
- Local Bridge remains a separate LAN/local runtime path.
- Private-mode IndexedDB failure surfaces as `storage_unavailable` on the Device Agent status card; manual switch to
  `Session only` lets the runtime continue.
- No provider API key string leaks to DevTools, IndexedDB plaintext, Local storage, or Session storage.
- Every transaction still goes through `Needs Approval` and wallet approval.
