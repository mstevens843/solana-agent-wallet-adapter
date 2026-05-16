// Browser-native Device Agent dispatcher.
//
// Mirrors apps/android-twa/.../AgentRuntimeController.kt: same dispatch verbs
// (status/configure/start/stop/generatePlan/reviewPlan/ask), same wire-format,
// same error codes. Composes Phases 1-4 — runtime registry/queue, encrypted
// secret store, provider executor, prompt assembler — and exposes them through
// a single module-level singleton. Phase 6 wires this into main.ts.

import { DEVICE_AGENT_ERROR_CODES } from '@solana-agent-wallet-adapter/workflow';

import {
  DeviceAgentClientError,
  type DeviceAgentApiFormat,
  type DeviceAgentMethod,
  type DeviceAgentRuntimeState,
  type DeviceAgentStatus,
} from '../deviceAgentClient.js';
import { BROWSER_DEVICE_AGENT_ENABLED } from '../devGate.js';

import { DeviceAgentProviderExecutor } from './provider/deviceAgentProviderExecutor.js';
import { FetchHttpExecutor, type HttpExecutor } from './provider/http.js';
import {
  canonicalApiFormat,
  validateRuntimeConfig,
  type RuntimeConfig,
} from './runtime/config.js';
import { RUNTIME_CONFIG_SUBCODES } from './runtime/errors.js';
import { type ProviderExecutor } from './runtime/queue.js';
import {
  BrowserRuntimeRegistry,
  type RuntimePersistence,
} from './runtime/registry.js';
import type {
  RuntimeMethodWire,
  RuntimeRequest,
  RuntimeResult,
} from './runtime/request.js';
import type { RuntimeError } from './runtime/state.js';
import { storageUnavailableError } from './storage/indexedDbStore.js';
import { createIndexedDbPersistence } from './storage/persistence.js';
import {
  createSecretStore,
  type SecretStore,
  type SecretStoreMode,
} from './storage/secretStore.js';

const API_KEY_SECRET_KEY = 'device-agent-api-key';
const METADATA_LOCAL_STORAGE_KEY = 'agentic-device-agent-config-metadata';
const RUNTIME_KIND = 'browser-native' as const;
const DEFAULT_SECRET_STORE_MODE: SecretStoreMode = 'encrypted-indexeddb';

const RUNTIME_METHOD_WIRES: ReadonlySet<RuntimeMethodWire> = new Set(['generatePlan', 'reviewPlan', 'ask']);

// State-based status messages — Kotlin parity with AgentRuntimeController.kt
// (lines 40-46, 193). Phase 6 surfaces these via state.deviceAgentStatus.message
// in the Connect-AI card and as the systemHealth detail string.
const RUNTIME_MESSAGES = {
  RUNNING: 'Browser Device Agent runtime is running.',
  STARTING: 'Browser Device Agent runtime is starting.',
  STOPPED: 'Browser Device Agent runtime is stopped.',
  ERROR_FALLBACK: 'Browser Device Agent runtime is in an error state.',
  DISABLED: 'Browser Device Agent is disabled for this build.',
  UNINITIALIZED: 'Browser Device Agent has not been initialized.',
} as const;

export interface ConfigMetadata {
  provider: string;
  apiFormat: DeviceAgentApiFormat;
  model: string;
  baseUrl?: string;
  walletAddress?: string;
}

export interface MetadataStore {
  load(): ConfigMetadata | null;
  save(metadata: ConfigMetadata | null): void;
}

export interface BrowserDeviceAgentDeps {
  secretStoreMode?: SecretStoreMode;
  walletAddress?: string;
  now?: () => Date;
  httpExecutor?: HttpExecutor;
  persistence?: RuntimePersistence;
  secretStore?: SecretStore;
  executor?: ProviderExecutor;
  metadataStore?: MetadataStore;
}

