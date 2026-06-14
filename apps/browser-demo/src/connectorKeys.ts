// BYO-API-key UX for the cloud workspace.
//
// Magic Eden, Tensor, Sanctum, and Lulo require per-user API keys obtained
// from each connector's developer portal. The cloud persists these per-wallet
// encrypted (see apps/render-web/src/cloud/connectorSecrets.ts) and injects
// them into the prepare-transaction path at request time. This module is the
// user-facing UX for managing those keys.

export const BYO_KEY_CONNECTOR_IDS = ['magiceden', 'tensor', 'sanctum', 'lulo', 'phoenix'] as const;
export type ByoKeyConnectorId = (typeof BYO_KEY_CONNECTOR_IDS)[number];

export interface ByoKeyConnectorMeta {
  id: ByoKeyConnectorId;
  label: string;
  description: string;
  portalUrl: string;
  defaultBaseUrl: string;
  // Phoenix uses an invite/activation code, not a per-request API key. These overrides
  // let each connector customize the BYO card labels; defaults match the historic
  // "API key" copy when omitted.
  addButtonLabel?: string;
  formFieldLabel?: string;
  formPlaceholderTemplate?: (label: string) => string;
  portalLinkLabel?: string;
}

export const BYO_KEY_CONNECTOR_META: Record<ByoKeyConnectorId, ByoKeyConnectorMeta> = {
  magiceden: {
    id: 'magiceden',
    label: 'Magic Eden',
    description: 'NFT marketplace bids, listings, and buys on Solana mainnet.',
    portalUrl: 'https://docs.magiceden.io/reference/getting-started',
    defaultBaseUrl: 'https://api-mainnet.magiceden.dev/v2',
  },
  tensor: {
    id: 'tensor',
    label: 'Tensor',
    description: 'NFT marketplace bids, listings, and sweep on Solana mainnet.',
    portalUrl: 'https://docs.tensor.trade/',
    defaultBaseUrl: 'https://api.mainnet.tensordev.io/api/v1',
  },
  sanctum: {
    id: 'sanctum',
    label: 'Sanctum',
    description: 'Liquid staking token routing and Infinity pool.',
    portalUrl: 'https://docs.sanctum.so/',
    defaultBaseUrl: 'https://sanctum-api.ironforge.network',
  },
  lulo: {
    id: 'lulo',
    label: 'Lulo',
    description: 'Protected, Boost, and Regular lending: rates, balances, deposits, and withdrawals.',
    portalUrl: 'https://app.lulo.fi/',
    defaultBaseUrl: 'https://api.lulo.fi',
  },
  phoenix: {
    id: 'phoenix',
    label: 'Phoenix Perpetuals',
    description: 'Perp futures on Solana (Ellipsis Labs). Paste the invite/activation code from your Phoenix waitlist email; it activates your wallet as a trader on first use.',
    portalUrl: 'https://www.phoenix.trade',
    defaultBaseUrl: 'https://perp-api.phoenix.trade',
    addButtonLabel: 'Add access code',
    formFieldLabel: 'Access code',
    formPlaceholderTemplate: (label) => `Paste your ${label} invite/activation code`,
    portalLinkLabel: 'Request an access code →',
  },
};

export interface ConnectorSecretSummary {
  hasKey: boolean;
  baseUrl?: string;
  savedAt?: string;
}

export type ConnectorSecretsSummary = Record<ByoKeyConnectorId, ConnectorSecretSummary>;

export interface ListConnectorSecretsResponse {
  secrets: ConnectorSecretsSummary;
  available: boolean;
}

export interface SaveConnectorSecretInput {
  apiKey: string;
  baseUrl?: string;
}

const EMPTY_SECRETS_SUMMARY: ConnectorSecretsSummary = Object.fromEntries(
  BYO_KEY_CONNECTOR_IDS.map((id) => [id, { hasKey: false } as ConnectorSecretSummary]),
) as ConnectorSecretsSummary;

