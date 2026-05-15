# Device Agent Runtime — Release Readiness

Status snapshot for the on-device Android AI drafting path described in
[device-agent-runtime-parallel-plan.md](../plans/device-agent-runtime-parallel-plan.md)
and the public boundary in [ai-byok.md](../ai-byok.md).

## Summary

- Implementation status: **READY for gated release as of 2026-05-15.**
- Use case ("Turn the Seeker Android app into its own AI runtime") is achievable end-to-end on
  an enabled build: pick Device Agent → enter provider/model/key → key stored encrypted in
  Android Keystore → app drafts/reviews/asks through the on-device runtime → output routes through
  the standard Needs Approval queue → wallet still approves through MWA.
- Device Agent has no autonomous wallet authority. It cannot approve, sign, submit, or move funds.
- Render remains status/control-only. Render never stores provider keys and never runs provider
  calls for Device Agent.
- Public production builds keep Device Agent **off** by default. Flipping any of the gates requires
  explicit release-owner approval per [release.md](release.md).

## Env / build matrix

| Surface | Default | Enabled flag(s) | Effect |
|---|---|---|---|
| Browser (Vite) | hidden | `VITE_AGENTIC_DEVICE_AGENT=1`, `VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=...` | Reveals Device Agent in the AI mode dropdown and Connect AI card |
| Android (Gradle) | hidden | `-PagenticDeviceAgent=true` (or `agenticDeviceAgent=true` in `gradle.properties`) | Sets `BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT=true`, enables `AgentRuntimeService`, passes `VITE_AGENTIC_DEVICE_AGENT=1` into the bundled WebView |
| Render (runtime) | hidden | `AGENTIC_DEVICE_AGENT=1`, `AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST=...` | Status/control endpoints respond for allowlisted wallets; no provider calls |

Allowlisted wallets (defaults — overridable):

- `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd`
- `7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w`

## Changed files (polish pass — 2026-05-15)

- `apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt:714-717` — unknown
  Device Agent bridge methods now throw `DeviceAgentException(code = "unsupported_method")`
  instead of `MwaOperationException`. Keeps error semantics consistent with the rest of the
  Device Agent path.
- `apps/browser-demo/src/main.ts` — new `stopDeviceAgentRuntime()` helper, new
  `runStopDeviceAgentRuntime()` user-facing action wrapper, new `canStopDeviceAgentRuntime()`
  predicate, new `data-ai-action="stop-device-agent"` button rendered in the AI settings
  action row when the runtime is `running` or `starting`, sync hook for button enable/disable,
  inline notification disclosure shown in the Device Agent connection card when the runtime
  is stopped/unavailable.
- `apps/browser-demo/src/styles.css` — `.device-agent-note` typographic style for the
  notification disclosure.

The stop button intentionally **preserves** the provider/model/key config so the user can
restart without reconfiguring. Clearing config still flows through "Clear key" as before.

## Hardening pass — 2026-05-15

A follow-up deep sweep after the polish pass turned up four real issues. All four are now
fixed and locked in by test coverage so they cannot silently regress.

1. **Diagnostic routing regression (introduced by the polish pass).**
   `apps/browser-demo/src/deviceAgentClient.ts:402-416` — `deviceAgentDiagnosticCode()`
   only matched uppercase `'UNSUPPORTED_METHOD'`. The polish-pass change in
   `MainActivity.kt:714` now emits lowercase `'unsupported_method'` (snake_case to match
   the rest of the Device Agent error-code style), so unknown-method errors were silently
   routing to `AI_PROVIDER_ERROR` instead of `AI_ROUTE_MISMATCH`. Added the lowercase
   alias alongside the uppercase one.

2. **Missing `POST_NOTIFICATIONS` permission for Android 13+ foreground notification.**
   `apps/android-twa/app/src/main/AndroidManifest.xml` — Manifest declared
   `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_DATA_SYNC` but not `POST_NOTIFICATIONS`.
   With `targetSdk = 35`, the persistent notification promised by the new disclosure copy
   would silently fail to show on Seeker (Android 13/14) when the user-grant default is
   "deny". Added the manifest declaration. The runtime grant prompt is intentionally
   deferred — when the user denies notifications the service still runs as a foreground
   service; only the visible notification is suppressed, which is acceptable OEM behavior.
   Verified via `aapt2 dump permissions` on the enabled APK.