interface ResolvedDeps {
  secretStoreMode: SecretStoreMode;
  walletAddress: string | undefined;
  now: () => Date;
  httpExecutor: HttpExecutor;
  persistenceOverride: RuntimePersistence | undefined;
  secretStoreOverride: SecretStore | undefined;
  executorOverride: ProviderExecutor | undefined;
  metadataStoreOverride: MetadataStore | undefined;
}

interface InternalState {
  deps: ResolvedDeps;
  registry: BrowserRuntimeRegistry;
  persistence: RuntimePersistence;
  secretStore: SecretStore;
  executor: ProviderExecutor;
  metadataStore: MetadataStore;
  metadata: ConfigMetadata | null;
  hasSecret: boolean;
  hydrationPromise: Promise<void>;
  hydrated: boolean;
  initError: RuntimeError | null;
  serializer: Promise<void>;
}

let _state: InternalState | null = null;

export function isBrowserDeviceAgentInitialized(): boolean {
  return _state !== null;
}

export function initBrowserDeviceAgent(deps: BrowserDeviceAgentDeps = {}): void {
  if (_state) return;
  _state = buildState(deps);
}

export function setBrowserDeviceAgentWalletAddress(walletAddress: string | undefined | null): void {
  if (!_state) return;
  const state = _state;
  const normalized = walletAddress ?? undefined;
  // Schedule the mutation under the same serializer that guards configure/start/stop
  // so an in-flight configure observes either the pre-mutation or post-mutation value
  // consistently — never a torn read across handleConfigure's parseConfigPayload path.
  // External callers keep the sync `void` contract (main.ts:3138 fires this without
  // awaiting); the scheduled mutation lands before the next serialized request runs.
  void runSerialized(state, async () => {
    state.deps.walletAddress = normalized;
  });
}

export function getBrowserDeviceAgentSecretStoreMode(): SecretStoreMode {
  if (!_state) return DEFAULT_SECRET_STORE_MODE;
  return _state.deps.secretStoreMode;
}

export async function setBrowserDeviceAgentSecretStoreMode(
  mode: SecretStoreMode,
): Promise<DeviceAgentStatus> {
  const state = ensureState();
  return runSerialized(state, async () => {
    await waitForHydration(state);
    if (mode === state.deps.secretStoreMode) {
      return buildStatus(state);
    }
    try {
      await state.registry.stop();
    } catch {
      /* tearing down a queue should not fail; ignore to keep toggle responsive */
    }
    try {
      await state.secretStore.clear();
    } catch {
      /* old store is being replaced; clear failure is non-fatal */
    }
    try {
      state.secretStore.dispose();
    } catch {
      /* dispose() may throw if already disposed; ignore */
    }
    state.metadataStore.save(null);
    state.metadata = null;
    state.hasSecret = false;
    state.initError = null;
    state.deps.secretStoreMode = mode;
    state.secretStore = state.deps.secretStoreOverride ?? createSecretStore(mode);
    return buildStatus(state);
  });
}

export function browserDeviceAgentStatusSnapshot(): DeviceAgentStatus {
  if (!_state) return unavailableStatus(undefined);
  return buildStatus(_state);
}

