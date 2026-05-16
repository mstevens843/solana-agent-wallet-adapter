# Browser-Native Device Agent Runtime — Parallel Implementation Plan

> **Implementation status:** COMPLETE and workspace-green as of 2026-05-16. Phases 0-9 landed with
> parallel agents and independent file ownership; workspace verification (browser-demo typecheck +
> tests, render-web typecheck + tests, render-web build, prod browser build with gates on) is clean.
> Public production builds keep `VITE_AGENTIC_BROWSER_DEVICE_AGENT` and `AGENTIC_BROWSER_DEVICE_AGENT`
> **unset** by default per [docs/deploy/release.md](../deploy/release.md). Operator and provider
> guidance lives in [docs/deploy/browser-device-agent.md](../deploy/browser-device-agent.md); the
> manual verification path is [docs/smoke/browser-device-agent.md](../smoke/browser-device-agent.md).
>
> **Known limitation (OpenAI direct-from-browser):** `scripts/browser-device-agent-cors-check.mjs`
> confirms OpenAI's `/v1/chat/completions` does not return `access-control-allow-origin` on POST
> responses, so direct browser calls will be blocked by the browser regardless of the
> `dangerouslyAllowBrowser` SDK flag. The amber-tier UI chip correctly warns users; OpenAI models
> are reachable via OpenRouter (green tier) or a server proxy. This is provider behavior, not a
> bug in the runtime.
> **Companion of:** [docs/plans/device-agent-runtime-parallel-plan.md](./device-agent-runtime-parallel-plan.md)
> (Android-native v1, completed 2026-05-15).

## Context

The Android-native Device Agent runtime shipped on 2026-05-15. It runs OpenAI/Anthropic provider calls natively from inside the Android app using Kotlin HTTP clients. On browser/desktop today, Device Agent is **scaffold-only** — the dropdown shows the mode, but generation throws because there's no runtime.

This plan adds a **second, fully working Device Agent runtime** that lives entirely in the browser tab, parallel to (not replacing) the Android one. It mirrors the Kotlin runtime byte-for-byte on the contract surface — same state machine, same FIFO queue, same prompts, same response parser, same secret redactor, same `provider_*` error codes — but uses `fetch()` + WebCrypto + IndexedDB instead of `HttpURLConnection` + Keystore + SharedPreferences.

All 5 providers in `apps/browser-demo/src/planner.ts:50` are reachable from browser:
- **OpenRouter** ✅ designed for browser CORS — recommended tier
- **Gemini** (via OpenAI-compat endpoint) ✅ Google supports CORS — recommended tier
- **OpenAI** ⚠️ works with `Authorization: Bearer` from browser (vendor-flagged dangerous) — amber tier
- **Anthropic** ⚠️ works with `anthropic-dangerous-direct-browser-access: true` header (vendor-flagged dangerous) — amber tier
- **Custom OpenAI-compat** — caller's CORS responsibility — neutral tier

Decisions (locked):
- **Gate:** new `VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` flag, independent of existing flags.
- **Key storage:** WebCrypto AES-GCM ciphertext in IndexedDB by default; UI toggle for "Session only" mode that wipes on tab close.
- **Precedence:** Android-native always wins when both bridges are present in the same WebView (Keystore is stronger than browser storage).

## Architecture Summary

A new self-contained module:

```
apps/browser-demo/src/deviceAgent/
  runtime/      ← state machine, queue, registry, config validation
  storage/      ← WebCrypto + IndexedDB + session-memory secret store
  provider/     ← HTTP executor + OpenAI-compat + Anthropic + parsers + redactor
  prompts/      ← TS port of Kotlin boundaries + system prompts + assembler
  dispatcher.ts ← routes status/configure/start/stop/generatePlan/reviewPlan/ask
  index.ts      ← barrel
```

Contract change (Phase 0, **done**): added `'browser-native'` to `DeviceAgentRuntimeKind` and `STORAGE_UNAVAILABLE` to `DEVICE_AGENT_ERROR_CODES`. `'browser-dev'` stays — it remains the kind for the legacy scaffold path.

Bridge selection in `main.ts:14656` (Phase 6 work):
```
1. IS_ANDROID_APP && Android bridge present     → 'android-native' (Keystore wins)
2. BROWSER_DEVICE_AGENT_ENABLED + allowlisted   → 'browser-native'
3. fall through to scaffold/render-gated        → unchanged
```

Render reports availability in a new `runtimes: { android, browserNative }` block on `/api/device-agent/status` — no logic change, just labels (Phase 7 work).

## File Ownership Boundary Map

