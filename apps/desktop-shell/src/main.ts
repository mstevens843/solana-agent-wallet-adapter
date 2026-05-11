import './styles.css';
import saturnLogo from './assets/saturn-logo.png';

interface BridgeHealth {
  walletConnected: boolean;
  walletAddress: string | null;
  cluster: string | null;
  rpcUrl: string | null;
  rpcWritable?: { ok: boolean; message: string };
  mainnetEnabled: boolean;
  capsEnabled: boolean;
  preparedActionStorePath: string | null;
}

interface DesktopConfig {
  repoRoot: string;
  bridgeUrl: string;
  bridgeToken: string;
  envPath: string;
  actionConfigPath: string;
  preparedActionsPath: string;
  walletHostUrl: string;
}

interface RuntimeSetup {
  envPath: string;
  envFound: boolean;
  rpcUrlConfigured: boolean;
  rpcUrlRedacted: string | null;
  jupiterApiKeyConfigured: boolean;
  jupiterApiKeyRedacted: string | null;
  jupiterUltraBase: string;
  jupiterApiUrl: string;
  solTransfersReady: boolean;
  tokenTransfersReady: boolean;
  swapsReady: boolean;
}

interface Diagnostic {
  level: 'ok' | 'info' | 'warning' | 'error';
  label: string;
  message: string;
}

interface BridgeStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  bridgeReachable: boolean;
  walletHostRunning: boolean;
  walletHostPid: number | null;
  walletHostStartedAt: string | null;
  walletHostReachable: boolean;
  bridgeUrl: string;
  bridgeToken: string;
  walletHostUrl: string;
  repoRoot: string;
  envPath: string;
  actionConfigPath: string;
  preparedActionsPath: string;
  runtimeMode: 'installed-sidecar' | 'repo-dev-fallback' | 'missing-sidecar';
  sidecarPath: string | null;
  desktopConfigPath: string;
  runtimeDataPath: string;
  releaseVersion: string;
  diagnostics: Diagnostic[];
  lastError: string | null;
}

interface PreparedAction {
  id: string;
  status: string;
  kind: string;
  summary: string;
  dueAt: string;
  txid?: string;
  error?: string;
}

interface Receipt {
  actionId: string;
  status: string;
  summary: string;
  txid?: string;
  completedAt: string;
}

interface DesktopState {
  nativeAvailable: boolean;
  config: DesktopConfig | null;
  runtimeSetup: RuntimeSetup | null;
  nativeStatus: BridgeStatus | null;
  bridgeUrl: string;
  bridgeToken: string;
  health: BridgeHealth | null;
  actions: PreparedAction[];
  receipts: Receipt[];
  logs: string[];
  status: string;
  error: string;
  busy: boolean;
}

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
      };
    };
    __TAURI_INTERNALS__?: {
      invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    };
  }
}

