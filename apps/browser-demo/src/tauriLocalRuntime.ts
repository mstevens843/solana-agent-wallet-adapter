// Tauri-only "Local runtime" preferences panel.
//
// Two responsibilities:
// 1) Bridge control — show status of the local MCP bridge sidecar, with
//    Start / Stop / Restart buttons that proxy to lib.rs IPC. Polls every
//    5s while mounted so the global `state.tauriBridgeStatus` stays fresh.
// 2) Local env-key editor — read/write BYO API keys to the bridge's .env
//    file. After a successful save the user is prompted to Restart the
//    bridge because the bridge only reads .env at process startup.
//
// Backed by the Tauri commands in src-tauri/src/lib.rs:
//   - bridge_status, start_bridge, stop_bridge, restart_bridge
//   - read_env_keys, write_env_keys

import {
  detectTauriNativeEnvironment,
  tauriNativeBridgeStatus,
  tauriNativeLastBridgeError,
  tauriNativeReadEnvKeys,
  tauriNativeRestartBridge,
  tauriNativeStartBridge,
  tauriNativeStopBridge,
  tauriNativeWriteEnvKeys,
  type TauriBridgeStatus,
} from './tauriNative.js';
import {
  AI_CONNECTORS,
  aiConnectorPreset,
  type AiConnector,
} from './planner.js';

interface FieldDef {
  key: string;
  label: string;
  detail: string;
  placeholder: string;
  isUrl?: boolean;
}

const FIELDS: ReadonlyArray<FieldDef> = [
  { key: 'SOLANA_RPC_URL', label: 'Solana RPC URL', detail: 'Helius or any Solana mainnet RPC. The bridge falls back to public RPC if blank.', placeholder: 'https://mainnet.helius-rpc.com/?api-key=...', isUrl: true },
  { key: 'HELIUS_API_KEY', label: 'Helius API key', detail: 'Used for parsed transaction history and enhanced reads (optional).', placeholder: 'helius-…' },
  { key: 'JUPITER_API_KEY', label: 'Jupiter API key', detail: 'Optional — speeds up swap-quote requests and unlocks higher rate limits.', placeholder: 'jup-…' },
  { key: 'BIRDEYE_API_KEY', label: 'Birdeye API key', detail: 'Used for token evidence (price, holders, security).', placeholder: 'birdeye-…' },
  { key: 'COINGECKO_API_KEY', label: 'CoinGecko API key', detail: 'Used for token price evidence when Birdeye is unavailable.', placeholder: 'CG-…' },
  { key: 'MAGICEDEN_API_KEY', label: 'Magic Eden API key', detail: 'Required for Magic Eden first-class NFT actions on the local bridge.', placeholder: 'me-…' },
  { key: 'TENSOR_API_KEY', label: 'Tensor API key', detail: 'Required for Tensor first-class NFT actions on the local bridge.', placeholder: 'tensor-…' },
  { key: 'SANCTUM_API_KEY', label: 'Sanctum API key', detail: 'Required for Sanctum LST routing reads on the local bridge.', placeholder: 'sanctum-…' },
  { key: 'AGENTIC_AI_PROVIDER', label: 'Local Bridge AI provider', detail: 'Provider name used by the local bridge when AGENTIC_AI_API_KEY is configured.', placeholder: 'openai' },
  { key: 'AGENTIC_AI_API_FORMAT', label: 'Local Bridge AI format', detail: 'Provider API format for local bridge AI requests.', placeholder: 'openai-compatible' },
  { key: 'AGENTIC_AI_API_KEY', label: 'Local Bridge AI provider key', detail: 'Optional persistent provider key for Local Bridge AI. It is written to this machine only.', placeholder: 'sk-…' },
  { key: 'AGENTIC_AI_MODEL', label: 'Local Bridge AI model', detail: 'Model used by Local Bridge AI when the env-backed provider key is configured.', placeholder: 'gpt-5' },
  { key: 'AGENTIC_AI_BASE_URL', label: 'Local Bridge AI base URL', detail: 'Base URL for OpenAI-compatible or provider-native local bridge AI requests.', placeholder: 'https://api.openai.com/v1', isUrl: true },
];

const AI_ENGINE_KEY = 'AGENTIC_AI_ENGINE';
const AI_CONNECTOR_KEY = 'AGENTIC_AI_CONNECTOR';
const AI_CONNECTOR_PATH_KEY = 'AGENTIC_AI_CONNECTOR_PATH';
const ENV_KEYS: ReadonlyArray<string> = [
  ...FIELDS.map((field) => field.key),
  AI_ENGINE_KEY,
  AI_CONNECTOR_KEY,
  AI_CONNECTOR_PATH_KEY,
];
type AiEngine = 'api-key' | 'connector';

