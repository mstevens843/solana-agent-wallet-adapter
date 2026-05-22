// Tauri host bridge for browser-demo.
//
// IMPORTANT FOR CALLERS: the cloud session token is cached in-memory and
// hydrated lazily from the encrypted file (`desktop-secure.json`, written by
// the Phase-3 `secure_get`/`secure_set`/`secure_delete` Tauri commands in
// `src-tauri/src/lib.rs`). Always call `tauriNativeCloudSessionToken()` at
// the point of use — do NOT capture the return value into a long-lived
// closure or header, because hydration may update the cached value AFTER
// your first read. When hydration finds a newer token, we fire the
// `agentic-cloud-session-rehydrated` window event so the host page can
// refresh its session state.
import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export const CLOUD_SESSION_REHYDRATED_EVENT = 'agentic-cloud-session-rehydrated';

export interface TauriNativeEnvironment {
  isTauriNative: boolean;
  bridgeAvailable: boolean;
}

export interface TauriBridgeStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  bridgeReachable: boolean;
  /** True while restart_bridge is mid-stop-and-start. UI should show
   *  "Restarting…" rather than treating the transient stopped state as a crash. */
  restarting: boolean;
  bridgeUrl: string;
  bridgeToken: string;
  repoRoot: string;
  envPath: string;
  actionConfigPath: string;
  preparedActionsPath: string;
  runtimeMode: 'installed-sidecar' | 'repo-dev-fallback' | 'missing-sidecar';
  sidecarPath: string | null;
  desktopConfigPath: string;
  runtimeDataPath: string;
  releaseVersion: string;
  diagnostics: ReadonlyArray<{ level: string; label: string; message: string }>;
  lastError: string | null;
}

interface TauriInvokeWindow {
  __TAURI_INTERNALS__?: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    /**
     * Tauri 2 exposes the runtime listen/unlisten via this object. The shape
     * is stable across recent v2 releases; we still feature-detect to stay
     * forward-compatible.
     */
    runtime?: {
      listen?<T>(event: string, callback: (event: { event: string; id: number; payload: T }) => void): Promise<() => void>;
    };
  };
  __TAURI__?: {
    event?: {
      listen?<T>(event: string, callback: (event: { event: string; id: number; payload: T }) => void): Promise<() => void>;
    };
  };
}

const CLOUD_SESSION_TOKEN_KEY = 'cloudSessionToken';
const LOCAL_FALLBACK_PREFIX = 'tauri:';

let tokenCacheHydrated = false;
let cachedCloudSessionToken = '';
// Race-safety counter for stronghold hydration. `hydrateTokenFromStronghold`
// snapshots this before awaiting the IPC, then re-checks after; if the count
// changed, a non-hydration write happened in the meantime and we MUST NOT
// overwrite the cache (would cause silent data loss — see Phase 11.1).
let tokenWriteCounter = 0;

export function detectTauriNativeEnvironment(): TauriNativeEnvironment {
  if (typeof window === 'undefined') {
    return { isTauriNative: false, bridgeAvailable: false };
  }
  const candidate = window as TauriInvokeWindow & typeof window;
  const internals = candidate.__TAURI_INTERNALS__;
  return {
    isTauriNative: typeof internals?.invoke === 'function',
    bridgeAvailable: Boolean(internals || candidate.__TAURI__),
  };
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window === 'undefined') {
    throw new ProtocolError('wallet_unreachable', 'Tauri bridge unavailable outside a window context.');
  }
  const candidate = window as TauriInvokeWindow & typeof window;
  const invoke = candidate.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    throw new ProtocolError('wallet_unreachable', 'Tauri bridge is not available; not inside a Tauri webview.');
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new ProtocolError('wallet_unreachable', err instanceof Error ? err.message : String(err));
  }
}

export function tauriNativeCloudSessionToken(): string {
  if (!tokenCacheHydrated) {
    cachedCloudSessionToken = (readLocalFallback(CLOUD_SESSION_TOKEN_KEY) ?? '').trim();
    tokenCacheHydrated = true;
    void hydrateTokenFromStronghold();
  }
  return cachedCloudSessionToken;
}

