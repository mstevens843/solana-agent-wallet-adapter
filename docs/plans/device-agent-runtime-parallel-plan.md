# Device Agent Runtime Expanded Parallel Implementation Plan

> **Implementation status:** COMPLETE as of 2026-05-15. Polish pass (Stop runtime button,
> notification disclosure, exception-type consistency) applied on the same date. Release
> readiness snapshot lives in [docs/deploy/release-readiness-device-agent.md](../deploy/release-readiness-device-agent.md);
> public production builds keep all Device Agent gates **off** by default per
> [docs/deploy/release.md](../deploy/release.md).

## Summary

This is the handoff plan for turning the current Device Agent scaffold into a working Seeker/on-device AI drafting path.
It is designed for parallel agents with strict file ownership and clear merge order.

Default architecture: Android Device Agent v1 executes provider calls natively in Kotlin inside the Android runtime
boundary. Render remains gate/status/control only and never runs a cloud agent daemon. Browser dev remains scaffold-only
unless a future explicit browser runtime is added.

## Current Baseline

Already implemented:

- Browser AI mode union includes `device-agent`.
- The AI path dropdown and Connect AI card can show Device Agent behind env/wallet gates.
- Render exposes gated `GET /api/device-agent/status` and `POST /api/device-agent/control` scaffolding.
- Render allows only `AGENTIC_DEVICE_AGENT=1` plus allowlisted signed-in wallets.
- Android exposes `AgenticAndroid.deviceAgentStatus/configure/start/stop`.
- Android has `AgentRuntimeController` and `AgentRuntimeService` scaffolded behind `agenticDeviceAgent=true`.
- Android stores Device Agent config through the existing Keystore-backed `NativeSecureStore`.
- Device Agent generation/review/ask are intentionally not implemented yet.

## Public Interfaces And Contracts

- Keep mode string exactly `device-agent`.
- Keep gates:
  - Browser/Vite: `VITE_AGENTIC_DEVICE_AGENT=1`, `VITE_AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST`.
  - Render runtime: `AGENTIC_DEVICE_AGENT=1`, `AGENTIC_DEVICE_AGENT_WALLET_ALLOWLIST`.
  - Android build: `agenticDeviceAgent=true` / `AGENTIC_ANDROID_DEVICE_AGENT=1`.
- Shared status shape:
  - `available: boolean`
  - `enabled: boolean`
  - `configured: boolean`
  - `state: "unavailable" | "stopped" | "starting" | "running" | "error"`
  - `runtime: "android-native" | "render-gated" | "browser-dev"`
  - optional `provider`, `apiFormat`, `baseUrl`, `model`, `walletAddress`, `message`, `checkedAt`
- Add Android async bridge method:
  - `AgenticAndroid.deviceAgentRequest(requestId, method, payloadJson): void`
  - Methods: `status`, `configure`, `start`, `stop`, `generatePlan`, `reviewPlan`, `ask`
  - Native resolves through the existing WebView callback pattern with:
    - success: `{ ok: true, status, result? }`
    - failure: `{ ok: false, status, error: { code, message } }`
- Keep existing synchronous scaffold methods for compatibility:
  - `deviceAgentStatus()`
  - `deviceAgentConfigure(configJson)`
  - `deviceAgentStart(configJson)`
  - `deviceAgentStop()`
- Device Agent must never sign, submit, approve, or move funds.

## Shared Product Contract

- Device Agent drafts only. It cannot approve, sign, submit, or move funds.
- The user wallet still approves every transaction through the existing workflow.
- Device Agent must reuse the existing AI path/provider/model/key UX.
- Device Agent config must stay in the selected runtime boundary:
  - Android: app-private encrypted storage.
  - Render: gated status/control scaffold only, no cloud worker.
  - Browser dev: local scaffold state only.
- Bridge remains a separate desktop/LAN/dev route. Do not collapse Bridge and Device Agent into one mode.
- API keys are never logged, synced, stored on Render, or written to receipts.

## File Ownership Boundary Map