// Empirically-chosen polling cadence: 5s is short enough that a bridge crash
// is reflected in the UI within one tick, but long enough that the IPC call
// + mutex acquire don't show up in CPU usage on slow machines. Tightening below
// ~2s noticeably increases idle CPU on macOS Activity Monitor.
const BRIDGE_POLL_MS = 5_000;
const BRIDGE_STATUS_EVENT = 'agentic-tauri-bridge-status';

type Values = Record<string, string>;

interface PanelState {
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  draft: Values;
  saved: Values;
  notice: { tone: 'success' | 'error' | 'info'; message: string } | null;
  needsRestart: boolean;
  bridge: TauriBridgeStatus | null;
  bridgeBusy: 'start' | 'stop' | 'restart' | null;
}

const state: PanelState = {
  loaded: false,
  loading: false,
  saving: false,
  draft: {},
  saved: {},
  notice: null,
  needsRestart: false,
  bridge: null,
  bridgeBusy: null,
};

let mountedContainer: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityHandlerInstalled = false;

export function __resetTauriLocalRuntimePanelStateForTests(): void {
  state.loaded = false;
  state.loading = false;
  state.saving = false;
  state.draft = {};
  state.saved = {};
  state.notice = null;
  state.needsRestart = false;
  state.bridge = null;
  state.bridgeBusy = null;
  mountedContainer = null;
  stopPolling();
}

export function isTauriLocalRuntimeAvailable(): boolean {
  return detectTauriNativeEnvironment().isTauriNative;
}

export function mountTauriLocalRuntimePanel(containerId: string): void {
  const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
  if (!container) {
    stopPolling();
    mountedContainer = null;
    return;
  }
  mountedContainer = container;
  if (!isTauriLocalRuntimeAvailable()) {
    container.innerHTML = '';
    stopPolling();
    return;
  }
  if (!state.loaded && !state.loading) {
    void loadValues();
  }
  void refreshBridgeStatus();
  startPolling();
  render();
}

function startPolling(): void {
  if (pollTimer !== null) return;
  if (typeof window === 'undefined') return;
  pollTimer = setInterval(() => {
    // Skip the IPC round-trip when the tab/window is hidden — the user can't
    // see the panel, and bridge status will be re-fetched the moment they
    // bring the window back to the foreground via the visibilitychange handler.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    void refreshBridgeStatus();
  }, BRIDGE_POLL_MS);
  installVisibilityHandler();
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function installVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mountedContainer && pollTimer !== null) {
      void refreshBridgeStatus();
    }
  });
}

async function refreshBridgeStatus(): Promise<void> {
  const next = await tauriNativeBridgeStatus();
  state.bridge = next;
  emitBridgeStatus(next);
  if (mountedContainer) {
    renderBridgePanel();
  }
}

function emitBridgeStatus(status: TauriBridgeStatus | null): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent(BRIDGE_STATUS_EVENT, { detail: status }));
  } catch {
    // CustomEvent unavailable in some environments — non-fatal.
  }
}

/**
 * Event name dispatched on `window` whenever the bridge-status poll completes
 * or a user-initiated start/stop/restart returns. Listeners receive the new
 * `TauriBridgeStatus | null` in `event.detail`. main.ts uses this to keep
 * `state.tauriBridgeStatus` in sync so device-agent routing stays current.
 */
export const TAURI_BRIDGE_STATUS_EVENT = BRIDGE_STATUS_EVENT;

async function loadValues(): Promise<void> {
  state.loading = true;
  render();
  const result = await tauriNativeReadEnvKeys(ENV_KEYS);
  const next: Values = {};
  for (const key of ENV_KEYS) {
    next[key] = (result[key] ?? '').trim();
  }
  state.saved = next;
  state.draft = { ...next };
  state.loaded = true;
  state.loading = false;
  render();
}

async function persistValues(): Promise<void> {
  state.saving = true;
  state.notice = null;
  render();
  const updates: Values = {};
  for (const key of ENV_KEYS) {
    const next = (state.draft[key] ?? '').trim();
    const prev = (state.saved[key] ?? '').trim();
    if (next !== prev) {
      updates[key] = next;
    }
  }
  if (Object.keys(updates).length === 0) {
    state.saving = false;
    state.notice = { tone: 'info', message: 'No changes to save.' };
    render();
    return;
  }
  const ok = await tauriNativeWriteEnvKeys(updates);
  state.saving = false;
  if (ok) {
    state.saved = { ...state.draft };
    state.notice = { tone: 'success', message: 'Saved local runtime keys.' };
    // The bridge only reads .env at process start. Tell the user to restart
    // it so the new keys take effect.
    state.needsRestart = state.bridge?.running ? true : false;
  } else {
    state.notice = { tone: 'error', message: 'Failed to write the local .env. Check that the bridge runtime data dir is writable.' };
  }
  render();
}