export async function listConnectorSecrets(): Promise<ListConnectorSecretsResponse> {
  const response = await fetch('/api/connector-secrets', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  // 404 means the cloud router isn't reachable from this origin — common when running
  // browser-demo via plain `vite dev` without a `/api/*` proxy. Surface it as
  // "feature unavailable" instead of a scary error so the section degrades gracefully.
  if (response.status === 404) {
    return { available: false, secrets: EMPTY_SECRETS_SUMMARY };
  }
  if (!response.ok) {
    throw await responseError(response, 'Failed to load saved connector credentials.');
  }
  return (await response.json()) as ListConnectorSecretsResponse;
}

export async function saveConnectorSecret(
  connector: ByoKeyConnectorId,
  input: SaveConnectorSecretInput,
): Promise<ConnectorSecretSummary & { connector: ByoKeyConnectorId }> {
  const response = await fetch(`/api/connector-secrets/${connector}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    }),
  });
  if (!response.ok) {
    throw await responseError(response, `Failed to save ${connectorDisplayCredential(connector)}.`);
  }
  return (await response.json()) as ConnectorSecretSummary & { connector: ByoKeyConnectorId };
}

export async function deleteConnectorSecret(
  connector: ByoKeyConnectorId,
): Promise<{ removed: boolean }> {
  const response = await fetch(`/api/connector-secrets/${connector}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw await responseError(response, `Failed to remove ${connectorDisplayCredential(connector)}.`);
  }
  return (await response.json()) as { removed: boolean };
}

// Returns e.g. "Phoenix Perpetuals access code" or "Magic Eden API key" — the human-readable
// connector + credential noun used in save/remove error toasts.
function connectorDisplayCredential(connector: ByoKeyConnectorId): string {
  const meta = BYO_KEY_CONNECTOR_META[connector];
  const noun = (meta.formFieldLabel ?? 'API key').toLowerCase();
  return `${meta.label} ${noun}`;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let detail = '';
  try {
    const data = (await response.json()) as { error?: string };
    if (data && typeof data.error === 'string') detail = data.error;
  } catch {
    // ignore
  }
  return new Error(detail || `${fallback} (HTTP ${response.status})`);
}

export interface ConnectorKeysPanelOptions {
  /** Mount target. Pass an element or its id. */
  container: HTMLElement | string;
  /** Called after a successful save/delete so the host can refresh related views. */
  onChange?: () => void;
}

export interface ConnectorKeysPanelHandle {
  refresh(): Promise<void>;
  destroy(): void;
}

interface PanelState {
  loading: boolean;
  loaded: boolean;
  error?: string;
  available: boolean;
  secrets: ConnectorSecretsSummary;
  editing?: ByoKeyConnectorId;
  busy?: ByoKeyConnectorId;
}

const INITIAL_SECRETS: ConnectorSecretsSummary = EMPTY_SECRETS_SUMMARY;

// Module-level state — survives across mount/unmount cycles caused by the
// outer app re-rendering. The connector-secrets feature is read-only until
// the user opens the panel, so caching the latest fetched summary is safe.
let panelState: PanelState = {
  loading: false,
  loaded: false,
  available: true,
  secrets: { ...INITIAL_SECRETS },
};
let inflightFetch: Promise<void> | undefined;
let activeMounts = new Set<HTMLElement>();
let listenersBound = false;
let lastChangeHandler: (() => void) | undefined;

export function mountConnectorKeysPanel(
  options: ConnectorKeysPanelOptions,
): ConnectorKeysPanelHandle | undefined {
  const container =
    typeof options.container === 'string'
      ? document.getElementById(options.container)
      : options.container;
  if (!container) {
    // Silent: the host may call this on every app re-render and the panel
    // is only visible when the user opens the Connectors preferences view.
    return undefined;
  }
  // The same container element may have been recreated by an outer
  // re-render; drop stale references first.
  for (const previous of [...activeMounts]) {
    if (!previous.isConnected) activeMounts.delete(previous);
  }
  activeMounts.add(container);
  lastChangeHandler = options.onChange;
  bindGlobalListeners();
  renderAll();
  if (!panelState.loaded && !inflightFetch) {
    void refresh();
  }
  return {
    refresh,
    destroy() {
      activeMounts.delete(container);
      container.innerHTML = '';
    },
  };
}

function bindGlobalListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('submit', onDocumentSubmit);
}

function onDocumentClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.closest<HTMLElement>('[data-connector-key-action]');
  if (!action) return;
  if (!isInsideMountedPanel(action)) return;
  event.preventDefault();
  const connectorAttr = action.getAttribute('data-connector');
  if (!connectorAttr || !isByoKeyConnectorId(connectorAttr)) return;
  const what = action.getAttribute('data-connector-key-action');
  if (what === 'edit') {
    panelState.editing = connectorAttr;
    renderAll();
  } else if (what === 'cancel') {
    panelState.editing = undefined;
    renderAll();
  } else if (what === 'remove') {
    void runRemove(connectorAttr);
  }
}