| Phase | Owner | Owned globs | Do not touch |
|---|---|---|---|
| 0 | Shared contract | `packages/workflow/src/deviceAgent.ts`, `packages/workflow/src/index.ts`, `packages/workflow/src/__tests__/deviceAgent.test.ts` | Android, browser app, Render |
| 1 | Android runtime worker | `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/**` | `MainActivity.kt`, browser app, Render |
| 2 | Android bridge shell | `apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt`, `apps/android-twa/app/src/main/java/com/agentic/wallet/NativeSecureStore.kt`, `apps/android-twa/app/src/main/AndroidManifest.xml`, `apps/android-twa/app/build.gradle.kts` | `agent/**`, browser app, Render |
| 3 | Android provider execution | new files under `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/provider/**`, new files under `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/prompts/**` | Android bridge shell, browser app, Render |
| 4 | Browser Device Agent client | `apps/browser-demo/src/main.ts`, `apps/browser-demo/src/devGate.ts`, `apps/browser-demo/src/planner.ts`, `apps/browser-demo/src/systemHealth.ts`, `apps/browser-demo/src/styles.css`, browser tests under `apps/browser-demo/src/__tests__/**` | Android, Render |
| 5 | Render gate/API | `apps/render-web/src/cloud/devGate.ts`, `apps/render-web/src/cloud/router.ts`, `apps/render-web/src/__tests__/devGate.test.ts`, `apps/render-web/src/__tests__/server.test.ts`, `apps/render-web/README.md` | Android, browser app |
| 6 | Runtime integration captain | one file from each completed phase only after that phase lands | broad rewrites, unrelated files |
| 7 | QA and smoke | `docs/smoke/android-device-agent.md`, new `scripts/android-device-agent*.mjs`, new `spec/evals/device-agent/**` | app source files |
| 8 | Docs/release | `docs/ai-byok.md`, `docs/deploy/android.md`, `docs/deploy/render.md`, `docs/deploy/release.md`, this plan file | app source files |
| 9 | Final coordinator | Any file required to resolve final integration conflicts after Phases 0-8 land | feature expansion, new architecture decisions |

## Non-Overlap Rules

- Each agent must stay inside its owned globs.
- If a change needs another phase's file, write `BLOCKED:` in the final report instead of editing across the line.
- Do not make global formatting changes.
- Do not rename the `device-agent` mode string.
- Do not change existing `hosted`, `session`, or `bridge` behavior while implementing Device Agent.
- Do not add wallet signing, transaction submission, or autonomous approval authority to Device Agent.

## Phase 0 - Shared Contract Foundation

Owner: contract agent.

Files:

- `packages/workflow/src/deviceAgent.ts`
- `packages/workflow/src/index.ts`
- `packages/workflow/src/__tests__/deviceAgent.test.ts`

Implement:

- Add shared TypeScript types and parsers for Device Agent status, config, request envelopes, response envelopes, and
  error envelopes.
- Export the contract from workflow.
- Keep the contract platform-neutral: no Android, Render, DOM, or provider-specific dependencies.
- Define canonical method names: `status`, `configure`, `start`, `stop`, `generatePlan`, `reviewPlan`, `ask`.

Required contract names:

- `DeviceAgentRuntimeState`
- `DeviceAgentRuntimeKind`
- `DeviceAgentStatus`
- `DeviceAgentConfig`
- `DeviceAgentMethod`
- `DeviceAgentRequestEnvelope`
- `DeviceAgentSuccessEnvelope`
- `DeviceAgentErrorEnvelope`
- `DeviceAgentResponseEnvelope`
- `parseDeviceAgentStatus`
- `parseDeviceAgentResponseEnvelope`

Done when:

- Contract tests cover valid status, invalid status, success envelope, error envelope, and missing fields.
- No browser/render/android behavior changes yet.

## Phase 1 - Android Runtime Worker

Owner: Android runtime agent.

Files:

- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/AgentRuntimeController.kt`
- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/AgentRuntimeService.kt`
- new files under `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/runtime/**`

Implement:

- Add a real runtime state machine: `stopped`, `starting`, `running`, `error`.
- Add an in-memory request queue for `generatePlan`, `reviewPlan`, and `ask`.
- Persist only runtime state metadata in SharedPreferences.
- Keep provider keys only in `NativeSecureStore`.
- Add lifecycle-safe start/stop behavior for foreground service.
- Runtime worker must not call any MWA signing or transaction submission APIs.