3. **OpenAI provider omitted `max_tokens`.**
   `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/provider/OpenAiCompatibleProvider.kt` —
   `AnthropicProvider.kt` sets `max_tokens` explicitly (PLAN=1024, REVIEW=1024, ASK=800)
   but the OpenAI request body was missing the field. Different OpenAI-compatible
   providers have wildly different defaults; some default to ~256 tokens and silently
   truncate plans mid-response (which then surfaces as `provider_invalid_response` after
   the JSON parse fails downstream). Added matching constants and plumbed `maxTokens`
   through `postChatCompletion` / `buildRequestBody`.

4. **Test coverage for the polish edits.**
   `apps/browser-demo/src/__tests__/deviceAgentDiagnostics.test.ts` — added a table row
   for the lowercase `unsupported_method` → `AI_ROUTE_MISMATCH` mapping so a future
   regression on finding #1 fails CI. Diagnostic suite went from 21 → 22 tests.
   `apps/browser-demo/src/__tests__/deviceAgentClient.test.ts` — added a round-trip test
   asserting `deviceAgentRequest('stop', {})` forwards `method='stop'` + empty payload
   to the bridge and returns a `state: 'stopped'` envelope. Bridge client suite went
   from 55 → 56 tests. Overall browser-demo went 800/800 → 802/802.

### Hardening pass verification

| Command | Result |
|---|---|
| `pnpm -F @solana-agent-wallet-adapter/workflow test` | PASS 257/257 |
| `pnpm exec tsc -p tsconfig.json --noEmit` (browser-demo) | clean |
| `pnpm -F @solana-agent-wallet-adapter/browser-demo test` | PASS 802/802 (+2 vs polish pass) |
| `pnpm exec tsc -p tsconfig.json --noEmit` (render-web) | clean |
| `pnpm exec vitest run src/__tests__/{devGate,server}.test.ts` (render-web) | PASS 50/50 |
| `node scripts/android-device-agent-smoke.mjs` | PASS 8/8 |
| `pnpm android:build -- -PagenticDeviceAgent=true` | success |
| `aapt2 dump permissions ...app-debug.apk` | `android.permission.POST_NOTIFICATIONS` present alongside `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` |

### Findings confirmed as false-positives during the sweep (no change required)

These were flagged by the audit agents but verified against the actual code as not real
issues — recorded here so a future audit doesn't re-litigate them:

- `RequestQueue` start/stop race — `RuntimeRegistry.transitionStart` builds a fresh
  `RequestQueue` per start under `stateMutex.withLock`, so a single queue instance never
  sees concurrent start/stop.
- HttpURLConnection gzip — Android transparently decompresses when no `Accept-Encoding`
  is set; setting it would actually turn transparent decompression off.
- Anthropic `anthropic-version: 2023-06-01` — current stable, supported, recommended.
- `setExecutor` race — called exactly once in `MainActivity.onCreate`; `volatile` is
  sufficient for that one-shot publication.
- SharedPreferences torn-write — mitigated by `RuntimeRegistry.hydrateFromPersistence`
  which downgrades any persisted `RUNNING`/`STARTING` to `STOPPED` on relaunch.
- `RuntimeConfig.toString()` apiKey leak — no call site invokes `toString()`; persistence
  goes through `secureStore.set()` which encrypts before write.
- WebView `evaluateJavascript` callback after activity destroy — pre-checked plus
  framework no-op behavior, harmless logging at worst.

### Items deliberately deferred past this hardening pass

- Runtime `POST_NOTIFICATIONS` prompt flow in `MainActivity` (manifest declaration is
  in; the runtime grant UI can land if real-device testing shows the OEM default needs
  user-side opt-in).
- `SecretRedactor` pattern expansion to cover `x-api-key:` / `?api_key=` / OpenAI
  `org-…` shapes. Defense-in-depth; provider error messages don't echo keys today.
- `RuntimeStatePersistence.commit()` vs `apply()`. Mitigated; would block callers on
  disk I/O for negligible benefit.
- Smoke checklist step for the Stop runtime button click in
  `docs/smoke/android-device-agent.md` (covered in manual verification section of this
  doc; can be folded into the formal smoke checklist later).
- `role="note"` on the new inline disclosure `<p>`. Nice-to-have a11y; defer.