| Phase | Owner | Owned globs | Do not touch |
|---|---|---|---|
| 0 | Captain (DONE) | `packages/workflow/src/deviceAgent.ts`, `packages/workflow/src/__tests__/deviceAgent.test.ts`, `apps/browser-demo/src/devGate.ts` (additive const), `apps/browser-demo/src/deviceAgentClient.ts` (additive type only), `apps/browser-demo/src/deviceAgent/index.ts` (stub barrel), this plan file | Everything else |
| 1 | Runtime state machine | `apps/browser-demo/src/deviceAgent/runtime/**`, `apps/browser-demo/src/deviceAgent/__tests__/runtime.test.ts`, `queue.test.ts`, `registry.test.ts` | Phases 2-9 globs, main.ts |
| 2 | Secure storage | `apps/browser-demo/src/deviceAgent/storage/**`, `apps/browser-demo/src/deviceAgent/__tests__/storage.test.ts`, `persistence.test.ts` | Phases 1, 3-9 globs |
| 3 | Provider execution | `apps/browser-demo/src/deviceAgent/provider/**`, `apps/browser-demo/src/deviceAgent/__tests__/openAiCompatibleProvider.test.ts`, `anthropicProvider.test.ts`, `responseParser.test.ts`, `secretRedactor.test.ts`, `providerHttp.test.ts` | Phases 1, 2, 4-9 globs |
| 4 | Prompts | `apps/browser-demo/src/deviceAgent/prompts/**`, `apps/browser-demo/src/deviceAgent/__tests__/systemPrompts.test.ts`, `messageAssembler.test.ts` | Phases 1, 2, 3, 5-9 globs |
| 5 | Dispatcher + client wiring | `apps/browser-demo/src/deviceAgent/dispatcher.ts`, `apps/browser-demo/src/deviceAgent/index.ts` (final barrel), `apps/browser-demo/src/devGate.ts` (additive helpers only — Phase 0 has already added the const), `apps/browser-demo/src/deviceAgentClient.ts` (additive exports only — no behavior change to existing functions), `apps/browser-demo/src/__tests__/deviceAgentDispatcher.test.ts`, `devGateBrowserNative.test.ts` | runtime/storage/provider/prompts internals, main.ts |
| 6 | main.ts integration + UI tiering | `apps/browser-demo/src/main.ts`, `apps/browser-demo/src/styles.css`, `apps/browser-demo/src/systemHealth.ts`, `apps/browser-demo/src/__tests__/mainBrowserNativeWiring.test.ts`, `apps/browser-demo/src/__tests__/systemHealthDeviceAgent.test.ts` (extend) | Module internals, planner.ts, Render, Android |
| 7 | Render runtimes block | `apps/render-web/src/cloud/devGate.ts`, `apps/render-web/src/cloud/router.ts` (only `deviceAgentStatusPayload`), `apps/render-web/src/__tests__/devGate.test.ts`, `apps/render-web/src/__tests__/server.test.ts`, `apps/render-web/README.md` | Browser app, Android |
| 8 | QA / smoke / evals | `docs/smoke/browser-device-agent.md` (new), `scripts/browser-device-agent-cors-check.mjs` (new), `scripts/browser-device-agent-status.mjs` (new), `spec/evals/browser-device-agent/**` (new) | App source files |
| 9 | Docs + release guardrails | `docs/ai-byok.md`, `docs/deploy/browser-device-agent.md` (new), `docs/deploy/release.md`, `docs/plans/browser-device-agent-runtime-plan.md` (final status only) | App source files |

### Non-overlap rules

- Each agent stays inside its globs. If a phase needs another phase's file, write `BLOCKED:` in its final report.
- Do NOT rename or remove `'browser-dev'` runtime kind — preserved for legacy scaffold.
- Do NOT change existing `deviceAgentClient.ts` `getBridge()`/`deviceAgentRequest()`/`deviceAgentRequestOrThrow()` behavior. Phase 5 may **only add** new exports.
- Do NOT change Kotlin runtime files. Cross-runtime parity is a *comparison* target, not an editing target.
- Do NOT add top-level dependencies. Use native `fetch`, `crypto.subtle`, `indexedDB`.
- Do NOT log API keys. The redactor is mandatory on every error path.

## Kotlin Reference Architecture (mirror this)

All TypeScript ports must preserve the wire-format, error codes, and prompt contents from these files:

- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/runtime/` — RuntimeState, RuntimeConfig, RuntimeRequest, RequestQueue (capacity 64), RuntimeRegistry, RuntimeStatePersistence, ProviderExecutor
- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/provider/` — HttpExecutor (30/60s timeout, 1MB cap), ProviderHttp (baseUrl normalize), OpenAiCompatibleProvider, AnthropicProvider, ProviderResponseParser, SecretRedactor, ProviderErrorCodes, DeviceAgentProviderExecutor
- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/prompts/` — DeviceAgentBoundaries, DeviceAgentSystemPrompts, DeviceAgentMessageAssembler
- `apps/android-twa/app/src/main/java/com/agentic/wallet/agent/AgentRuntimeController.kt`

When in doubt, Kotlin wins. The browser test pins must match Kotlin behavior, not the other way around.

---

## Phase 0 — Captain Prep (COMPLETE)

**Done:**
- `packages/workflow/src/deviceAgent.ts` — added `'browser-native'` to `DEVICE_AGENT_RUNTIME_KINDS`, added `DEVICE_AGENT_ERROR_CODES` constant with all codes including `STORAGE_UNAVAILABLE`.
- `packages/workflow/src/__tests__/deviceAgent.test.ts` — added browser-native positive and negative cases (3 new test scenarios).
- `apps/browser-demo/src/deviceAgentClient.ts` — `DeviceAgentRuntimeKind` union and `isRuntimeKind()` now accept `'browser-native'`. No behavior change.
- `apps/browser-demo/src/devGate.ts` — added `VITE_AGENTIC_BROWSER_DEVICE_AGENT` env var to vite type, added `BROWSER_DEVICE_AGENT_ENABLED` boolean export. Constant exists but is unused elsewhere yet (Phase 5 wires it).
- `apps/browser-demo/src/deviceAgent/index.ts` — stub barrel with `export {}` placeholder.
- This plan doc.

---

## Phase 1 — Runtime State Machine, Queue, Registry

**Parallel-eligible NOW.** Read this section verbatim. You own:

- `apps/browser-demo/src/deviceAgent/runtime/state.ts`
- `apps/browser-demo/src/deviceAgent/runtime/errors.ts`
- `apps/browser-demo/src/deviceAgent/runtime/config.ts`
- `apps/browser-demo/src/deviceAgent/runtime/request.ts`
- `apps/browser-demo/src/deviceAgent/runtime/queue.ts`
- `apps/browser-demo/src/deviceAgent/runtime/registry.ts`
- Tests: `apps/browser-demo/src/deviceAgent/__tests__/runtime.test.ts`, `queue.test.ts`, `registry.test.ts`

### Required public surface

**`state.ts`** mirrors `RuntimeState.kt`:
```ts
export type RuntimeStateWire = 'stopped' | 'starting' | 'running' | 'error';
export const RUNTIME_STATES: readonly RuntimeStateWire[] = ['stopped', 'starting', 'running', 'error'];
export interface RuntimeError { code: string; subcode?: string; message: string; }
```

**`errors.ts`** mirrors Kotlin error codes + adds `STORAGE_UNAVAILABLE`. Import from `@solana-agent-wallet-adapter/workflow` if convenient (`DEVICE_AGENT_ERROR_CODES`), or redeclare locally.

```ts
export const RUNTIME_CONFIG_SUBCODES = {
  MISSING_PROVIDER: 'missing_provider',
  MISSING_MODEL: 'missing_model',
  MISSING_API_KEY: 'missing_api_key',
  UNSUPPORTED_FORMAT: 'unsupported_format',
} as const;
export class ProviderUnavailableError extends Error { constructor(public error: RuntimeError) { super(error.message); } }
export class ProviderFailedError extends Error { constructor(public error: RuntimeError) { super(error.message); } }
```

**`config.ts`** mirrors `RuntimeConfig.kt`:
```ts
export interface RuntimeConfig {
  provider: string;
  apiFormat: 'openai-compatible' | 'anthropic';
  model: string;
  baseUrl?: string;
  apiKey?: string;
  walletAddress?: string;
}
export const SUPPORTED_API_FORMATS: ReadonlySet<string> = new Set(['openai-compatible', 'anthropic']);
export function canonicalApiFormat(value: string): string;
export function validateRuntimeConfig(config: RuntimeConfig | null | undefined): RuntimeError | null;
export function redactedSummary(config: RuntimeConfig): Record<string, unknown>; // never includes apiKey
```

**`request.ts`** mirrors `RuntimeRequest.kt`:
```ts
export type RuntimeMethodWire = 'generatePlan' | 'reviewPlan' | 'ask';
export interface RuntimeRequest { requestId: string; method: RuntimeMethodWire; payload: Record<string, unknown>; enqueuedAtMs: number; }
export type RuntimeResult =
  | { kind: 'ok'; requestId: string; method: RuntimeMethodWire; data: unknown; completedAtMs: number }
  | { kind: 'failed'; requestId: string; method: RuntimeMethodWire; error: RuntimeError; completedAtMs: number };