Runtime behavior:

- `start` loads encrypted config, validates provider/model/key presence, sets `starting`, starts service, then sets
  `running` or `error`.
- `stop` cancels queued work, stops service, and sets `stopped`.
- `configure` stores encrypted config and does not start provider calls.
- Failed provider execution sets the request result error but does not stop the service unless the config is invalid.

Done when:

- Start/stop works through controller.
- Status survives Activity recreation.
- Disabled build reports unavailable without starting service.
- No broad permissions added beyond current foreground service needs.

## Phase 2 - Android WebView Bridge Shell

Owner: Android shell agent.

Files:

- `apps/android-twa/app/src/main/java/com/agentic/wallet/MainActivity.kt`
- `apps/android-twa/app/src/main/java/com/agentic/wallet/NativeSecureStore.kt`
- `apps/android-twa/app/src/main/AndroidManifest.xml`
- `apps/android-twa/app/build.gradle.kts`

Implement:

- Add `deviceAgentRequest(requestId, method, payloadJson): void`.
- Reuse the existing callback resolution style already used by Android MWA requests.
- Validate request IDs, method names, payload size, and secure-store keys.
- Keep `DEVICE_AGENT_CONFIG_KEY` allowlisted only for Device Agent config.
- Ensure `agenticDeviceAgent=true` passes Vite flags into bundled web build.

Method handling:

- `status`: return status envelope.
- `configure`: validate and store config, return status envelope.
- `start`: start runtime, return status envelope.
- `stop`: stop runtime, return status envelope.
- `generatePlan`, `reviewPlan`, `ask`: enqueue runtime work and resolve callback with normalized result.

Done when:

- JS can call async status/configure/start/stop/generate/review/ask.
- Disabled builds reject calls with structured unavailable errors.
- No broad Android permissions added.

## Phase 3 - Android Native Provider Execution

Owner: provider agent.

Files:

- new files under `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/provider/**`
- new files under `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/prompts/**`

Implement:

- Kotlin provider clients for:
  - OpenAI-compatible chat completions.
  - Anthropic Messages API.
- Use `HttpURLConnection` or existing Android standard APIs; do not add a dependency unless absolutely required.
- Port only the prompt behavior needed for Device Agent plan/review/ask.
- Return normalized JSON matching existing browser workflow expectations.
- Redact API keys from all logs and errors.

Provider requirements:

- OpenAI-compatible request uses configured `baseUrl`, `model`, and bearer key.
- Anthropic request uses configured `baseUrl`, `model`, and `x-api-key`.
- Network timeout must fail with structured error code `provider_timeout`.
- HTTP 401/403 must fail with `provider_auth`.
- HTTP 429 must fail with `provider_rate_limited`.
- Any response parse failure must fail with `provider_invalid_response`.

Done when:

- Device Agent can produce a valid plan from a simple transfer prompt.
- Review returns approve/deny/needs-input in existing app shape.
- Ask returns an answer string and optional citations.

## Phase 4 - Browser Device Agent Client

Owner: browser agent.

Files:

- `apps/browser-demo/src/main.ts`
- `apps/browser-demo/src/devGate.ts`
- `apps/browser-demo/src/planner.ts`
- `apps/browser-demo/src/systemHealth.ts`
- `apps/browser-demo/src/styles.css`
- browser tests under `apps/browser-demo/src/__tests__/**`

Implement:

- Replace scaffold generation errors with calls to Android `deviceAgentRequest`.
- Keep Render and browser-dev Device Agent as scaffold/status-only.
- Keep same Connect AI card, dropdown, provider, model, key, confirm flow.
- Add a small typed client helper if `main.ts` grows too much.
- Preserve existing behavior for hosted/session/bridge.

Browser behavior:

- Android enabled runtime: generation/review/ask call native Device Agent.
- Android disabled runtime: Device Agent hidden unless forced by dev env; calls return unavailable.
- Render allowlisted wallet: Device Agent can show status/control scaffold but cannot generate.
- Browser local dev: Device Agent can show scaffold if gated but cannot generate.

Done when:

- Enabled Android build can create drafts through Device Agent.
- Non-Android browser dev does not pretend generation works.
- Device Agent hidden when gates are off.
- Existing Hosted BYOK, Browser Session, and Local Bridge tests still pass.

## Phase 5 - Render Gate/API Hardening

Owner: Render agent.

Files:

- `apps/render-web/src/cloud/devGate.ts`
- `apps/render-web/src/cloud/router.ts`
- `apps/render-web/src/__tests__/devGate.test.ts`
- `apps/render-web/src/__tests__/server.test.ts`
- `apps/render-web/README.md`

Implement:

- Keep `/api/device-agent/status` and `/api/device-agent/control` gated by runtime env and allowlisted session wallet.
- Ensure Render never stores provider keys.
- Ensure Render never executes provider calls for Device Agent.
- Add structured audit/log events that include wallet short IDs and action names only, no key material.
- If router grows too large, split Device Agent handlers into a route module owned by this phase.

Done when:

- Env off returns 403.
- Wrong wallet returns 403.
- Both allowlisted wallets can use status/control.
- Render status says no cloud daemon is started.
- No provider key is persisted on Render.

## Phase 6 - Runtime Integration Captain

Owner: integration agent.

Files:

- May touch one file from each completed phase only after that phase lands.

Implement:

- Wire Android runtime queue to native provider executor.
- Wire browser Device Agent client to async Android bridge method.
- Confirm status/config/start/generate/review/ask end-to-end.
- Resolve naming drift between TypeScript contract and Kotlin mirrored JSON.
- Remove scaffold-only errors from Android-enabled runtime path only.

Done when:

- One Android enabled APK can select Device Agent, confirm planner, generate a draft, review it, and ask a question.
- Bridge, Hosted BYOK, and Session modes still pass existing tests.
- Render and browser-dev still report scaffold-only for Device Agent generation.

## Phase 7 - QA, Smoke, And Seeker Checklist

Owner: QA agent.

Files:

- `docs/smoke/android-device-agent.md`
- new `scripts/android-device-agent*.mjs`
- new `spec/evals/device-agent/**`

Implement:

- Add manual Seeker test checklist:
  - build enabled APK
  - install
  - connect wallet
  - select Device Agent
  - configure key/model
  - confirm planner
  - generate simple transfer draft
  - send to Needs Approval
  - approve via wallet
- Add disabled-build checklist proving Device Agent is hidden.
- Add Render allowlist checklist for both wallet addresses.
- Add regression checklist proving Bridge still requires LAN/local runtime and remains separate.

Done when:

- A tester can run the checklist without asking engineering questions.
- The checklist includes expected UI labels and expected failure states.

## Phase 8 - Docs And Release Guardrails

Owner: docs agent.

Files:

- `docs/ai-byok.md`
- `docs/deploy/android.md`
- `docs/deploy/render.md`
- `docs/deploy/release.md`
- `docs/plans/device-agent-runtime-parallel-plan.md`

Implement:

- Document Device Agent as Android-native dev-gated path.
- Document that Render Device Agent is status/control only.
- Document enabled build commands:
  - `pnpm android:build -- -PagenticDeviceAgent=true`
  - `pnpm android:install -- -PagenticDeviceAgent=true`
- Add release guardrail: public production builds keep Device Agent disabled unless explicitly approved.
- Keep docs clear that Device Agent cannot approve/sign/submit.
- Keep docs clear that Local Bridge remains separate from Device Agent and is not required for Android-native runtime
  work.

Done when:

- Docs distinguish Hosted BYOK, Browser/Android Session, Local Bridge, and Device Agent without overlap.
- Release docs include an explicit public-production guardrail for `VITE_AGENTIC_DEVICE_AGENT`,
  `AGENTIC_DEVICE_AGENT`, and `agenticDeviceAgent=true`.

Second-iteration status:

- Phase 8 docs/release guardrails are complete when the docs describe the current runtime truth, not only the intended
  final state.
- The Device Agent smoke source-completion scenario guards Android `generatePlan`, `reviewPlan`, and `ask` wiring plus
  the Render status/control-only boundary.

## Phase 9 - Final Coordinator And Release Readiness