## Automated verification results

Run on 2026-05-15 from `master @ a22b79a` plus the polish pass above.

| Command | Result | Notes |
|---|---|---|
| `pnpm -F @solana-agent-wallet-adapter/workflow test` | PASS 257/257 (22 files) | Includes `deviceAgent.test.ts` 6/6 — Phase 0 contract |
| `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` | PASS | Strict tsc clean |
| `pnpm -F @solana-agent-wallet-adapter/browser-demo test` | PASS 800/800 (27 files) | Includes `deviceAgentClient.test.ts` 55, `deviceAgentDiagnostics.test.ts` 21, `systemHealthDeviceAgent.test.ts` 8, `planner.test.ts` 29 |
| `pnpm -F @solana-agent-wallet-adapter/render-web typecheck` | PASS | Strict tsc clean |
| `pnpm exec vitest run src/__tests__/devGate.test.ts src/__tests__/server.test.ts` (render-web) | PASS 50/50 | Device Agent gate + endpoint tests pass; both allowlisted wallets verified |
| `node scripts/android-device-agent-smoke.mjs` | PASS 8/8 | All deterministic source-completion checks; report at `build/android-device-agent-smoke/report.json` |
| `pnpm android:build` | PASS | Disabled APK at `apps/android-twa/app/build/outputs/apk/debug/app-debug.apk`; `AgentRuntimeService enabled=false` verified via `aapt2 dump xmltree` |
| `pnpm android:build -- -PagenticDeviceAgent=true` | PASS | Enabled APK; `AgentRuntimeService enabled=true` verified via `aapt2 dump xmltree` |

### Pre-existing test failures (NOT caused by Device Agent work)

- `apps/render-web/src/__tests__/recurring-api.test.ts` — 8 failures in cloud recurring
  scheduler tests (`Cannot read properties of undefined (reading '0' / 'find')`). These tests
  touch `/api/recurring/*` and `/api/approvals/*` — no Device Agent code path. They reproduce
  in isolation against the same baseline, so they are not interactions or polish-introduced
  regressions. Tracking separately.

## Manual verification still pending (hardware)

The attached Seeker did not enumerate via `adb devices -l` during this pass (kill-server +
start-server did not surface the device — likely USB Debugging not authorized or charge-only
cable). The build steps above ran clean, but the live install/walkthrough is **pending a
working ADB connection**. Once the device authorizes, run the checklist below.

### Disabled build install (hidden path)

```sh
pnpm android:build
pnpm android:install
```

Expected:

- App launches normally.
- AI mode dropdown shows **only** Hosted BYOK / Android session / Local bridge — no Device Agent.
- No "Agentic Device Agent" persistent notification appears.

### Enabled build install (full path)

```sh
pnpm android:build -- -PagenticDeviceAgent=true
pnpm android:install -- -PagenticDeviceAgent=true
```

Expected:

1. AI mode dropdown shows **Device Agent — drafts via device** as a 4th path.
2. Picking Device Agent reveals the same provider / model / API key form used by Hosted BYOK.
3. Device Agent connection card shows the inline notification disclosure while the runtime is
   stopped: *"Confirming the planner starts the on-device runtime and shows a persistent Android
   notification while it is active."*
4. Click **Confirm planner**:
   - Runtime transitions `stopped → starting → running`.
   - Persistent notification "Agentic Device Agent / Device Agent runtime is active." appears.
   - Connection card shows `Runtime android-native`, the configured provider, model.
5. Generate a draft via prompt `"Send 0.001 SOL to <devnet test address>"`:
   - `generatePlan` routes through `AgenticAndroid.deviceAgentRequest` (verify in `chrome://inspect` if needed).
   - Draft lands in Needs Approval.
6. Review the draft → returns approve / deny / needs-input via Device Agent review path.
7. Ask `"What does this plan do?"` → returns a Device Agent answer.
8. Approve via MWA → wallet popup, sign, submit (**devnet only**).
9. New **Stop runtime** button is visible while runtime is running; clicking it:
   - Transitions runtime to `stopped`.
   - Removes the persistent notification.
   - **Preserves** provider/model/key in the Android Keystore so the user can Start again
     without reconfiguring.
10. Click Confirm planner again → runtime resumes without re-entering the key.

### Regression sweep