async function bridgeAction(action: 'start' | 'stop' | 'restart'): Promise<void> {
  state.bridgeBusy = action;
  state.notice = null;
  render();
  const next = action === 'start'
    ? await tauriNativeStartBridge()
    : action === 'stop'
      ? await tauriNativeStopBridge()
      : await tauriNativeRestartBridge();
  state.bridgeBusy = null;
  if (next) {
    state.bridge = next;
    emitBridgeStatus(next);
    if (action !== 'stop' && next.lastError) {
      state.notice = { tone: 'error', message: next.lastError };
    } else if (action === 'restart') {
      state.notice = { tone: 'success', message: 'Bridge restarted.' };
      state.needsRestart = false;
    } else if (action === 'start' && next.running) {
      state.notice = { tone: 'success', message: 'Bridge started.' };
      state.needsRestart = false;
    } else if (action === 'stop' && !next.running) {
      state.notice = { tone: 'info', message: 'Bridge stopped.' };
    }
  } else {
    const detail = tauriNativeLastBridgeError();
    state.notice = {
      tone: 'error',
      message: detail
        ? `Bridge ${action} failed: ${detail}`
        : `Bridge ${action} failed. See the bridge log in the runtime data directory.`,
    };
  }
  render();
}

function render(): void {
  if (!mountedContainer) return;
  if (!isTauriLocalRuntimeAvailable()) {
    mountedContainer.innerHTML = '';
    return;
  }
  const dirty = hasDirtyValues();
  const hasAnyConfigured = ENV_KEYS.some((key) => (state.saved[key] ?? '').trim() !== '');
  const advancedOpenAttr = hasAnyConfigured ? ' open' : '';
  const noticeHtml = state.notice
    ? `<p class="tauri-local-runtime-notice tone-${state.notice.tone}" role="status" aria-live="polite">${escapeHtml(state.notice.message)}</p>`
    : '';
  const restartPromptHtml = state.needsRestart
    ? `<p class="tauri-local-runtime-notice tone-info tauri-local-runtime-restart-prompt" role="status" aria-live="polite">New keys saved. The local bridge needs to restart to pick them up. <button type="button" data-tauri-runtime-action="restart-after-save">Restart bridge now</button></p>`
    : '';
  const rowsHtml = FIELDS.map((field) => {
    const value = state.draft[field.key] ?? '';
    const id = `tauri-runtime-${field.key.toLowerCase()}`;
    return `
      <label class="connector-keys-card" for="${id}">
        <header>
          <h4>${escapeHtml(field.label)}</h4>
          <p>${escapeHtml(field.detail)}</p>
        </header>
        <input
          id="${id}"
          name="${field.key}"
          type="${field.isUrl ? 'url' : 'password'}"
          autocomplete="off"
          spellcheck="false"
          placeholder="${escapeHtml(field.placeholder)}"
          value="${escapeHtml(value)}"
          data-tauri-runtime-field="${field.key}"
        />
      </label>
    `;
  }).join('');
  mountedContainer.innerHTML = `
    ${bridgePanelHtml()}
    <section class="connector-keys-panel tauri-local-runtime-panel" aria-labelledby="tauri-local-runtime-title">
      <header>
        <h3 id="tauri-local-runtime-title">Local runtime keys (Desktop)</h3>
        <p>All fields below are optional. Agentic Desktop picks the right agent automatically — Hosted (when signed in to Agentic Cloud) or on-device — and both run policy gates against the operator's market-data APIs. Fill in market-data keys, choose a subscription connector, or add your own AI provider key only if you want the local bridge to run those calls on this machine. Settings saved here are written to the local bridge's .env file and never leave your machine.</p>
      </header>
      ${state.loading ? '<p class="connector-keys-status">Loading…</p>' : ''}
      ${noticeHtml}
      ${restartPromptHtml}
      ${localBridgeAiEngineControlsHtml()}
      <details class="tauri-local-runtime-advanced"${advancedOpenAttr}>
        <summary>Advanced: provider and market-data API keys</summary>
        <div class="connector-keys-grid">${rowsHtml}</div>
      </details>
      <div class="tauri-local-runtime-actions">
        <button type="button" data-tauri-runtime-action="save" ${state.saving || !dirty ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save'}</button>
        <button type="button" data-tauri-runtime-action="reload" ${state.loading || state.saving ? 'disabled' : ''}>Reload from disk</button>
      </div>
    </section>
  `;
  attachEventHandlers();
}