function onDocumentSubmit(event: Event): void {
  if (!(event.target instanceof HTMLFormElement)) return;
  if (!event.target.matches('[data-connector-key-form]')) return;
  if (!isInsideMountedPanel(event.target)) return;
  event.preventDefault();
  const form = event.target;
  const connectorAttr = form.getAttribute('data-connector');
  if (!connectorAttr || !isByoKeyConnectorId(connectorAttr)) return;
  const data = new FormData(form);
  const apiKey = String(data.get('apiKey') ?? '').trim();
  const baseUrlRaw = String(data.get('baseUrl') ?? '').trim();
  if (!apiKey) {
    const fieldLabel = BYO_KEY_CONNECTOR_META[connectorAttr].formFieldLabel ?? 'API key';
    panelState.error = `${fieldLabel} is required.`;
    renderAll();
    return;
  }
  const normalizedBaseUrl = normalizeConnectorBaseUrlInput(baseUrlRaw);
  if (normalizedBaseUrl.error) {
    panelState.error = normalizedBaseUrl.error;
    renderAll();
    return;
  }
  void runSave(connectorAttr, { apiKey, baseUrl: normalizedBaseUrl.value });
}

function isInsideMountedPanel(element: HTMLElement): boolean {
  for (const container of activeMounts) {
    if (container.isConnected && container.contains(element)) return true;
  }
  return false;
}

async function runSave(connector: ByoKeyConnectorId, input: SaveConnectorSecretInput): Promise<void> {
  panelState.busy = connector;
  panelState.error = undefined;
  renderAll();
  try {
    const summary = await saveConnectorSecret(connector, input);
    panelState.secrets[connector] = {
      hasKey: summary.hasKey,
      ...(summary.baseUrl ? { baseUrl: summary.baseUrl } : {}),
      ...(summary.savedAt ? { savedAt: summary.savedAt } : {}),
    };
    panelState.editing = undefined;
    lastChangeHandler?.();
  } catch (err) {
    panelState.error = err instanceof Error ? err.message : 'Save failed.';
  } finally {
    panelState.busy = undefined;
    renderAll();
  }
}

async function runRemove(connector: ByoKeyConnectorId): Promise<void> {
  panelState.busy = connector;
  panelState.error = undefined;
  renderAll();
  try {
    await deleteConnectorSecret(connector);
    panelState.secrets[connector] = { hasKey: false };
    lastChangeHandler?.();
  } catch (err) {
    panelState.error = err instanceof Error ? err.message : 'Remove failed.';
  } finally {
    panelState.busy = undefined;
    renderAll();
  }
}

async function refresh(): Promise<void> {
  if (inflightFetch) return inflightFetch;
  panelState.loading = true;
  panelState.error = undefined;
  renderAll();
  inflightFetch = (async () => {
    try {
      const { secrets, available } = await listConnectorSecrets();
      panelState.secrets = { ...INITIAL_SECRETS, ...secrets };
      panelState.available = available;
      panelState.loaded = true;
    } catch (err) {
      panelState.error = err instanceof Error ? err.message : 'Failed to load.';
    } finally {
      panelState.loading = false;
      inflightFetch = undefined;
      renderAll();
    }
  })();
  return inflightFetch;
}

function renderAll(): void {
  const html = renderPanel(panelState);
  for (const container of activeMounts) {
    if (container.isConnected) {
      container.innerHTML = html;
    }
  }
}

function renderPanel(state: PanelState): string {
  const intro = state.available
    ? 'Magic Eden, Tensor, Sanctum, Lulo, and Phoenix Perpetuals require your own keys (Phoenix uses a one-time invite/activation code). Credentials are encrypted per wallet and only injected when the cloud prepares a transaction for you.'
    : 'Connector key storage is not configured on this server. Set CONNECTOR_SECRET_KEY (or SESSION_SECRET) on the host to enable per-user keys.';
  const cards = BYO_KEY_CONNECTOR_IDS.map((id) => renderCard(id, state)).join('');
  const error = state.error
    ? `<p class="connector-keys-error" role="alert">${escapeHtml(state.error)}</p>`
    : '';
  const status = state.loading ? '<p class="connector-keys-status">Loading…</p>' : '';
  return `
    <section class="connector-keys-panel" aria-labelledby="connector-keys-title">
      <header>
        <h3 id="connector-keys-title">Connector API keys</h3>
        <p>${escapeHtml(intro)}</p>
      </header>
      ${status}
      ${error}
      <div class="connector-keys-grid">${cards}</div>
    </section>
  `;
}