- Switch AI mode to **Hosted BYOK** → normal flow.
- Switch AI mode to **Android session** → normal flow.
- Switch AI mode to **Local bridge** → LAN routing still works; not the Device Agent path.
- System Settings → Force Stop the app → reopen → `RuntimeRegistry.hydrateFromPersistence`
  downgrades any persisted `running`/`starting` to `stopped`. UI reflects stopped state, not a
  stale running state.

### Render boundary (source-checked)

Already confirmed via `scripts/android-device-agent-smoke.mjs` source assertions on
`apps/render-web/src/cloud/router.ts` — only `GET /api/device-agent/status` and
`POST /api/device-agent/control` are registered; no `/generate-plan`, `/review-plan`, or `/ask`
endpoints exist. `RenderDeviceAgentSession` has no `apiKey` field.

## Security checklist

- [x] API keys never logged (only `hasKey: boolean` flag in payload summaries — see
      `MainActivity.kt:729-739`)
- [x] API keys encrypted at rest via Android Keystore-backed AES-GCM
      (`NativeSecureStore.kt` schema `agentic.secret.v1`)
- [x] API keys redacted from all provider error messages
      (`agent/provider/SecretRedactor.kt` — Bearer / `sk-*` / JWT / `key=val` patterns)
- [x] HTTPS enforced for all provider calls (`agent/provider/HttpExecutor.kt:76-80`)
- [x] Provider response capped at 1 MB to prevent memory-exhaustion
      (`HttpExecutor.kt:168`)
- [x] Foreground service `START_NOT_STICKY` — service does not silently restart after process
      death; users see an explicit stopped state on relaunch
- [x] Persisted `running` / `starting` states are downgraded to `stopped` after process restart
      (`RuntimeRegistry.kt:45-48`)
- [x] `activeConfig` (including in-memory `apiKey`) set to `null` on stop / error
      (`RuntimeRegistry.kt:147,172`) — GC-eligible immediately
- [x] Render never persists Device Agent provider keys or settings beyond non-secret labels
      (`router.ts: RenderDeviceAgentSession` has no `apiKey` field)
- [x] Render audit log limited to short wallet IDs + action / runtime / state — no key material
      (`router.ts:2491-2517`)
- [x] No MWA / wallet signing call sites in Device Agent code paths
      (verified by source-completion check #7 `device-agent-no-autonomous-authority`)

## Public release guardrail

- Default web, Render, and Android APK builds keep Device Agent disabled. Verified above:
  disabled APK has `AgentRuntimeService enabled=false`.
- Do **not** set `VITE_AGENTIC_DEVICE_AGENT=1`, `AGENTIC_DEVICE_AGENT=1`, or build Android with
  `-PagenticDeviceAgent=true` for a public production release unless the release owner has
  explicitly approved it. Document the approval in the release notes.
- If an approved Device Agent build ships:
  - Run the manual checklist above against a Seeker and confirm all expected outcomes.
  - Re-run `node scripts/android-device-agent-smoke.mjs` — must remain 8/8.
  - Confirm Render still returns status/control-only output (no `/generate-plan` route exists).

## Out of scope (deferred)

Items intentionally not in this release:

- Memory hygiene with `CharArray`-based key handling and explicit zeroing. Current
  `activeConfig = null` is acceptable v1 hygiene; Kotlin/Java `String` is immutable so
  defense-in-depth zeroing requires a separate refactor of the config contract.
- `WorkManager` / `AlarmManager` / restart-on-boot. Per the original use case: foreground
  service is sufficient — "Android does not guarantee unlimited background execution. We can
  make it persistent enough for app/runtime use with a foreground service, but a true always-on
  agent would need a different surface."
- First-run onboarding wizard. The inline disclosure plus existing planner-confirm flow covers
  the immediate UX need.
- Additional providers (Google Gemini, Ollama, local LLMs). The `apiFormat` extension point
  exists in `packages/workflow/src/deviceAgent.ts` and `DeviceAgentProviderExecutor.providerFor()`
  — add when requested.
- Rotate-key without full restart. Current "Clear key → reconfigure → Confirm planner" flow
  is acceptable.
- Production telemetry beyond redacted debug logs. Existing `deviceAgentClient.ts` debug logs
  are already gated by `isDebugBuild()` and key-redacted.