```

**`queue.ts`** mirrors `RequestQueue.kt`. Use a Promise-chain serial queue (no coroutines/channels):
```ts
export interface ProviderExecutor {
  generatePlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  reviewPlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  ask(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export interface RequestQueueOptions { capacity?: number; executorProvider: () => ProviderExecutor; configProvider: () => RuntimeConfig | null; }
export class RequestQueue { constructor(options: RequestQueueOptions); start(): void; submit(request: RuntimeRequest): Promise<RuntimeResult>; stop(): void; }
```

Invariants (test-locked):
- Each `submit` resolves exactly once.
- Capacity overflow (≥ 64) → `runtime_busy` without enqueueing.
- Closed queue → `runtime_not_running`.
- `stop()` aborts in-flight via `AbortController`, drains pending as `runtime_canceled`.
- `ProviderUnavailableError` / `ProviderFailedError` caught, never crash the consumer.
- Generic `Error` → `runtime_internal`.
- Concurrency proven 1 via timestamp non-overlap test.

**`registry.ts`** mirrors `RuntimeRegistry.kt`:
```ts
export interface RegistryDependencies { persistence: import('../storage/persistence.js').RuntimePersistence; executorProvider: () => ProviderExecutor; clock?: () => number; }
export interface RegistrySnapshot { state: RuntimeStateWire; lastError: RuntimeError | null; config: RuntimeConfig | null; lastTransitionAtMs: number; }
export class BrowserRuntimeRegistry {
  constructor(deps: RegistryDependencies);
  hydrate(): Promise<void>;
  snapshot(): RegistrySnapshot;
  start(config: RuntimeConfig | null): Promise<RuntimeStateWire>;
  stop(): Promise<RuntimeStateWire>;
  recordError(error: RuntimeError): Promise<RuntimeStateWire>;
  submit(request: RuntimeRequest): Promise<RuntimeResult>;
  setExecutor(executor: ProviderExecutor): void;
}
```

State transitions match Kotlin: hydrate downgrades persisted `running`/`starting` → `stopped`. Mutex-guarded with a Promise chain. Fast-path read of `state` for submit (no mutex).

### Tests

- State machine transitions (stopped→starting→running, error subcodes).
- Queue: capacity overflow → `runtime_busy`; stop drains pending → `runtime_canceled`; provider throws → request fails but consumer keeps running; sequential proof via timestamp non-overlap.
- Registry: hydrate downgrades persisted running→stopped; concurrent `start()` serializes.
- Cancellation: in-flight request resolves as `runtime_canceled` when `stop()` called.

### Done when

- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` clean.
- All Phase 1 tests pass.
- `runtime/` directory imports zero DOM or `crypto.subtle` (those are Phase 2/3 concerns).

### Imports allowed
- Workflow contract types from `@solana-agent-wallet-adapter/workflow`.
- Forward type references to Phase 2's `persistence.ts` and Phase 3's `ProviderExecutor` interface (use `import type` only — concrete classes wired by Phase 5).

---

## Phase 2 — Secure Storage (WebCrypto + IndexedDB)

**Parallel-eligible NOW.** You own:

- `apps/browser-demo/src/deviceAgent/storage/cryptoKey.ts`
- `apps/browser-demo/src/deviceAgent/storage/indexedDbStore.ts`
- `apps/browser-demo/src/deviceAgent/storage/sessionMemoryStore.ts`
- `apps/browser-demo/src/deviceAgent/storage/secretStore.ts`
- `apps/browser-demo/src/deviceAgent/storage/persistence.ts`
- Tests: `storage.test.ts`, `persistence.test.ts`

### Required public surface

**`cryptoKey.ts`**:
```ts
export async function getOrCreateWrappingKey(dbName: string, storeName: string): Promise<CryptoKey>;
```
Non-extractable AES-GCM-256 generated with `crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt'])`. Stored as `CryptoKey` via structured clone inside IndexedDB. Never call `exportKey`.

**`indexedDbStore.ts`** — generic helpers (model after `openLabArchiveDb` in `main.ts:42050`):
```ts
export async function openDb(name: string, version: number, stores: ReadonlyArray<string>): Promise<IDBDatabase>;
export async function putRecord(db: IDBDatabase, store: string, record: unknown): Promise<void>;
export async function getRecord<T = unknown>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined>;
export async function deleteRecord(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void>;
```

**`sessionMemoryStore.ts`** — `Map<string,string>`-based store; subscribes to `beforeunload` to `clear()`.

**`secretStore.ts`** — public interface:
```ts
export type SecretStoreMode = 'encrypted-indexeddb' | 'session-memory' | 'none';
export interface SecretStore {
  put(key: string, plaintext: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  mode(): SecretStoreMode;
}
export function createSecretStore(mode: SecretStoreMode): SecretStore;
```

DB layout for `encrypted-indexeddb` mode:
- DB name: `agentic-device-agent-secrets`. Version 1.
- Stores: `wrappingKey` (single record `{ id: 'v1', key: CryptoKey }`), `ciphertext` (`{ key, iv: Uint8Array, ct: Uint8Array }`), `stateMeta` (Phase persistence).
- Fresh 12-byte IV per write.
- Any `crypto.subtle` failure → `Error('storage_unavailable: <reason>')` so Phase 1's queue maps to `RuntimeError('storage_unavailable')`.

**`persistence.ts`** mirrors `RuntimeStatePersistence.kt`:
```ts
export interface RuntimePersistence { load(): Promise<RegistrySnapshotPersist>; save(state: RuntimeStateWire, error: RuntimeError | null): Promise<void>; }
export interface RegistrySnapshotPersist { state: RuntimeStateWire; error: RuntimeError | null; lastTransitionAtMs: number; }
export function createIndexedDbPersistence(): RuntimePersistence;
export function createMemoryPersistence(): RuntimePersistence;
```

### Tests
- Encrypted round-trip; two puts → different ciphertexts (IV freshness).
- `key.extractable === false` assertion.
- delete clears; clear regenerates wrapping key.
- Session-memory: never touches IndexedDB; cleared on `beforeunload` test.
- Persistence save→load round-trip; `save(stopped, null)` clears error fields.
- If `fake-indexeddb` is not a dev dep, ship a minimal in-memory IDB shim inside the test file ONLY (do not add to production code).

### Done when
- All storage tests pass without network or real IndexedDB.
- Zero log lines contain `sk-` or `Bearer`.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` clean.

---

## Phase 3 — Provider Execution

**Parallel-eligible NOW.** You own:

- `apps/browser-demo/src/deviceAgent/provider/types.ts`
- `apps/browser-demo/src/deviceAgent/provider/errorCodes.ts`
- `apps/browser-demo/src/deviceAgent/provider/secretRedactor.ts`
- `apps/browser-demo/src/deviceAgent/provider/responseParser.ts`
- `apps/browser-demo/src/deviceAgent/provider/providerHttp.ts`
- `apps/browser-demo/src/deviceAgent/provider/http.ts`
- `apps/browser-demo/src/deviceAgent/provider/openAiCompatibleProvider.ts`
- `apps/browser-demo/src/deviceAgent/provider/anthropicProvider.ts`
- `apps/browser-demo/src/deviceAgent/provider/deviceAgentProviderExecutor.ts`
- Tests: `openAiCompatibleProvider.test.ts`, `anthropicProvider.test.ts`, `responseParser.test.ts`, `secretRedactor.test.ts`, `providerHttp.test.ts`

### Required public surface

**`errorCodes.ts`** — verbatim mirror of `ProviderErrorCodes.kt`:
```ts
export const PROVIDER_ERROR_CODES = {
  TIMEOUT: 'provider_timeout',
  AUTH: 'provider_auth',
  RATE_LIMITED: 'provider_rate_limited',
  INVALID_RESPONSE: 'provider_invalid_response',
  INVALID_CONFIG: 'provider_invalid_config',
  UPSTREAM: 'provider_upstream',
  NETWORK: 'provider_network',
} as const;
export class ProviderHttpError extends Error { constructor(public code: string, message: string) { super(message); } }
```

**`secretRedactor.ts`** — port `SecretRedactor.kt`. Patterns: BEARER (`Bearer [A-Za-z0-9._~+/=-]+`), SK_PROJ (`sk-proj-[A-Za-z0-9_-]{8,}`), SK (`sk-[A-Za-z0-9_-]{8,}`), JWT (`[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`), KEY_VALUE (`(api[-_]?key|token|secret)([\"':=\s]+)([^\"',\s\[]{8,})`). Function: `export function redactSecret(value: string, secret?: string): string`.

**`responseParser.ts`** — port `ProviderResponseParser.kt`:
```ts
export function extractOpenAiText(payload: unknown): string;
export function extractAnthropicText(payload: unknown): string;
export function parseModelJson(text: string): Record<string, unknown>;
```
`parseModelJson` order: direct parse → ``` fences with/without language tag → balanced-brace `{...}` extraction → throw `provider_invalid_response`.

**`providerHttp.ts`** — port `ProviderHttp.kt`:
```ts
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export function normalizeBaseUrl(raw: string | undefined, apiFormat: 'openai-compatible' | 'anthropic'): string;
export function mapHttpStatusToErrorCode(status: number): string | null;
export function isDefaultTemperatureOnlyModel(model: string): boolean;
export function assertApiKeyHeaderSafe(value: string): void;
export function composeErrorMessage(status: number, body: string): string;
export function providerStatusExplanation(status: number): string;
```

HTTP status mapping (mirror Kotlin):
- 2xx → null
- 401, 403 → `provider_auth`
- 429 → `provider_rate_limited`
- 408, 504 → `provider_timeout`
- 5xx → `provider_upstream`
- else → `provider_invalid_response`

**`http.ts`** — `FetchHttpExecutor`:
```ts
export interface HttpResponse { status: number; body: string; }
export interface HttpExecutor {
  postJson(url: string, headers: Record<string,string>, body: string, signal?: AbortSignal): Promise<HttpResponse>;
}
export class FetchHttpExecutor implements HttpExecutor {
  constructor(opts?: { connectTimeoutMs?: number; readTimeoutMs?: number; maxBytes?: number });
  postJson(url, headers, body, signal): Promise<HttpResponse>;
}
```
- HTTPS only. Non-https → `ProviderHttpError('provider_invalid_config', …)`.
- Compose external signal with internal timeout (`setTimeout` + `controller.abort()`).
- `AbortError` propagates verbatim (NOT wrapped — queue handles as `runtime_canceled`).
- 1 MB body cap via `response.body?.getReader()`; over-cap → `provider_invalid_response`. Fall back to `response.text()` + length check in degraded environments.
- Request: `Content-Type: application/json; charset=utf-8`, `Accept: application/json`. Caller headers override.

**`openAiCompatibleProvider.ts`** — port `OpenAiCompatibleProvider.kt`. Constants: `PLAN_TEMPERATURE=0.2`, `REVIEW_TEMPERATURE=0.2`, `ASK_TEMPERATURE=0.3`, `PLAN_MAX_TOKENS=1024`, `REVIEW_MAX_TOKENS=1024`, `ASK_MAX_TOKENS=800`. Skip `temperature` for gpt-5/o1/o3/o4 model families (see `isDefaultTemperatureOnlyModel`). `response_format: {type:'json_object'}` for plan/review only.

**`anthropicProvider.ts`** — port `AnthropicProvider.kt`. Headers MUST include `anthropic-dangerous-direct-browser-access: 'true'` (only divergence from Kotlin). Pattern matches `planner.ts:1519`.

**`deviceAgentProviderExecutor.ts`** — selector by `config.apiFormat`. Wraps `ProviderHttpError` into `ProviderFailedError` with `redactSecret(message, config.apiKey)`. `AbortError` propagates.

### Tests
- `secretRedactor.test.ts`: each pattern.
- `responseParser.test.ts`: balanced braces, ``` fences with/without language tag, raw object pass-through, blank string throws.
- `providerHttp.test.ts`: normalizeBaseUrl for all 5 providers' defaults; status code mapping for 401/429/504/500; `isDefaultTemperatureOnlyModel('gpt-5')` true; `assertApiKeyHeaderSafe('sk-abc\n')` throws.
- `openAiCompatibleProvider.test.ts`: stub HttpExecutor; URL = `${baseUrl}/chat/completions`; Bearer header; `response_format` for plan/review; absent for ask; temperature dropped for gpt-5; status 401 → `ProviderHttpError('provider_auth')`; bad JSON 200 → `provider_invalid_response`.
- `anthropicProvider.test.ts`: verify `anthropic-dangerous-direct-browser-access: 'true'`, `x-api-key`, `anthropic-version: '2023-06-01'`.

### Done when
- All provider tests pass against stub HttpExecutor.
- Redactor pin-tests cover every regex.
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck` clean.

---

## Phase 4 — Prompts and Message Assembler

**Parallel-eligible NOW.** You own:

- `apps/browser-demo/src/deviceAgent/prompts/boundaries.ts`
- `apps/browser-demo/src/deviceAgent/prompts/systemPrompts.ts`
- `apps/browser-demo/src/deviceAgent/prompts/messageAssembler.ts`
- Tests: `systemPrompts.test.ts`, `messageAssembler.test.ts`

### Required public surface

**`boundaries.ts`** — direct port of `DeviceAgentBoundaries.kt`:
```ts
export const DEVICE_AGENT_BOUNDARIES = {
  PLAN: 'AI prepares a plan only. Wallet approval and signing happen later in the user wallet.',
  REVIEW: 'This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.',
  ASK: 'This is conversational Q&A about a draft. It cannot sign or submit a transaction.',
  REVIEW_DEFAULT_INSTRUCTION: 'Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.',
} as const;
```

**`systemPrompts.ts`** — byte-identical copies of `DeviceAgentSystemPrompts.PLAN`/`.REVIEW`/`.ASK` from `DeviceAgentSystemPrompts.kt`. **Port line-for-line.** Do NOT import from `planner.ts`. Length pin (mirror Kotlin's `DeviceAgentSystemPromptsTest`):

```ts
export const DEVICE_AGENT_SYSTEM_PROMPTS = {
  PLAN: '<verbatim from Kotlin>',
  REVIEW: '<verbatim from Kotlin>',
  ASK: '<verbatim from Kotlin>',
} as const;
```

**`messageAssembler.ts`** — port `DeviceAgentMessageAssembler.kt`:
```ts
export interface DeviceAgentMessages { system: string; userContent: string; }
export function buildPlanMessages(payload: Record<string, unknown>): DeviceAgentMessages;
export function buildReviewMessages(payload: Record<string, unknown>, now?: () => Date): DeviceAgentMessages;
export function buildAskMessages(payload: Record<string, unknown>, now?: () => Date): DeviceAgentMessages;
```

Pinned behavior:
- Plan extracts `protocolConnectors`/`connectorContext`; derives `connectorRule` from selected connector (if any) using the Kotlin `findSelectedConnector` logic. Defaults `requiredBoundary = DEVICE_AGENT_BOUNDARIES.PLAN`.
- Review defaults instruction to `REVIEW_DEFAULT_INSTRUCTION`, walletAddress to `'not_connected'`, cluster to `'unknown'`, research `{ needed:false, mode:'not_required', currentDate, maxSearches:3 }`.
- Ask analogous to review with `question` field required.

### Tests
- `systemPrompts.test.ts`: PLAN/REVIEW/ASK length pin + canary substring (`"convert Solana wallet user requests"`, `"STRUCTURED DECISION CONTRACT"`, `"Be concise: 1 to 4 sentences"`).
- `messageAssembler.test.ts`: representative plan/review/ask payloads → assert userContent JSON shape matches Kotlin (snapshot or explicit field assertions).

### Done when
- System prompts byte-equal Kotlin originals.
- Tests cover plan/review/ask with selected and unselected connectors.
- Zero dependency on runtime, storage, or provider modules.

---

## Phase 5 — Dispatcher + devGate Helpers + Client Surface

**Depends on Phases 1-4 to typecheck.** Start implementation work in parallel; final merge after upstream phases land.

### Files to create / edit
- Create: `apps/browser-demo/src/deviceAgent/dispatcher.ts`
- Finalize: `apps/browser-demo/src/deviceAgent/index.ts`
- Edit (additive only): `apps/browser-demo/src/devGate.ts` — add `isBrowserNativeRuntimeEligible(walletAddress, isAndroidApp)` helper
- Edit (additive only): `apps/browser-demo/src/deviceAgentClient.ts` — add `isBrowserNativeRuntimeAvailable()` and `browserNativeDeviceAgentRequestOrThrow<R>`
- Tests: `apps/browser-demo/src/__tests__/deviceAgentDispatcher.test.ts`, `devGateBrowserNative.test.ts`

### Required public surface

**`dispatcher.ts`**:
```ts
export interface BrowserDeviceAgentDeps {
  secretStoreMode: SecretStoreMode;
  walletAddress?: string;
  now?: () => Date;
}
export function initBrowserDeviceAgent(deps: BrowserDeviceAgentDeps): void;
export async function browserDeviceAgentRequest<R = unknown>(
  method: DeviceAgentMethod,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<{ status: DeviceAgentStatus; result?: R }>;
export function browserDeviceAgentStatusSnapshot(): DeviceAgentStatus;
export async function setBrowserDeviceAgentSecretStoreMode(mode: SecretStoreMode): Promise<void>;
```

Method routing:
- `status` → snapshot mapped to `DeviceAgentStatus` with `runtime: 'browser-native'`.
- `configure` → `SecretStore.put(...)`, persist redacted metadata. If `payload.clear === true`, delete secret and clear config.
- `start` → load config+secret, validate, `registry.start(config)`.
- `stop` → `registry.stop()`.
- `generatePlan` / `reviewPlan` / `ask` → validate RUNNING, build `RuntimeRequest`, `registry.submit(...)`. On `failed` throw `DeviceAgentClientError(error.code, error.message, status, error.subcode)`.

**`devGate.ts` additions**:
```ts
export function isBrowserNativeRuntimeEligible(walletAddress: string | undefined | null, isAndroidApp: boolean): boolean;
```
True only if: `DEVICE_AGENT_ENABLED` && `BROWSER_DEVICE_AGENT_ENABLED` && `!isAndroidApp` && (`SHOW_DEV_CONTROLS`-equivalent || wallet in allowlist).

**`deviceAgentClient.ts` additions** (lazy import to keep Android-only bundle light):
```ts
export function isBrowserNativeRuntimeAvailable(): boolean;
export function browserNativeDeviceAgentRequestOrThrow<R = unknown>(
  method: DeviceAgentMethod,
  payload?: unknown,
  options?: DeviceAgentRequestOptions,
): Promise<{ status: DeviceAgentStatus; result?: R }>;
```

### Tests
- `deviceAgentDispatcher.test.ts`: configure happy path → state running, configured=true, runtime=browser-native. Empty model → error with subcode `missing_model`. generatePlan with mocked HttpExecutor → returns parsed JSON. Runtime stopped → throws `runtime_not_running`. `setBrowserDeviceAgentSecretStoreMode('session-memory')` → next configure stores in memory.
- `devGateBrowserNative.test.ts`: matrix — flag off, wallet mismatch, both on + allowlist + non-Android = true; Android present = false.

### Done when
- Dispatcher tests pass.
- Dynamic import path doesn't trigger DOM/crypto in non-browser tests.
- No edits to existing `deviceAgentClient.ts` functions; additive exports only.

---

## Phase 6 — main.ts Integration + UI Tiering

**Depends on Phase 5.**

### Anchor-point edits in `apps/browser-demo/src/main.ts`

1. **Imports** (~line 320): add to devGate import: `BROWSER_DEVICE_AGENT_ENABLED, isBrowserNativeRuntimeEligible`. Add full dispatcher API from `./deviceAgent/index.js`.
2. **Bootstrap**: call `initBrowserDeviceAgent({secretStoreMode:'encrypted-indexeddb'})` once at startup when `BROWSER_DEVICE_AGENT_ENABLED && !IS_ANDROID_APP`. Persist user toggle in `localStorage['agentic-device-agent-secret-store-mode']`.
3. **`canUseDeviceAgentNative()`** (line 14656):
```ts
function canUseDeviceAgentNative(): boolean {
  if (IS_ANDROID_APP && isDeviceAgentBridgeAvailable()) return true;
  return canUseDeviceAgentBrowserNative();
}
function canUseDeviceAgentBrowserNative(): boolean {
  return (
    BROWSER_DEVICE_AGENT_ENABLED
    && !IS_ANDROID_APP
    && isBrowserNativeRuntimeEligible(state.address || state.cloudSession.walletAddress, IS_ANDROID_APP)
  );
}
```
4. **`invokeDeviceAgentNative()`** (line 14660): branch:
```ts
const { status, result } = IS_ANDROID_APP && isDeviceAgentBridgeAvailable()
  ? await deviceAgentRequestOrThrow<R>(method, payload, requestOptions)
  : await browserDeviceAgentRequest<R>(method, payload as Record<string, unknown>, requestOptions);
```
5. **Status loader / configure / start / stop** (lines 31878-31989): add browser-native branch before the cloud/scaffold branches.
6. **`defaultDeviceAgentRuntime()`** (line 32034): return `'browser-native'` when `BROWSER_DEVICE_AGENT_ENABLED && !IS_ANDROID_APP`.
7. **`deviceAgentModeVisibleForWallet`** (line 39660): extend with browser-native branch.
8. **Provider tier chips** (Connect AI card, ~14160-14205): green for OpenRouter/Gemini; amber for OpenAI/Anthropic; neutral for custom-OpenAI-compat. Only show when `state.deviceAgentStatus.runtime === 'browser-native'`.
9. **Secret store mode toggle** in Device Agent card: `<select>` with `Encrypted (IndexedDB)` / `Session only`. Wired to `setBrowserDeviceAgentSecretStoreMode`. Persists in `localStorage`.
10. **Notification note** (line 14187): when `runtime === 'browser-native'`, replace Android copy with "Confirming the planner starts the on-tab runtime. Closing the tab stops it."

### `systemHealth.ts` extension
- `checkDeviceAgentAi` handles `hint.runtime === 'browser-native'` symmetrically to `'android-native'`; remediation: "Reload the tab to recover the Device Agent runtime."

### `styles.css` additions
- `.ai-provider-tier-recommended` (green chip)
- `.ai-provider-tier-dangerous-direct` (amber chip)
- `.ai-provider-tier-neutral` (gray chip)

### Tests
- `mainBrowserNativeWiring.test.ts`: precedence (Android > browser-native > none); `defaultDeviceAgentRuntime` per surface; `deviceAgentModeVisibleForWallet` false when flag on but wallet missing.
- Extend `systemHealthDeviceAgent.test.ts` with `runtime:'browser-native'` cases.
- Existing tests must still pass without edits.

### Done when
- Browser bundle with both flags + allowlisted wallet can configure→confirm→generate→review→ask.
- Same bundle with only `VITE_AGENTIC_DEVICE_AGENT=1` keeps legacy scaffold.
- Android TWA continues `'android-native'` even with browser flag also on.

---

## Phase 7 — Render Runtimes Block

**Parallel-eligible NOW.** Final merge after Phase 6.

### Files
- `apps/render-web/src/cloud/devGate.ts`: add
```ts
export function deviceAgentRuntimeAvailability(): { android: boolean; browserNative: boolean } {
  return {
    android: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_ANDROID_DEVICE_AGENT !== '0',
    browserNative: process.env.AGENTIC_DEVICE_AGENT === '1' && process.env.AGENTIC_BROWSER_DEVICE_AGENT === '1',
  };
}
```
- `apps/render-web/src/cloud/router.ts` — `deviceAgentStatusPayload` (~line 2436): add `runtimes: deviceAgentRuntimeAvailability()` field.
- Tests: cover the matrix in `devGate.test.ts`; assert `/api/device-agent/status` includes `runtimes` in `server.test.ts`.
- `README.md`: document the new env var.

### Done when
- `pnpm -F @solana-agent-wallet-adapter/render-web test` clean.
- Status endpoint reports `runtimes` block.
- No provider call made on Render.

---

## Phase 8 — QA / Smoke / Evals

**Parallel-eligible NOW.** Final merge after Phase 6.

### Files (all new)
- `docs/smoke/browser-device-agent.md` — manual checklist: one section per provider; configure→confirm→generate→review→ask→stop→reload-hydrate→session-memory-toggle. Plus regression sections for disabled-flag, Android-precedence, Render-fallback.
- `scripts/browser-device-agent-cors-check.mjs` — node script that hits OPTIONS/POST against each provider's chat endpoint with a dummy key; exits 0 if CORS headers acceptable; clear messages on failure.
- `scripts/browser-device-agent-status.mjs` — read-only probe of local bundle's gate derivation.
- `spec/evals/browser-device-agent/{openai,anthropic,gemini,openrouter,custom-openai-compatible}.eval.md` — 5 representative prompts each (SOL transfer, swap, Kamino deposit, NFT transfer, governance vote).

### Done when
- Tester can run the checklist for all 5 providers without engineering questions.
- CORS probe exits 0 for OpenRouter, Gemini, OpenAI, Anthropic; warns for custom.

---

## Phase 9 — Docs + Release Guardrails

**Depends on Phase 6 + Phase 7.** Final merge before release tag.

### Files
- `docs/ai-byok.md` — add "Browser Device Agent" section. Distinguish from Hosted BYOK, Browser Session, Local Bridge, Android-native Device Agent.
- `docs/deploy/browser-device-agent.md` (new) — build commands, env matrix, allowlist semantics, secret store modes, CORS expectations per provider.
- `docs/deploy/release.md` — guardrail: public production builds must NOT ship with `VITE_AGENTIC_BROWSER_DEVICE_AGENT=1` unless explicitly approved.
- `docs/plans/browser-device-agent-runtime-plan.md` (this file) — update status header to COMPLETE.

### Required documentation points
- Browser-native Device Agent is dev-gated like Android-native.
- API keys stay on user's device. Render never sees them. Encrypted at rest by default with a non-extractable WebCrypto key (browser-grade, not Keystore-grade — disclose this).
- Per-provider CORS notes.
- Android-native wins when both bridges present.
- Session-only mode is user-selectable, ephemeral.
- Never autonomous: runtime cannot sign, submit, approve, or move funds.

### Done when
- Docs distinguish all 5 AI paths without overlap.
- Release guardrail clear.
- Plan file marked COMPLETE.

---

## Parallel Dependency Graph

```
Phase 0 (DONE)
  ├── Phase 1 (runtime)          ─┐
  ├── Phase 2 (storage)            │
  ├── Phase 3 (provider)           ├──► Phase 5 (dispatcher) ──► Phase 6 (main.ts) ──► Phase 9 (docs)
  ├── Phase 4 (prompts)           ─┘                                      ▲
  ├── Phase 7 (render)  ──────────────────────────────────────────────────┤
  └── Phase 8 (QA)  ──────────────────────────────────────────────────────┘
```

After Phase 0 (now): dispatch 6 agents in parallel (Phases 1, 2, 3, 4, 7, 8). Phase 5 starts after 1-4 typecheck. Phase 6 after 5. Phase 9 after 6+7.

## Merge Order

1. Phase 0 (DONE)
2. Phase 1 — runtime
3. Phase 2 — storage
4. Phase 3 — provider
5. Phase 4 — prompts
6. Phase 5 — dispatcher
7. Phase 6 — main.ts integration
8. Phase 7 — render runtimes block
9. Phase 8 — smoke + evals
10. Phase 9 — docs

(Phase 7/8 may merge earlier without harm.)

## Verification

### Required commands before final merge
- `pnpm -F @solana-agent-wallet-adapter/workflow typecheck`
- `pnpm -F @solana-agent-wallet-adapter/workflow test`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo typecheck`
- `pnpm -F @solana-agent-wallet-adapter/browser-demo test`
- `pnpm -F @solana-agent-wallet-adapter/render-web typecheck`
- `pnpm -F @solana-agent-wallet-adapter/render-web test`
- `pnpm android:build`
- `pnpm android:build -- -PagenticDeviceAgent=true`
- `node scripts/browser-device-agent-cors-check.mjs` (Phase 8 deliverable)

### Manual scenarios
- All 5 providers: configure → confirm planner → generate SOL transfer draft → review → ask. Browser-native runtime.
- Disabled flags: Device Agent hidden.
- Android + browser flag both on: Android wins; browser flag inert in TWA.
- Render `AGENTIC_DEVICE_AGENT=1 AGENTIC_BROWSER_DEVICE_AGENT=1`: status reports `runtimes:{android:true,browserNative:true}`; allowlisted wallet OK; non-allowlisted 403.
- Session-memory: configure key, reload tab → key gone.
- Encrypted IndexedDB: configure key, reload tab → runtime hydrates as `stopped`, key persists, start runtime, generate again.
- Hosted BYOK, Browser Session, Local Bridge regression: each works as before.

## Final Acceptance Criteria

- Default browser, Render, Android builds keep both Device Agent runtimes hidden.
- Enabled browser build (both flags + allowlisted wallet) produces real drafts for **all 5 providers** through browser-native runtime.
- Enabled Android build still uses `'android-native'` even with browser flag on.
- Render deployed build never runs a Device Agent provider call; status reports `runtimes` block.
- Bridge, Hosted BYOK, Session paths keep passing existing tests.
- All existing Device Agent tests still pass; new Phase 1-6 tests pass.
- API keys encrypted at rest by default; session-only fallback works.
- Provider tier chips render correctly.
- New error code `storage_unavailable` flows to diagnostics UI when private-mode IDB blocks.
- Byte-for-byte parity: system prompts, parser balanced-brace logic, redactor regexes, queue capacity (64), temperatures (0.2/0.2/0.3), max tokens (1024/1024/800), HTTP body cap (1 MB), default base URLs.
- `git diff --check` clean.