function renderCard(id: ByoKeyConnectorId, state: PanelState): string {
  const meta = BYO_KEY_CONNECTOR_META[id];
  const summary = state.secrets[id];
  const busy = state.busy === id;
  const editing = state.editing === id;
  const status = summary.hasKey
    ? `Connected${summary.savedAt ? ` · saved ${formatDate(summary.savedAt)}` : ''}`
    : 'Not connected';
  const statusTone = summary.hasKey ? 'on' : 'off';
  const mobile = isMobileConnectorKeysSurface();
  const head = `
    <header>
      <div>
        <h4>${escapeHtml(meta.label)}</h4>
        <p>${escapeHtml(meta.description)}</p>
      </div>
      <span class="connector-key-status" data-status="${statusTone}">${escapeHtml(status)}</span>
    </header>
  `;
  const body = `
    ${editing ? renderForm(id, summary) : renderActions(id, summary, busy)}
    <footer>
      <a href="${escapeAttr(meta.portalUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(meta.portalLinkLabel ?? 'Get an API key →')}</a>
    </footer>
  `;
  if (mobile) {
    return `
      <details class="connector-key-card mobile-connector-key-card" data-connector="${escapeAttr(id)}" ${editing ? 'open' : ''}>
        <summary>
          ${head}
        </summary>
        <div class="connector-key-card-body">
          ${body}
        </div>
      </details>
    `;
  }
  return `
    <article class="connector-key-card" data-connector="${escapeAttr(id)}">
      ${head}
      ${body}
    </article>
  `;
}

function isMobileConnectorKeysSurface(): boolean {
  if (typeof document !== 'undefined' && document.querySelector('.shell.android-shell, .shell.ios-native-shell')) return true;
  return typeof window !== 'undefined' && window.innerWidth < 900;
}

function renderActions(id: ByoKeyConnectorId, summary: ConnectorSecretSummary, busy: boolean): string {
  const meta = BYO_KEY_CONNECTOR_META[id];
  const disabled = busy ? 'disabled' : '';
  const addLabel = meta.addButtonLabel ?? 'Add API key';
  if (summary.hasKey) {
    const updateLabel = addLabel.replace(/^Add\b/i, 'Update');
    return `
      <div class="connector-key-actions">
        <button type="button" class="utility" data-connector="${escapeAttr(id)}" data-connector-key-action="edit" ${disabled}>${escapeHtml(updateLabel)}</button>
        <button type="button" class="utility utility-danger" data-connector="${escapeAttr(id)}" data-connector-key-action="remove" ${disabled}>Remove</button>
      </div>
    `;
  }
  return `
    <div class="connector-key-actions">
      <button type="button" class="primary" data-connector="${escapeAttr(id)}" data-connector-key-action="edit" ${disabled}>${escapeHtml(addLabel)}</button>
    </div>
  `;
}

function renderForm(id: ByoKeyConnectorId, summary: ConnectorSecretSummary): string {
  const meta = BYO_KEY_CONNECTOR_META[id];
  const fieldLabel = meta.formFieldLabel ?? 'API key';
  const placeholder = meta.formPlaceholderTemplate
    ? meta.formPlaceholderTemplate(meta.label)
    : `Paste your ${meta.label} key`;
  return `
    <form class="connector-key-form" data-connector="${escapeAttr(id)}" data-connector-key-form>
      <label>
        <span>${escapeHtml(fieldLabel)}</span>
        <input type="password" name="apiKey" autocomplete="off" required minlength="1" maxlength="1024" placeholder="${escapeAttr(placeholder)}" />
      </label>
      <label>
        <span>Base URL <em>(optional)</em></span>
        <input type="url" name="baseUrl" autocomplete="off" placeholder="${escapeAttr(meta.defaultBaseUrl)}" value="${escapeAttr(summary.baseUrl ?? '')}" />
      </label>
      <div class="connector-key-actions">
        <button type="submit" class="primary">Save</button>
        <button type="button" class="utility" data-connector="${escapeAttr(id)}" data-connector-key-action="cancel">Cancel</button>
      </div>
    </form>
  `;
}

function isByoKeyConnectorId(value: string): value is ByoKeyConnectorId {
  return (BYO_KEY_CONNECTOR_IDS as readonly string[]).includes(value);
}

function normalizeConnectorBaseUrlInput(value: string): { value?: string; error?: string } {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return {};
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Base URL must be a valid URL.' };
  }
  if (parsed.protocol === 'https:') return { value: trimmed };
  if (parsed.protocol === 'http:' && isLocalHttpHost(parsed.hostname)) return { value: trimmed };
  return { error: 'Base URL must use HTTPS, except localhost HTTP for a local connector.' };
}

function isLocalHttpHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]';
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