function localBridgeAiEngineControlsHtml(): string {
  const engine = normalizeAiEngine(state.draft[AI_ENGINE_KEY]);
  const selected = normalizeAiConnector(state.draft[AI_CONNECTOR_KEY]);
  const connectorPath = state.draft[AI_CONNECTOR_PATH_KEY] ?? '';
  const choices = AI_CONNECTORS.map((preset) => `
    <button
      type="button"
      class="bridge-connector-choice ${engine === 'connector' && selected === preset.id ? 'active' : ''}"
      data-tauri-runtime-connector="${escapeHtml(preset.id)}"
      ${state.saving ? 'disabled' : ''}
    >
      <strong>${escapeHtml(preset.label)}</strong>
      <span>${escapeHtml(preset.billingNote)}</span>
    </button>
  `).join('');
  const connectorBody = engine === 'connector'
    ? `
      <div class="bridge-connector-section">
        <p class="bridge-connector-note">Use a subscription you already pay for. The local bridge shells out to the selected CLI on this machine; no AI provider API key is required.</p>
        <div class="bridge-connector-choices">${choices}</div>
        <label class="connector-keys-card tauri-connector-path-field" for="tauri-runtime-agentic-ai-connector-path">
          <header>
            <h4>Connector CLI path</h4>
            <p>Optional. Leave blank to use the default command for ${escapeHtml(aiConnectorPreset(selected).label)}.</p>
          </header>
          <input
            id="tauri-runtime-agentic-ai-connector-path"
            name="${AI_CONNECTOR_PATH_KEY}"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Optional absolute path"
            value="${escapeHtml(connectorPath)}"
            data-tauri-runtime-field="${AI_CONNECTOR_PATH_KEY}"
          />
        </label>
      </div>
    `
    : '<p class="bridge-connector-note">Provider API key mode uses the AI provider fields in Advanced. Subscription connector mode uses Codex, Gemini, or Claude CLI auth instead.</p>';
  return `
    <section class="tauri-local-ai-engine" aria-labelledby="tauri-local-ai-engine-title">
      <header>
        <h4 id="tauri-local-ai-engine-title">Local Bridge AI engine</h4>
        <p>Choose how the local bridge should run AI Connector.</p>
      </header>
      <div class="bridge-engine-toggle" role="group" aria-label="Local Bridge AI engine">
        <button type="button" class="utility ${engine === 'api-key' ? 'active' : ''}" data-tauri-runtime-engine="api-key" ${state.saving ? 'disabled' : ''}>Provider API key</button>
        <button type="button" class="utility ${engine === 'connector' ? 'active' : ''}" data-tauri-runtime-engine="connector" ${state.saving ? 'disabled' : ''}>Subscription connector</button>
      </div>
      ${connectorBody}
    </section>
  `;
}

function renderBridgePanel(): void {
  if (!mountedContainer) return;
  // Use innerHTML on a stable host element so the host node identity is
  // preserved across renders — outerHTML swaps would replace the element
  // and lose any handlers attached during the brief window between swap
  // and reattach. The host element is rendered as part of the full render
  // (`bridgePanelHtml` returns the host wrapper + section content).
  const host = mountedContainer.querySelector<HTMLElement>('[data-tauri-bridge-host]');
  if (!host) {
    render();
    return;
  }
  host.innerHTML = bridgePanelInnerHtml();
  attachBridgeHandlers();
}

function bridgePanelHtml(): string {
  return `<div data-tauri-bridge-host>${bridgePanelInnerHtml()}</div>`;
}