Owner: Codex/lead coordinator. Do not assign this to a parallel implementation agent.

Files:

- Any file required to resolve final integration conflicts after Phases 0-8 land.

Implement:

- Collect the final reports from Phases 0-8.
- Check every phase stayed inside its owned file boundary.
- Resolve merge conflicts and naming drift only after the owning phase has completed.
- Run the full final test plan.
- Install the enabled Android build on Seeker when a device is attached.
- Produce the final release/readiness report with:
  - changed files by subsystem
  - enabled/disabled env matrix
  - known limitations
  - Seeker install result
  - tests run and failures, if any

Rules:

- Do not introduce new feature scope.
- Do not redesign the runtime architecture.
- Do not loosen Device Agent gates.
- Do not make Render run provider calls.
- If a phase is incomplete, mark it incomplete and stop rather than filling in large missing work under Phase 9.

Done when:

- All phase outputs are integrated.
- Final tests pass or failures are documented with exact blocker.
- The Seeker install path is verified or blocked only by no attached device.
- The repo has one clear final status for Device Agent readiness.

## Suggested Parallel Assignment

- Agent 0: Phase 0 shared contract.
- Agent 1: Phase 1 Android runtime worker.
- Agent 2: Phase 2 Android bridge shell.
- Agent 3: Phase 3 Android provider execution.
- Agent 4: Phase 4 browser client.
- Agent 5: Phase 5 Render gate/API.
- Agent 6: Phase 7 QA and smoke.
- Agent 7: Phase 8 docs/release.
- Integration captain: Phase 6 after Phases 0-5 land.
- Codex/lead: Phase 9 final coordinator after Phases 0-8 land.

If more agents are available, split Phase 3 by provider format and Phase 7 by automated checks vs Seeker manual
checklist.

## Merge Order

Development can happen in parallel, but merge in this order:

1. Phase 0 shared contract.
2. Phase 1 Android runtime worker.
3. Phase 2 Android bridge shell.
4. Phase 3 Android native provider execution.
5. Phase 4 browser Device Agent client.
6. Phase 5 Render gate/API.
7. Phase 6 runtime integration captain.
8. Phase 7 QA and smoke.
9. Phase 8 docs/release.
10. Phase 9 final coordinator and release readiness.

## Test Plan

Required commands before final merge:

- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck`
- `pnpm -F @solana-agent-wallet-adapter/render-web typecheck`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo test`
- `pnpm -F @solana-agent-wallet-adapter/render-web test`
- `pnpm android:build`
- `pnpm android:build -- -PagenticDeviceAgent=true`
- `adb devices`
- `pnpm android:install -- -PagenticDeviceAgent=true` when Seeker is attached

Required scenarios:

- Device Agent hidden by default.
- Device Agent visible in enabled Android build.
- Render Device Agent visible only for:
  - `4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd`
  - `7etjMSp87AUE135iW5dNeKridbW16rwSFVUN9ivfFm3w`
- Device Agent can generate a simple SOL transfer draft on Android.
- Device Agent review can approve, deny, and request input.
- Device Agent ask can answer a question about the generated plan.
- Local Bridge still works as its own route and is not required for Device Agent.
- Hosted BYOK and Session AI still work as before.

## Final Acceptance Criteria

- Default web, Render, and Android builds keep Device Agent hidden.
- Enabled Android build shows Device Agent and can execute draft/review/ask through the native runtime.
- Render deployed build shows Device Agent only to allowlisted wallets when both runtime and Vite envs are enabled.
- Render deployed build never runs a Device Agent provider call.
- Bridge still works as its own desktop/LAN/dev path.
- All existing AI paths keep passing tests.
- Device Agent cannot approve, sign, submit, or move funds.
- `git diff --check` is clean.

## Assumptions And Defaults

- Android Device Agent v1 uses Kotlin native provider execution, not Node, not the desktop bridge.
- Render remains gate/status/control only and never runs the agent worker.
- Browser non-Android Device Agent remains scaffold-only unless a future explicit runtime is added.
- Provider support for v1 is OpenAI-compatible plus Anthropic.
- No autonomous wallet authority is introduced.
- API keys are never logged, synced, stored on Render, or written to receipts.