export async function browserDeviceAgentRequest<R = unknown>(
  method: DeviceAgentMethod,
  payload: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<{ status: DeviceAgentStatus; result?: R }> {
  const state = ensureState();
  await waitForHydration(state);
  switch (method) {
    case 'status':
      return { status: buildStatus(state) };
    case 'configure':
      return { status: await handleConfigure(state, payload) };
    case 'start':
      return { status: await handleStart(state) };
    case 'stop':
      return { status: await handleStop(state) };
    case 'generatePlan':
    case 'reviewPlan':
    case 'ask':
      return handleSubmit<R>(state, method, payload, options.signal);
    default: {
      const status = buildStatus(state);
      throw new DeviceAgentClientError(
        DEVICE_AGENT_ERROR_CODES.UNSUPPORTED_METHOD,
        `Unsupported Device Agent method: ${String(method)}`,
        status,
      );
    }
  }
}

export async function __resetBrowserDeviceAgentForTests(): Promise<void> {
  const previous = _state;
  _state = null;
  if (!previous) return;
  try {
    await previous.registry.stop();
  } catch {
    /* test reset is best-effort */
  }
  try {
    await previous.secretStore.clear();
  } catch {
    /* ignore */
  }
  try {
    previous.secretStore.dispose();
  } catch {
    /* ignore */
  }
  try {
    previous.metadataStore.save(null);
  } catch {
    /* ignore */
  }
}

function buildState(deps: BrowserDeviceAgentDeps): InternalState {
  const mode = deps.secretStoreMode ?? DEFAULT_SECRET_STORE_MODE;
  const resolved: ResolvedDeps = {
    secretStoreMode: mode,
    walletAddress: deps.walletAddress,
    now: deps.now ?? (() => new Date()),
    httpExecutor: deps.httpExecutor ?? new FetchHttpExecutor(),
    persistenceOverride: deps.persistence,
    secretStoreOverride: deps.secretStore,
    executorOverride: deps.executor,
    metadataStoreOverride: deps.metadataStore,
  };

  // createIndexedDbPersistence() is a pure factory — IDB open happens lazily in
  // load()/save(). load() already degrades to a default snapshot on failure (see
  // storage/persistence.ts); save() failures are caught inside handleConfigure /
  // handleStart and surfaced as STORAGE_UNAVAILABLE via toStorageUnavailableError.
  const persistence = resolved.persistenceOverride ?? createIndexedDbPersistence();
  const secretStore = resolved.secretStoreOverride ?? createSecretStore(mode);
  const executor =
    resolved.executorOverride ?? new DeviceAgentProviderExecutor(resolved.httpExecutor);
  const metadataStore = resolved.metadataStoreOverride ?? createLocalStorageMetadataStore();

  const registry = new BrowserRuntimeRegistry({
    persistence,
    executorProvider: () => executor,
    clock: () => resolved.now().getTime(),
  });
  registry.setExecutor(executor);

  const internal: InternalState = {
    deps: resolved,
    registry,
    persistence,
    secretStore,
    executor,
    metadataStore,
    metadata: null,
    hasSecret: false,
    hydrationPromise: Promise.resolve(),
    hydrated: false,
    initError: null,
    serializer: Promise.resolve(),
  };
  internal.hydrationPromise = hydrate(internal);
  return internal;
}

async function hydrate(state: InternalState): Promise<void> {
  try {
    // Probe persistence directly first — registry.hydrate() swallows load
    // failures internally (it falls back to a fresh stopped snapshot so the
    // in-memory state machine stays usable). The dispatcher however must
    // surface STORAGE_UNAVAILABLE to UI/diagnostics so users get private-mode
    // remediation instead of a silent dead runtime. The production IDB
    // persistence already catches IDB errors inside its own load() and never
    // throws, so this probe is a no-op in real browsers — only test overrides
    // (failingPersistence) or non-default persistence implementations whose
    // load() rejects will surface here.
    await state.persistence.load();
    await state.registry.hydrate();
    state.metadata = state.metadataStore.load();
    const existing = await state.secretStore.get(API_KEY_SECRET_KEY);
    state.hasSecret = existing !== undefined && existing.length > 0;
    state.hydrated = true;
  } catch (err) {
    state.initError = toStorageUnavailableError(err);
    state.hydrated = true;
  }
}

async function waitForHydration(state: InternalState): Promise<void> {
  await state.hydrationPromise;
}

function ensureState(): InternalState {
  if (!_state) {
    _state = buildState({});
  }
  return _state;
}

function runSerialized<T>(state: InternalState, fn: () => Promise<T>): Promise<T> {
  const next = state.serializer.then(() => fn());
  state.serializer = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function handleConfigure(
  state: InternalState,
  payload: Record<string, unknown>,
): Promise<DeviceAgentStatus> {
  return runSerialized(state, async () => {
    if (state.initError) {
      throw asClientError(state, state.initError);
    }
    if (payload.clear === true) {
      try {
        await state.registry.stop();
      } catch {
        /* stop should not fail */
      }
      try {
        await state.secretStore.delete(API_KEY_SECRET_KEY);
      } catch (err) {
        const runtimeErr = toStorageUnavailableError(err);
        state.initError = runtimeErr;
        throw asClientError(state, runtimeErr);
      }
      state.metadataStore.save(null);
      state.metadata = null;
      state.hasSecret = false;
      return buildStatus(state);
    }

    const candidate = parseConfigPayload(payload, state);
    const validation = validateRuntimeConfig(candidate);
    if (validation) {
      throw asClientError(state, validation);
    }

    try {
      await state.secretStore.put(API_KEY_SECRET_KEY, candidate.apiKey ?? '');
    } catch (err) {
      const runtimeErr = toStorageUnavailableError(err);
      state.initError = runtimeErr;
      throw asClientError(state, runtimeErr);
    }

    const apiFormat = canonicalApiFormat(candidate.apiFormat) as DeviceAgentApiFormat;
    const metadata: ConfigMetadata = {
      provider: candidate.provider,
      apiFormat,
      model: candidate.model,
    };
    if (candidate.baseUrl && candidate.baseUrl.trim().length > 0) {
      metadata.baseUrl = candidate.baseUrl.trim();
    }
    if (candidate.walletAddress && candidate.walletAddress.trim().length > 0) {
      metadata.walletAddress = candidate.walletAddress.trim();
    }
    try {
      state.metadataStore.save(metadata);
    } catch {
      /* metadata persistence is best-effort; runtime still works in-session */
    }
    state.metadata = metadata;
    state.hasSecret = true;
    return buildStatus(state);
  });
}

async function handleStart(state: InternalState): Promise<DeviceAgentStatus> {
  return runSerialized(state, async () => {
    if (state.initError) {
      throw asClientError(state, state.initError);
    }
    const metadata = state.metadata;
    let apiKey: string | undefined;
    try {
      apiKey = await state.secretStore.get(API_KEY_SECRET_KEY);
    } catch (err) {
      const runtimeErr = toStorageUnavailableError(err);
      state.initError = runtimeErr;
      throw asClientError(state, runtimeErr);
    }
    state.hasSecret = apiKey !== undefined && apiKey.length > 0;
    const config: RuntimeConfig = {
      provider: metadata?.provider ?? '',
      apiFormat: metadata?.apiFormat ?? '',
      model: metadata?.model ?? '',
      baseUrl: metadata?.baseUrl,
      apiKey,
      walletAddress: metadata?.walletAddress ?? state.deps.walletAddress,
    };
    const validation = validateRuntimeConfig(config);
    if (validation) {
      throw asClientError(state, validation);
    }
    await state.registry.start(config);
    return buildStatus(state);
  });
}

async function handleStop(state: InternalState): Promise<DeviceAgentStatus> {
  return runSerialized(state, async () => {
    await state.registry.stop();
    return buildStatus(state);
  });
}

async function handleSubmit<R>(
  state: InternalState,
  method: DeviceAgentMethod,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ status: DeviceAgentStatus; result?: R }> {
  if (state.initError) {
    throw asClientError(state, state.initError);
  }
  if (!RUNTIME_METHOD_WIRES.has(method as RuntimeMethodWire)) {
    throw asClientError(state, {
      code: DEVICE_AGENT_ERROR_CODES.UNSUPPORTED_METHOD,
      message: `Unsupported Device Agent method: ${String(method)}`,
    });
  }
  const snapshot = state.registry.snapshot();
  if (snapshot.state !== 'running') {
    throw asClientError(state, {
      code: DEVICE_AGENT_ERROR_CODES.RUNTIME_NOT_RUNNING,
      message: 'Device Agent runtime is not running.',
    });
  }
  if (signal?.aborted) {
    throw asClientError(state, {
      code: DEVICE_AGENT_ERROR_CODES.RUNTIME_CANCELED,
      message: 'Device Agent request was aborted before submission.',
    });
  }

  const request: RuntimeRequest = {
    requestId: generateRequestId(),
    method: method as RuntimeMethodWire,
    payload,
    enqueuedAtMs: state.deps.now().getTime(),
  };

  const submitPromise = state.registry.submit(request);
  const result = await raceAbort(submitPromise, signal);
  return finalizeResult<R>(state, result);
}

function finalizeResult<R>(
  state: InternalState,
  result: RuntimeResult,
): { status: DeviceAgentStatus; result?: R } {
  if (result.kind === 'ok') {
    return { status: buildStatus(state), result: result.data as R };
  }
  throw asClientError(state, result.error);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  // Per-request abort caveat: rejecting the caller's promise here does NOT cancel
  // the underlying `RequestQueue.submit` work — Phase 1's queue (runtime/queue.ts)
  // only exposes a global `stop()`-driven cancel via its single AbortController.
  // The in-flight HTTP request therefore runs to completion in the background and
  // its result is discarded. This is bounded by FetchHttpExecutor's internal
  // connect/read timeouts (30s/60s, see provider/http.ts). For hard cancellation
  // use `browserDeviceAgentRequest('stop')`.
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(
        new DeviceAgentClientError(
          DEVICE_AGENT_ERROR_CODES.RUNTIME_CANCELED,
          'Device Agent request was aborted.',
        ),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function buildStatus(state: InternalState): DeviceAgentStatus {
  const snap = state.registry.snapshot();
  const meta = state.metadata;
  const initErr = state.initError;
  const configured = !!meta && state.hasSecret;
  const liveState: DeviceAgentRuntimeState = initErr ? 'unavailable' : snap.state;
  const lastError = initErr ?? snap.lastError;
  const status: DeviceAgentStatus = {
    available: BROWSER_DEVICE_AGENT_ENABLED && !initErr,
    enabled: BROWSER_DEVICE_AGENT_ENABLED,
    configured,
    state: liveState,
    runtime: RUNTIME_KIND,
    message: statusMessageFor(liveState, lastError),
    checkedAt: state.deps.now().toISOString(),
  };
  if (meta?.provider) status.provider = meta.provider;
  if (meta?.apiFormat) status.apiFormat = meta.apiFormat;
  if (meta?.baseUrl) status.baseUrl = meta.baseUrl;
  if (meta?.model) status.model = meta.model;
  const wallet = meta?.walletAddress ?? state.deps.walletAddress;
  if (wallet) status.walletAddress = wallet;
  if (snap.lastTransitionAtMs > 0) {
    status.updatedAt = new Date(snap.lastTransitionAtMs).toISOString();
  }
  if (lastError) {
    const errorOut: DeviceAgentStatus['lastError'] = {
      code: lastError.code,
      message: lastError.message,
    };
    if (lastError.subcode) errorOut.subcode = lastError.subcode;
    status.lastError = errorOut;
  } else {
    status.lastError = null;
  }
  return status;
}

function statusMessageFor(
  liveState: DeviceAgentRuntimeState,
  lastError: RuntimeError | null,
): string {
  switch (liveState) {
    case 'running':
      return RUNTIME_MESSAGES.RUNNING;
    case 'starting':
      return RUNTIME_MESSAGES.STARTING;
    case 'error':
      return lastError?.message?.trim().length
        ? lastError.message
        : RUNTIME_MESSAGES.ERROR_FALLBACK;
    case 'unavailable':
      return lastError?.message?.trim().length
        ? lastError.message
        : RUNTIME_MESSAGES.UNINITIALIZED;
    case 'stopped':
    default:
      return RUNTIME_MESSAGES.STOPPED;
  }
}

function unavailableStatus(walletAddress: string | undefined): DeviceAgentStatus {
  const status: DeviceAgentStatus = {
    available: BROWSER_DEVICE_AGENT_ENABLED,
    enabled: BROWSER_DEVICE_AGENT_ENABLED,
    configured: false,
    state: 'unavailable',
    runtime: RUNTIME_KIND,
    message: BROWSER_DEVICE_AGENT_ENABLED ? RUNTIME_MESSAGES.UNINITIALIZED : RUNTIME_MESSAGES.DISABLED,
    checkedAt: new Date().toISOString(),
    lastError: null,
  };
  if (walletAddress) status.walletAddress = walletAddress;
  return status;
}

function asClientError(state: InternalState, error: RuntimeError): DeviceAgentClientError {
  return new DeviceAgentClientError(error.code, error.message, buildStatus(state), error.subcode);
}

function parseConfigPayload(
  payload: Record<string, unknown>,
  state: InternalState,
): RuntimeConfig {
  const provider = trimOrEmpty(payload.provider);
  const apiFormatRaw = trimOrEmpty(payload.apiFormat);
  const apiFormat = apiFormatRaw ? canonicalApiFormat(apiFormatRaw) : '';
  const model = trimOrEmpty(payload.model);
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey : '';
  const baseUrl = trimOrEmpty(payload.baseUrl) || undefined;
  const walletAddress =
    trimOrEmpty(payload.walletAddress) || state.deps.walletAddress || undefined;
  return {
    provider,
    apiFormat,
    model,
    baseUrl,
    apiKey,
    walletAddress,
  };
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function generateRequestId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `browser-native-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function toStorageUnavailableError(err: unknown): RuntimeError {
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: DEVICE_AGENT_ERROR_CODES.STORAGE_UNAVAILABLE,
    message: message || 'Device Agent storage is unavailable.',
  };
}

function createLocalStorageMetadataStore(): MetadataStore {
  const storage = readLocalStorage();
  return {
    load(): ConfigMetadata | null {
      if (!storage) return null;
      try {
        const raw = storage.getItem(METADATA_LOCAL_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return validateMetadata(parsed);
      } catch {
        return null;
      }
    },
    save(metadata: ConfigMetadata | null): void {
      if (!storage) return;
      try {
        if (!metadata) {
          storage.removeItem(METADATA_LOCAL_STORAGE_KEY);
          return;
        }
        storage.setItem(METADATA_LOCAL_STORAGE_KEY, JSON.stringify(metadata));
      } catch {
        /* private mode quota errors; ignore — runtime still works in-session */
      }
    },
  };
}

function readLocalStorage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage;
    if (candidate && typeof candidate.getItem === 'function') return candidate;
  } catch {
    /* SecurityError in some private modes; fall through */
  }
  return null;
}

function validateMetadata(value: unknown): ConfigMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const provider = typeof obj.provider === 'string' ? obj.provider.trim() : '';
  const apiFormatRaw = typeof obj.apiFormat === 'string' ? obj.apiFormat.trim() : '';
  const apiFormat = canonicalApiFormat(apiFormatRaw);
  const model = typeof obj.model === 'string' ? obj.model.trim() : '';
  if (!provider || !model) return null;
  if (apiFormat !== 'openai-compatible' && apiFormat !== 'anthropic') return null;
  const metadata: ConfigMetadata = {
    provider,
    apiFormat: apiFormat as DeviceAgentApiFormat,
    model,
  };
  if (typeof obj.baseUrl === 'string' && obj.baseUrl.trim().length > 0) {
    metadata.baseUrl = obj.baseUrl.trim();
  }
  if (typeof obj.walletAddress === 'string' && obj.walletAddress.trim().length > 0) {
    metadata.walletAddress = obj.walletAddress.trim();
  }
  return metadata;
}

// Test seam: surface the helper so tests can stub storage failures by passing
// a persistence override whose load() rejects with storageUnavailableError.
export { storageUnavailableError };
export { API_KEY_SECRET_KEY, METADATA_LOCAL_STORAGE_KEY };