const state: DesktopState = {
  nativeAvailable: false,
  config: null,
  runtimeSetup: null,
  nativeStatus: null,
  bridgeUrl: localStorage.getItem('agent-wallet-desktop-bridge-url') ?? 'http://127.0.0.1:8787',
  bridgeToken: localStorage.getItem('agent-wallet-desktop-token') ?? 'local-agent-wallet',
  health: null,
  actions: [],
  receipts: [],
  logs: [],
  status: 'Bridge not checked yet.',
  error: '',
  busy: false,
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');
const appRoot = app;

render();
void bootstrap();

async function bootstrap(): Promise<void> {
  try {
    state.config = await tauriInvoke<DesktopConfig>('read_config');
    state.nativeAvailable = true;
    state.bridgeUrl = state.config.bridgeUrl;
    state.bridgeToken = state.config.bridgeToken;
    localStorage.setItem('agent-wallet-desktop-bridge-url', state.bridgeUrl);
    localStorage.setItem('agent-wallet-desktop-token', state.bridgeToken);
    await refreshNativeStatus();
    await refreshRuntimeSetup();
  } catch {
    state.nativeAvailable = false;
  }
  await refreshAll();
}

function render(): void {
  const managedRuntime = hasManagedRuntime();
  const runtimeReady = isRuntimeReady();
  const bridgeReachable = state.nativeStatus?.bridgeReachable ?? state.health !== null;
  const displayError = state.error || state.nativeStatus?.lastError || '';
  appRoot.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-logo" src="${saturnLogo}" alt="" />
          <div>
            <p class="eyebrow">Desktop Control Center</p>
            <h1>Agentic</h1>
          </div>
        </div>
        <span class="badge ${state.health?.walletConnected ? 'good' : bridgeReachable ? 'warn' : ''}">
          ${state.health?.walletConnected ? 'wallet connected' : bridgeReachable ? 'runtime reachable' : 'waiting'}
        </span>
      </header>

      <section class="grid">
        <section class="panel setup">
          <div class="panel-title">
            <h2>Local Runtime</h2>
            <span>${state.nativeAvailable ? 'native' : 'browser'}</span>
          </div>
          ${runtimeForm()}
          <div class="actions">
            ${state.nativeAvailable ? `<button id="startBridge" ${state.busy || runtimeReady ? 'disabled' : ''}>Start runtime</button>` : ''}
            ${state.nativeAvailable ? `<button id="stopBridge" ${state.busy || !managedRuntime ? 'disabled' : ''}>Stop</button>` : ''}
            ${state.nativeAvailable ? `<button id="restartBridge" ${state.busy ? 'disabled' : ''}>Restart</button>` : ''}
            <button id="refresh" ${state.busy ? 'disabled' : ''}>Refresh</button>
            <button id="openWalletHost" class="primary" ${state.busy ? 'disabled' : ''}>Open browser wallet host</button>
          </div>
          <p class="hint">Browser extension wallets approve in the external wallet host. This window manages the local Solana Agent Wallet Adapter runtime.</p>
          <p>${escapeHtml(state.status)}</p>
          ${displayError ? `<p class="error">${escapeHtml(displayError)}</p>` : ''}
          ${diagnosticsHtml()}
        </section>

        <section class="panel">
          <h2>Runtime</h2>
          ${metric('Mode', runtimeModeLabel(state.nativeStatus?.runtimeMode))}
          ${metric('Version', state.nativeStatus?.releaseVersion ?? 'Unknown')}
          ${metric('Sidecar', state.nativeStatus?.sidecarPath ? shortPath(state.nativeStatus.sidecarPath) : 'Missing')}
          ${metric('Bridge', runtimeProcessLabel(state.nativeStatus?.running, state.nativeStatus?.pid, bridgeReachable))}
          ${metric('Wallet host', runtimeProcessLabel(state.nativeStatus?.walletHostRunning, state.nativeStatus?.walletHostPid, state.nativeStatus?.walletHostReachable ?? false))}
          ${metric('Wallet', state.health?.walletAddress ? short(state.health.walletAddress) : 'Not connected')}
          ${metric('Cluster', state.health?.cluster ?? 'Unknown')}
          ${metric('Mainnet', state.health?.mainnetEnabled ? 'Enabled' : 'Disabled')}
          ${metric('RPC', state.health?.rpcWritable?.ok ? 'Reachable' : state.health?.rpcWritable?.message ?? 'Unknown')}
        </section>

        ${runtimeSetupPanel()}

        <section class="panel wide">
          <div class="panel-title">
            <h2>Approval Inbox</h2>
            <button id="refreshInbox" ${state.busy ? 'disabled' : ''}>Refresh</button>
          </div>
          ${actionsHtml()}
        </section>

        <section class="panel wide">
          <h2>Receipts</h2>
          ${receiptsHtml()}
        </section>

        <section class="panel wide">
          <h2>Agent Clients</h2>
          <pre>Use the Solana Agent Wallet Adapter MCP tools to show my wallet status.
Use the Solana Agent Wallet Adapter MCP tools to prepare a 0.01 SOL payment to &lt;recipient&gt;.
Approve or reject the request in the external browser wallet host.</pre>
        </section>

        <section class="panel wide">
          <div class="panel-title">
            <h2>Runtime Logs</h2>
            <button id="refreshLogs" ${!state.nativeAvailable ? 'disabled' : ''}>Read logs</button>
          </div>
          <pre>${escapeHtml(state.logs.slice(-18).join('\n') || 'No desktop bridge logs yet.')}</pre>
        </section>
      </section>
    </main>
  `;
  bind();
}

function runtimeForm(): string {
  const config = state.config;
  const repoFallback = state.nativeStatus?.runtimeMode === 'repo-dev-fallback';
  return `
    <label>
      <span>Bridge URL</span>
      <input id="bridgeUrl" value="${escapeHtml(state.bridgeUrl)}" />
    </label>
    <label>
      <span>Bridge token</span>
      <input id="bridgeToken" value="${escapeHtml(state.bridgeToken)}" />
    </label>
    ${state.nativeAvailable && config ? `
      <label>
        <span>Wallet host</span>
        <input id="walletHostUrl" value="${escapeHtml(config.walletHostUrl)}" />
      </label>
      ${repoFallback ? `
        <label>
          <span>Repo root</span>
          <input id="repoRoot" value="${escapeHtml(config.repoRoot)}" />
        </label>
        <label>
          <span>Action config</span>
          <input id="actionConfigPath" value="${escapeHtml(config.actionConfigPath)}" />
        </label>
      ` : ''}
      <label>
        <span>Runtime data</span>
        <input value="${escapeHtml(state.nativeStatus?.runtimeDataPath ?? config.preparedActionsPath)}" disabled />
      </label>
      <button id="saveConfig" ${state.busy ? 'disabled' : ''}>Save runtime config</button>
    ` : ''}
  `;
}

function runtimeSetupPanel(): string {
  const setup = state.runtimeSetup;
  const rpcPlaceholder = setup?.rpcUrlConfigured
    ? `Configured: ${setup.rpcUrlRedacted ?? 'redacted'}`
    : 'https://mainnet.helius-rpc.com/?api-key=...';
  const keyPlaceholder = setup?.jupiterApiKeyConfigured
    ? `Configured: ${setup.jupiterApiKeyRedacted ?? 'redacted'}`
    : 'Paste Jupiter API key';
  return `
    <section class="panel">
      <div class="panel-title">
        <h2>Transaction Setup</h2>
        <span>${setup?.swapsReady ? 'ready' : 'needs setup'}</span>
      </div>
      <div class="setup-grid">
        <label>
          <span>Solana RPC URL</span>
          <input id="setupRpcUrl" type="password" placeholder="${escapeHtml(rpcPlaceholder)}" autocomplete="off" />
        </label>
        <label>
          <span>Jupiter API key</span>
          <input id="setupJupiterApiKey" type="password" placeholder="${escapeHtml(keyPlaceholder)}" autocomplete="off" />
        </label>
        <label>
          <span>Jupiter Ultra base</span>
          <input id="setupJupiterUltraBase" value="${escapeHtml(setup?.jupiterUltraBase ?? 'https://api.jup.ag/ultra/v1')}" />
        </label>
        <label>
          <span>Legacy Jupiter API</span>
          <input id="setupJupiterApiUrl" value="${escapeHtml(setup?.jupiterApiUrl ?? 'https://quote-api.jup.ag')}" />
        </label>
      </div>
      <div class="readiness">
        ${readinessPill('SOL sends', setup?.solTransfersReady ?? false)}
        ${readinessPill('Token sends', setup?.tokenTransfersReady ?? false)}
        ${readinessPill('Swaps', setup?.swapsReady ?? false)}
      </div>
      <div class="actions">
        <button id="saveRuntimeSetup" class="primary" ${state.busy || !state.nativeAvailable ? 'disabled' : ''}>Save setup</button>
        <button id="checkRuntimeSetup" ${state.busy || !state.nativeAvailable ? 'disabled' : ''}>Check setup</button>
      </div>
      <p class="hint">${setup ? `Using ${escapeHtml(setup.envPath)}` : 'Setup is available in the native desktop app.'}</p>
    </section>
  `;
}

function readinessPill(label: string, ready: boolean): string {
  return `<span class="ready-pill ${ready ? 'good' : 'warn'}">${escapeHtml(label)}: ${ready ? 'ready' : 'missing'}</span>`;
}

function diagnosticsHtml(): string {
  const diagnostics = state.nativeStatus?.diagnostics ?? [];
  if (diagnostics.length === 0) return '';
  return `
    <div class="diagnostics">
      ${diagnostics.map((item) => `
        <div class="diagnostic ${escapeHtml(item.level)}">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.message)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function actionsHtml(): string {
  if (state.actions.length === 0) {
    return `<p class="muted">No prepared actions loaded.</p>`;
  }
  return `
    <div class="list">
      ${state.actions.slice(0, 8).map((action) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(action.summary)}</strong>
            <span>${escapeHtml(action.status)} · ${escapeHtml(action.kind)} · ${escapeHtml(action.dueAt)}</span>
            ${action.error ? `<span class="error">${escapeHtml(action.error)}</span>` : ''}
          </div>
          <div class="row-actions">
            <button data-action-op="execute" data-action-id="${escapeHtml(action.id)}">Approve</button>
            <button data-action-op="reject" data-action-id="${escapeHtml(action.id)}">Reject</button>
            <button data-action-op="archive" data-action-id="${escapeHtml(action.id)}">Archive</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function receiptsHtml(): string {
  if (state.receipts.length === 0) {
    return `<p class="muted">No receipts exported yet.</p>`;
  }
  return `
    <div class="list compact">
      ${state.receipts.slice(0, 8).map((receipt) => `
        <div class="row">
          <div>
            <strong>${escapeHtml(receipt.summary)}</strong>
            <span>${escapeHtml(receipt.status)} · ${escapeHtml(receipt.completedAt)}</span>
            ${receipt.txid ? `<span>${escapeHtml(short(receipt.txid))}</span>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function bind(): void {
  document.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => {
    void refreshAll();
  });
  document.querySelector<HTMLButtonElement>('#refreshInbox')?.addEventListener('click', () => {
    void refreshInbox();
  });
  document.querySelector<HTMLButtonElement>('#refreshLogs')?.addEventListener('click', () => {
    void refreshLogs();
  });
  document.querySelector<HTMLButtonElement>('#startBridge')?.addEventListener('click', () => {
    void startBridge();
  });
  document.querySelector<HTMLButtonElement>('#stopBridge')?.addEventListener('click', () => {
    void stopBridge();
  });
  document.querySelector<HTMLButtonElement>('#restartBridge')?.addEventListener('click', () => {
    void restartBridge();
  });
  document.querySelector<HTMLButtonElement>('#saveConfig')?.addEventListener('click', () => {
    void saveNativeConfig();
  });
  document.querySelector<HTMLButtonElement>('#saveRuntimeSetup')?.addEventListener('click', () => {
    void saveRuntimeSetup();
  });
  document.querySelector<HTMLButtonElement>('#checkRuntimeSetup')?.addEventListener('click', () => {
    void checkRuntimeSetup();
  });
  document.querySelector<HTMLButtonElement>('#openWalletHost')?.addEventListener('click', () => {
    void openWalletHost();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-action-op]').forEach((button) => {
    button.addEventListener('click', () => {
      const actionId = button.dataset.actionId;
      const op = button.dataset.actionOp;
      if (actionId && op) void runPreparedAction(actionId, op);
    });
  });
  document.querySelector<HTMLInputElement>('#bridgeUrl')?.addEventListener('input', (event) => {
    state.bridgeUrl = (event.currentTarget as HTMLInputElement).value.trim();
    localStorage.setItem('agent-wallet-desktop-bridge-url', state.bridgeUrl);
  });
  document.querySelector<HTMLInputElement>('#bridgeToken')?.addEventListener('input', (event) => {
    state.bridgeToken = (event.currentTarget as HTMLInputElement).value.trim();
    localStorage.setItem('agent-wallet-desktop-token', state.bridgeToken);
  });
}

async function refreshAll(): Promise<void> {
  state.busy = true;
  render();
  try {
    if (state.nativeAvailable) {
      await refreshNativeStatus();
      await refreshRuntimeSetup();
    }
    await refreshHealth();
    if (state.health) {
      try {
        await refreshInbox();
      } catch (err) {
        state.actions = [];
        state.receipts = [];
        state.error = errorMessage(err);
      }
    } else {
      state.actions = [];
      state.receipts = [];
    }
    try {
      await refreshLogs();
    } catch (err) {
      state.error = state.error || errorMessage(err);
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshNativeStatus(): Promise<void> {
  state.nativeStatus = await tauriInvoke<BridgeStatus>('bridge_status');
  state.bridgeUrl = state.nativeStatus.bridgeUrl;
  state.bridgeToken = state.nativeStatus.bridgeToken;
  if (state.config) {
    state.config = {
      ...state.config,
      repoRoot: state.nativeStatus.repoRoot,
      bridgeUrl: state.nativeStatus.bridgeUrl,
      bridgeToken: state.nativeStatus.bridgeToken,
      envPath: state.nativeStatus.envPath,
      actionConfigPath: state.nativeStatus.actionConfigPath,
      preparedActionsPath: state.nativeStatus.preparedActionsPath,
      walletHostUrl: state.nativeStatus.walletHostUrl,
    };
  }
}

async function refreshRuntimeSetup(): Promise<void> {
  if (!state.nativeAvailable) return;
  state.runtimeSetup = await tauriInvoke<RuntimeSetup>('read_runtime_setup');
}

async function refreshHealth(): Promise<void> {
  state.error = '';
  state.status = 'Checking local bridge...';
  try {
    state.health = await bridgeFetch('/bridge/action/health') as BridgeHealth;
    state.status = state.health.walletConnected
      ? `Ready for wallet approvals from ${short(state.health.walletAddress ?? '')}.`
      : 'Bridge is reachable. Open the wallet host and connect a wallet.';
  } catch (err) {
    state.health = null;
    state.error = errorMessage(err);
    state.status = state.nativeAvailable ? nativeOfflineStatus() : 'Start the local bridge, then refresh.';
  }
}

async function checkRuntimeSetup(): Promise<void> {
  await runNative('Checking transaction setup...', async () => {
    await refreshRuntimeSetup();
    await refreshHealth();
    state.status = state.runtimeSetup?.swapsReady
      ? 'Transaction setup is ready for sends and swaps.'
      : 'Transaction setup is missing RPC or Jupiter credentials.';
  });
}

async function refreshInbox(): Promise<void> {
  const inbox = await bridgeFetch('/bridge/prepared-actions') as { actions?: PreparedAction[] };
  const receipts = await bridgeFetch('/bridge/receipts') as { receipts?: Receipt[] };
  state.actions = inbox.actions ?? [];
  state.receipts = receipts.receipts ?? [];
}

async function refreshLogs(): Promise<void> {
  if (!state.nativeAvailable) return;
  state.logs = await tauriInvoke<string[]>('read_logs');
}

async function startBridge(): Promise<void> {
  await runNative('Starting local runtime...', async () => {
    state.nativeStatus = await tauriInvoke<BridgeStatus>('start_bridge');
    await refreshAll();
  });
}

async function stopBridge(): Promise<void> {
  await runNative('Stopping local runtime...', async () => {
    state.nativeStatus = await tauriInvoke<BridgeStatus>('stop_bridge');
    await refreshAll();
  });
}

async function restartBridge(): Promise<void> {
  await runNative('Restarting local runtime...', async () => {
    state.nativeStatus = await tauriInvoke<BridgeStatus>('restart_bridge');
    await refreshAll();
  });
}

async function saveNativeConfig(): Promise<void> {
  if (!state.config) return;
  await runNative('Saving runtime config...', async () => {
    const repoFallback = state.nativeStatus?.runtimeMode === 'repo-dev-fallback';
    const repoRoot = repoFallback ? inputValue('#repoRoot') || state.config!.repoRoot : state.config!.repoRoot;
    const actionConfigPath = repoFallback
      ? inputValue('#actionConfigPath') || state.config!.actionConfigPath
      : state.config!.actionConfigPath;
    const walletHostUrl = inputValue('#walletHostUrl') || state.config!.walletHostUrl;
    state.config = await tauriInvoke<DesktopConfig>('save_config', {
      config: {
        ...state.config,
        repoRoot,
        bridgeUrl: state.bridgeUrl,
        bridgeToken: state.bridgeToken,
        envPath: repoFallback ? `${repoRoot}/.env` : state.config!.envPath,
        actionConfigPath,
        preparedActionsPath: repoFallback
          ? `${repoRoot}/.agent-wallet/prepared-actions.json`
          : state.config!.preparedActionsPath,
        walletHostUrl,
      },
    });
    await refreshNativeStatus();
  });
}

async function saveRuntimeSetup(): Promise<void> {
  if (!state.nativeAvailable) return;
  await runNative('Saving transaction setup...', async () => {
    const wasRunning = Boolean(state.nativeStatus?.running);
    state.runtimeSetup = await tauriInvoke<RuntimeSetup>('save_runtime_setup', {
      input: {
        rpcUrl: inputValue('#setupRpcUrl'),
        jupiterApiKey: inputValue('#setupJupiterApiKey'),
        jupiterUltraBase: inputValue('#setupJupiterUltraBase'),
        jupiterApiUrl: inputValue('#setupJupiterApiUrl'),
      },
    });
    if (wasRunning) {
      state.status = 'Setup saved. Restarting runtime...';
      state.nativeStatus = await tauriInvoke<BridgeStatus>('restart_bridge');
    } else {
      await refreshNativeStatus();
    }
    await refreshRuntimeSetup();
    await refreshHealth();
  });
}

async function openWalletHost(): Promise<void> {
  if (state.nativeAvailable) {
    await runNative('Opening browser wallet host...', async () => {
      await tauriInvoke<void>('open_wallet_host');
      await refreshNativeStatus();
      await refreshLogs();
    });
    return;
  }
  window.open(browserHostUrl(), '_blank', 'noreferrer');
}

async function runPreparedAction(actionId: string, op: string): Promise<void> {
  const endpoint = op === 'execute'
    ? '/bridge/prepared-actions/execute'
    : op === 'reject'
      ? '/bridge/prepared-actions/reject'
      : '/bridge/prepared-actions/archive';
  await runNative(`${op} ${actionId}...`, async () => {
    await bridgeFetch(endpoint, {
      method: 'POST',
      body: {
        actionId,
        ...(op === 'reject' && { reason: 'Rejected in desktop shell.' }),
      },
    });
    await refreshInbox();
  });
}

async function runNative(message: string, task: () => Promise<void>): Promise<void> {
  state.busy = true;
  state.error = '';
  state.status = message;
  render();
  try {
    await task();
  } catch (err) {
    state.error = errorMessage(err);
    await refreshNativeSnapshot();
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshNativeSnapshot(): Promise<void> {
  if (!state.nativeAvailable) return;
  try {
    await refreshNativeStatus();
  } catch {
    // Keep the original command error visible.
  }
  try {
    await refreshLogs();
  } catch {
    // Keep the original command error visible.
  }
}

async function bridgeFetch(path: string, init?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }): Promise<unknown> {
  const url = new URL(path, ensureTrailingSlash(state.bridgeUrl));
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      'x-agent-wallet-token': state.bridgeToken,
      ...(init?.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke<T>(command, args);
  }
  if (!window.__TAURI_INTERNALS__?.invoke) {
    throw new Error('Tauri runtime is not available.');
  }
  return window.__TAURI_INTERNALS__.invoke<T>(command, args);
}

function browserHostUrl(): string {
  const url = new URL(state.config?.walletHostUrl ?? 'http://127.0.0.1:5174');
  url.searchParams.set('bridgeUrl', state.bridgeUrl);
  url.searchParams.set('token', state.bridgeToken);
  return url.toString();
}

function metric(label: string, value: string): string {
  return `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function inputValue(selector: string): string {
  return document.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-8)}` : value;
}

function shortPath(value: string): string {
  return value.length > 42 ? `...${value.slice(-39)}` : value;
}

function runtimeModeLabel(value: BridgeStatus['runtimeMode'] | undefined): string {
  if (value === 'installed-sidecar') return 'Installed sidecar';
  if (value === 'repo-dev-fallback') return 'Repo dev fallback';
  if (value === 'missing-sidecar') return 'Missing sidecar';
  return state.nativeAvailable ? 'Checking' : 'Browser preview';
}

function runtimeProcessLabel(managed: boolean | undefined, pid: number | null | undefined, reachable: boolean): string {
  if (managed) return `Managed pid ${pid ?? ''}`.trim();
  if (reachable) return 'Reachable';
  return 'Not reachable';
}

function hasManagedRuntime(): boolean {
  return Boolean(state.nativeStatus?.running || state.nativeStatus?.walletHostRunning);
}

function isRuntimeReady(): boolean {
  return Boolean(state.nativeStatus?.bridgeReachable && state.nativeStatus?.walletHostReachable);
}

function nativeOfflineStatus(): string {
  if (state.nativeStatus?.runtimeMode === 'missing-sidecar') {
    return 'Install Agentic with the bundled CLI sidecar or use a repo development checkout.';
  }
  if (state.nativeStatus?.running && !state.nativeStatus.bridgeReachable) {
    return 'Bridge process is managed but not reachable yet. Check runtime logs.';
  }
  return 'Start the desktop runtime, then refresh.';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}