export async function setTauriNativeCloudSessionToken(token: string): Promise<boolean> {
  const value = (token ?? '').trim();
  cachedCloudSessionToken = value;
  tokenCacheHydrated = true;
  tokenWriteCounter += 1;
  const ok = writeLocalFallback(CLOUD_SESSION_TOKEN_KEY, value);
  try {
    await tauriInvoke<void>('secure_set', { key: CLOUD_SESSION_TOKEN_KEY, value });
  } catch (err) {
    logTauriNative('secure_set', 'FAIL', {
      key: CLOUD_SESSION_TOKEN_KEY,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
  }
  return ok;
}

export async function clearTauriNativeCloudSessionToken(): Promise<boolean> {
  cachedCloudSessionToken = '';
  tokenCacheHydrated = true;
  tokenWriteCounter += 1;
  const ok = clearLocalFallback(CLOUD_SESSION_TOKEN_KEY);
  try {
    await tauriInvoke<void>('secure_delete', { key: CLOUD_SESSION_TOKEN_KEY });
  } catch (err) {
    logTauriNative('secure_delete', 'FAIL', {
      key: CLOUD_SESSION_TOKEN_KEY,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
  }
  return ok;
}

/**
 * Most recent error message from any bridge IPC (start/stop/restart). Cleared
 * when a successful response arrives. Consumers (e.g. tauriLocalRuntime panel)
 * read this when a bridge action returns null to surface the real cause in the
 * UI notice, rather than showing a generic "operation failed" message.
 */
let lastBridgeError: string | null = null;
export function tauriNativeLastBridgeError(): string | null {
  return lastBridgeError;
}

export async function tauriNativeBridgeStatus(): Promise<TauriBridgeStatus | null> {
  try {
    const status = await tauriInvoke<TauriBridgeStatus>('bridge_status');
    lastBridgeError = null;
    return status;
  } catch (err) {
    lastBridgeError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

export async function tauriNativeStartBridge(): Promise<TauriBridgeStatus | null> {
  try {
    const status = await tauriInvoke<TauriBridgeStatus>('start_bridge');
    lastBridgeError = null;
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastBridgeError = message;
    logTauriNative('start_bridge', 'FAIL', { error: message }, 'warn');
    return null;
  }
}

export async function tauriNativeStopBridge(): Promise<TauriBridgeStatus | null> {
  try {
    const status = await tauriInvoke<TauriBridgeStatus>('stop_bridge');
    lastBridgeError = null;
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastBridgeError = message;
    logTauriNative('stop_bridge', 'FAIL', { error: message }, 'warn');
    return null;
  }
}

export async function tauriNativeRestartBridge(): Promise<TauriBridgeStatus | null> {
  try {
    const status = await tauriInvoke<TauriBridgeStatus>('restart_bridge');
    lastBridgeError = null;
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastBridgeError = message;
    logTauriNative('restart_bridge', 'FAIL', { error: message }, 'warn');
    return null;
  }
}

export async function tauriNativeReadLogs(): Promise<ReadonlyArray<string>> {
  try {
    return await tauriInvoke<string[]>('read_logs');
  } catch {
    return [];
  }
}

/**
 * Subscribe to a Tauri runtime event. Returns an unsubscribe function, or null
 * when not inside a Tauri webview (so the caller can no-op). Used to receive
 * the `agentic://deep-link` event emitted by lib.rs's deep-link setup hook.
 *
 * We feature-detect both internal and public Tauri APIs so the listener works
 * across recent Tauri 2 patch releases without pinning to a specific surface.
 */
export async function tauriListenEvent<T>(
  eventName: string,
  callback: (payload: T) => void,
): Promise<(() => void) | null> {
  if (typeof window === 'undefined') return null;
  const candidate = window as TauriInvokeWindow & typeof window;
  const listenFn =
    candidate.__TAURI_INTERNALS__?.runtime?.listen
    ?? candidate.__TAURI__?.event?.listen;
  if (typeof listenFn !== 'function') return null;
  try {
    const unlisten = await listenFn<T>(eventName, (event) => {
      callback(event.payload);
    });
    return typeof unlisten === 'function' ? unlisten : null;
  } catch {
    return null;
  }
}

/**
 * Event name dispatched on `window` whenever the deep-link plugin forwards an
 * `agentic://...` URL from the OS to the webview. Listeners receive the URL
 * list in `event.detail`.
 */
export const TAURI_DEEP_LINK_EVENT = 'agentic-tauri-deep-link';

/**
 * Reads a set of env keys from the local bridge .env file. Returns a map of
 * key -> value (or null when the key is not set). Used by Preferences > Local
 * runtime to populate BYO keys (Helius, CoinGecko, etc.) when the user is not
 * signed in to the cloud or wants per-machine overrides.
 */
export async function tauriNativeReadEnvKeys(keys: ReadonlyArray<string>): Promise<Record<string, string | null>> {
  try {
    return await tauriInvoke<Record<string, string | null>>('read_env_keys', { keys: [...keys] });
  } catch (err) {
    logTauriNative('read_env_keys', 'FAIL', {
      keys,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return Object.fromEntries(keys.map((key) => [key, null]));
  }
}

/**
 * Writes env keys to the local bridge .env file. Pass an empty string to clear
 * a key. The map is merged into the existing file; unrelated keys are preserved.
 */
export async function tauriNativeWriteEnvKeys(updates: Record<string, string>): Promise<boolean> {
  try {
    await tauriInvoke<void>('write_env_keys', { updates });
    return true;
  } catch (err) {
    logTauriNative('write_env_keys', 'FAIL', {
      keys: Object.keys(updates),
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return false;
  }
}

/**
 * Opens a URL in the host operating system's default browser. Used by the
 * Tauri wallet flow when a Wallet Standard wallet is not injected into the
 * webview (e.g. user has Phantom Mobile / a browser-only wallet) — Tauri
 * launches Phantom Web in the external browser, the user signs there, and
 * the proof returns via a Phase 4 deep-link relay.
 */
export async function tauriNativeOpenExternalUrl(url: string): Promise<boolean> {
  try {
    await tauriInvoke<void>('open_external_url', { url });
    return true;
  } catch (err) {
    logTauriNative('open_external_url', 'FAIL', {
      url,
      error: err instanceof Error ? err.message : String(err),
    }, 'warn');
    return false;
  }
}

async function hydrateTokenFromStronghold(): Promise<void> {
  // Snapshot the write counter BEFORE the IPC. If any setTauri/clearTauri
  // call runs while we are awaiting the stronghold response, the counter
  // changes and we MUST skip the cache overwrite — otherwise hydration would
  // clobber a freshly-set token with the older stronghold value (data loss).
  const writeCountBefore = tokenWriteCounter;
  try {
    const value = await tauriInvoke<string | null>('secure_get', { key: CLOUD_SESSION_TOKEN_KEY });
    if (tokenWriteCounter !== writeCountBefore) {
      // A non-hydration write completed during the await. Trust the live cache.
      return;
    }
    const next = (value ?? '').trim();
    if (next && next !== cachedCloudSessionToken) {
      cachedCloudSessionToken = next;
      writeLocalFallback(CLOUD_SESSION_TOKEN_KEY, next);
      // Notify listeners (e.g. main.ts bootstrap) that the cached token was
      // updated by an out-of-band source so they can refresh derived state.
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent(CLOUD_SESSION_REHYDRATED_EVENT));
        } catch {
          // CustomEvent unavailable in some test environments; non-fatal.
        }
      }
    }
  } catch {
    // Phase-3 file-backed secure store unavailable (e.g. running outside Tauri,
    // or the bridge has not yet registered commands). The localStorage value is
    // already cached as the fallback; no further action required.
  }
}

function readLocalFallback(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(`${LOCAL_FALLBACK_PREFIX}${key}`);
  } catch {
    return null;
  }
}

function writeLocalFallback(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (value) {
      window.localStorage.setItem(`${LOCAL_FALLBACK_PREFIX}${key}`, value);
    } else {
      window.localStorage.removeItem(`${LOCAL_FALLBACK_PREFIX}${key}`);
    }
    return true;
  } catch {
    return false;
  }
}

function clearLocalFallback(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.removeItem(`${LOCAL_FALLBACK_PREFIX}${key}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only: reset the in-memory token cache so the next read re-hydrates
 * from localStorage. Guarded so production callers fail fast — vitest sets
 * import.meta.env.MODE = 'test' and dev builds set DEV = true.
 */
export function __resetTauriNativeTokenCacheForTests(): void {
  const viteEnv = (import.meta as ImportMeta & { env?: { DEV?: boolean; MODE?: string } }).env;
  if (!viteEnv?.DEV && viteEnv?.MODE !== 'test') {
    throw new Error('__resetTauriNativeTokenCacheForTests is a test-only helper and must not run in production.');
  }
  tokenCacheHydrated = false;
  cachedCloudSessionToken = '';
  tokenWriteCounter = 0;
}

function logTauriNative(
  operation: string,
  phase: 'START' | 'SUCCESS' | 'FAIL',
  fields: Record<string, unknown>,
  level: 'info' | 'warn' = 'info',
): void {
  const details = Object.entries(fields)
    .map(([key, value]) => {
      try {
        return `${key}=${JSON.stringify(value)}`;
      } catch {
        return `${key}=[unserializable]`;
      }
    })
    .join(' ');
  const line = `[AgentTauriNative] ${operation} | ${phase}${details ? ` ${details}` : ''}`;
  if (level === 'warn') {
    console.warn(line);
  } else {
    console.info(line);
  }
}