function bridgePanelInnerHtml(): string {
  const status = state.bridge;
  const running = status?.running ?? false;
  const reachable = status?.bridgeReachable ?? false;
  const restarting = status?.restarting ?? false;
  const busy = state.bridgeBusy;
  const dotTone = restarting ? 'warn' : running && reachable ? 'success' : running ? 'warn' : 'idle';
  const summary = restarting
    ? `Restarting…`
    : running && reachable
      ? `Running (pid ${status?.pid ?? '?'}) at ${status?.bridgeUrl ?? '127.0.0.1:8787'}`
      : running
        ? `Process running but bridge endpoint is not yet reachable.`
        : `Stopped. Start it to enable local-bridge mode.`;
  const lastError = status?.lastError ? `<p class="tauri-local-runtime-error" role="alert">${escapeHtml(status.lastError)}</p>` : '';
  return `
    <section class="connector-keys-panel tauri-bridge-panel" aria-labelledby="tauri-bridge-title">
      <header>
        <h3 id="tauri-bridge-title">Local bridge</h3>
        <p>Local MCP bridge sidecar — required for offline / cloud-less operation and to back the "Local Bridge" AI mode.</p>
      </header>
      <p class="tauri-bridge-status">
        <span aria-hidden="true" class="tauri-bridge-dot tauri-bridge-dot-${dotTone}"></span>
        <span>${escapeHtml(summary)}</span>
      </p>
      ${lastError}
      <div class="tauri-local-runtime-actions">
        <button type="button" data-tauri-bridge-action="start" ${busy !== null || running ? 'disabled' : ''}>${busy === 'start' ? 'Starting…' : 'Start'}</button>
        <button type="button" data-tauri-bridge-action="stop" ${busy !== null || !running ? 'disabled' : ''}>${busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
        <button type="button" data-tauri-bridge-action="restart" ${busy !== null || !running ? 'disabled' : ''}>${busy === 'restart' ? 'Restarting…' : 'Restart'}</button>
      </div>
    </section>
  `;
}

function attachEventHandlers(): void {
  if (!mountedContainer) return;
  attachBridgeHandlers();
  const inputs = mountedContainer.querySelectorAll<HTMLInputElement>('[data-tauri-runtime-field]');
  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.tauriRuntimeField;
      if (!key) return;
      state.draft[key] = input.value;
      // Don't re-render on each keystroke — just toggle the save button enabled.
      syncSaveButton();
    });
  });
  mountedContainer.querySelectorAll<HTMLButtonElement>('[data-tauri-runtime-engine]').forEach((button) => {
    button.addEventListener('click', () => {
      const engine = button.dataset.tauriRuntimeEngine === 'connector' ? 'connector' : 'api-key';
      if (engine === 'connector') {
        state.draft[AI_ENGINE_KEY] = 'connector';
        state.draft[AI_CONNECTOR_KEY] = normalizeAiConnector(state.draft[AI_CONNECTOR_KEY]);
      } else {
        state.draft[AI_ENGINE_KEY] = '';
        state.draft[AI_CONNECTOR_KEY] = '';
        state.draft[AI_CONNECTOR_PATH_KEY] = '';
      }
      render();
    });
  });
  mountedContainer.querySelectorAll<HTMLButtonElement>('[data-tauri-runtime-connector]').forEach((button) => {
    button.addEventListener('click', () => {
      const connector = normalizeAiConnector(button.dataset.tauriRuntimeConnector);
      state.draft[AI_ENGINE_KEY] = 'connector';
      state.draft[AI_CONNECTOR_KEY] = connector;
      render();
    });
  });
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-runtime-action="save"]')?.addEventListener('click', () => {
    void persistValues();
  });
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-runtime-action="reload"]')?.addEventListener('click', () => {
    void loadValues();
  });
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-runtime-action="restart-after-save"]')?.addEventListener('click', () => {
    void bridgeAction('restart');
  });
}

function hasDirtyValues(): boolean {
  return ENV_KEYS.some((key) => (state.draft[key] ?? '').trim() !== (state.saved[key] ?? '').trim());
}

function syncSaveButton(): void {
  const saveButton = mountedContainer?.querySelector<HTMLButtonElement>('[data-tauri-runtime-action="save"]');
  if (saveButton) {
    saveButton.disabled = state.saving || !hasDirtyValues();
  }
}

function normalizeAiEngine(value: string | undefined): AiEngine {
  return value?.trim().toLowerCase() === 'connector' ? 'connector' : 'api-key';
}

function normalizeAiConnector(value: string | undefined): AiConnector {
  return value === 'codex' || value === 'gemini' || value === 'claude' ? value : 'codex';
}

function attachBridgeHandlers(): void {
  if (!mountedContainer) return;
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-bridge-action="start"]')?.addEventListener('click', () => {
    void bridgeAction('start');
  });
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-bridge-action="stop"]')?.addEventListener('click', () => {
    void bridgeAction('stop');
  });
  mountedContainer.querySelector<HTMLButtonElement>('[data-tauri-bridge-action="restart"]')?.addEventListener('click', () => {
    void bridgeAction('restart');
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&#39;';
      default: return char;
    }
  });
}
