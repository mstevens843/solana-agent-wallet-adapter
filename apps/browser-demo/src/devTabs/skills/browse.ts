import './browse.css';
import type { aggregator, skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { getJson, postJson } from './fetchHelpers.js';
import { emitSkillsInstallsChanged, onSkillsInstallsChanged } from './events.js';
import { registerSkillsSubTab, setActiveSkillsSubTab } from './subTabRegistry.js';

type SkillManifest = skills.SkillManifest;
type SkillCategory = skills.SkillCategory;
type SkillInstallRecord = skills.SkillInstallRecord;
type SkillInstallStatus = skills.SkillInstallStatus;
type SkillMonetization = skills.SkillMonetization;
type SkillStatsSnapshot = aggregator.SkillStatsSnapshot;
type InstallSkillRequest = skills.InstallSkillRequest;

export interface CardRow {
  manifest: SkillManifest;
  stats: SkillStatsSnapshot | null;
  installStatus: SkillInstallStatus | 'none';
}

export type BrowsePhase = 'idle' | 'loading' | 'ready' | 'error';

export interface BrowseNotice {
  title: string;
  body: string;
}

export interface BrowseState {
  phase: BrowsePhase;
  rows: CardRow[];
  error: string;
  notice: BrowseNotice | null;
  busyInstallId: string | null;
  installParamDrafts: Record<string, Record<string, string>>;
  installParamErrors: Record<string, string>;
  installErrors: Record<string, string>;
  monetizationAccepted: Record<string, boolean>;
  treasuryActive: boolean;
  platformFeeBps: number;
}

const state: BrowseState = {
  phase: 'idle',
  rows: [],
  error: '',
  notice: null,
  busyInstallId: null,
  installParamDrafts: {},
  installParamErrors: {},
  installErrors: {},
  monetizationAccepted: {},
  treasuryActive: false,
  platformFeeBps: 0,
};

let catalogLoadSeq = 0;

export function __resetStateForTests(next: Partial<BrowseState> = {}): void {
  state.phase = next.phase ?? 'idle';
  state.rows = next.rows ?? [];
  state.error = next.error ?? '';
  state.notice = next.notice ?? null;
  state.busyInstallId = next.busyInstallId ?? null;
  state.installParamDrafts = next.installParamDrafts ?? {};
  state.installParamErrors = next.installParamErrors ?? {};
  state.installErrors = next.installErrors ?? {};
  state.monetizationAccepted = next.monetizationAccepted ?? {};
  state.treasuryActive = next.treasuryActive ?? false;
  state.platformFeeBps = next.platformFeeBps ?? 0;
  catalogLoadSeq = 0;
}

export function __getStateForTests(): Readonly<BrowseState> {
  return state;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatSuccessRate(rate: number | undefined | null): string {
  if (rate === undefined || rate === null || Number.isNaN(rate)) return '—';
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  return `${Math.round(pct)}%`;
}

export function formatInstalls(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const rounded = Math.max(0, Math.round(n));
  return `${rounded} install${rounded === 1 ? '' : 's'}`;
}

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  dca: 'DCA',
  yield: 'Yield',
  stops: 'Stops',
  bridge: 'Bridge',
  donation: 'Donation',
  custom: 'Custom',
};

export function categoryLabel(category: SkillCategory | string): string {
  if (category in CATEGORY_LABELS) {
    return CATEGORY_LABELS[category as SkillCategory];
  }
  return String(category);
}

export interface MonetizationDisplayContext {
  treasuryActive: boolean;
  platformFeeBps: number;
}

export function formatMonetization(
  m: SkillMonetization | undefined,
  context: MonetizationDisplayContext = { treasuryActive: false, platformFeeBps: 0 },
): string {
  if (!m) return '';
  if (m.kind === 'performance-fee' && typeof m.feePercent === 'number') {
    return context.treasuryActive
      ? `${m.feePercent}% of profit · paid to author · platform fee deferred`
      : `${m.feePercent}% of profit · paid to author`;
  }
  if ((m.kind === 'one-time' || m.kind === 'monthly') && m.amount) {
    const cadence = m.kind === 'one-time' ? ` once` : `/mo`;
    // Show the token alongside the amount so $SKR-priced skills don't read as
    // implicit-USDC. Default to USDC for manifests that predate the token
    // field.
    const token = m.token ?? 'USDC';
    const base = `$${m.amount} ${token}${cadence}`;
    if (!context.treasuryActive || context.platformFeeBps <= 0) {
      return `${base} · paid to author`;
    }
    const split = splitDecimalForDisplay(m.amount, context.platformFeeBps);
    if (!split) return `${base} · paid to author`;
    return `${base} · Author $${split.author} · Agentic $${split.platform}`;
  }
  return 'Paid to author';
}

interface DisplaySplit {
  author: string;
  platform: string;
}

function splitDecimalForDisplay(amount: string, feeBps: number): DisplaySplit | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  if (feeBps <= 0 || feeBps >= 10_000) return null;
  // Display-only split, used to render Author/Agentic shares on the browse
  // card. Uses 6 decimals (USDC, default $SKR) as the canonical scale — the
  // server is authoritative on the actual split using the manifest token's
  // real decimals. A drift at the 7th decimal place is invisible in UI.
  const decimals = 6;
  const [intPart, fracPart = ''] = amount.split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const raw = BigInt((intPart ?? '0') + padded);
  if (raw === 0n) return null;
  const platformRaw = (raw * BigInt(feeBps)) / 10_000n;
  if (platformRaw === 0n) return null;
  const authorRaw = raw - platformRaw;
  return {
    author: rawToDisplay(authorRaw, decimals),
    platform: rawToDisplay(platformRaw, decimals),
  };
}

function rawToDisplay(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const intPart = raw.slice(0, -decimals);
  const fracPart = raw.slice(-decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

const INSTALL_PARAM_RE = /\{\{install\.([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const INSTALL_RECIPIENT_KEYS = new Set([
  'recipient',
  'to',
  'recipientAddress',
  'destinationAddress',
  'destinationRecipient',
]);

export function requiredInstallParamKeys(manifest: SkillManifest): string[] {
  const keys = new Set<string>();
  collectInstallParamKeys(manifest.action.paramsTemplate, keys);
  return [...keys].sort();
}

function collectInstallParamKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(INSTALL_PARAM_RE)) {
      const key = match[1];
      if (key) keys.add(key);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectInstallParamKeys(entry, keys));
    return;
  }
  if (isObject(value)) {
    Object.values(value).forEach((entry) => collectInstallParamKeys(entry, keys));
  }
}

function installParamLabel(key: string): string {
  switch (key) {
    case 'recipient': return 'Recipient';
    case 'recipientAddress': return 'Recipient address';
    case 'destinationAddress': return 'Destination address';
    case 'destinationRecipient': return 'Destination recipient';
    case 'to': return 'To';
    default: return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeManifest(v: unknown): v is SkillManifest {
  return isObject(v) && typeof v.id === 'string' && typeof v.version === 'string';
}

function looksLikeInstall(v: unknown): v is SkillInstallRecord {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.skillId === 'string' &&
    typeof v.status === 'string'
  );
}

function looksLikeStats(v: unknown): v is SkillStatsSnapshot {
  return (
    isObject(v) &&
    typeof v.skillId === 'string' &&
    typeof v.installs === 'number' &&
    typeof v.totalExecutions === 'number'
  );
}

export function normalizeCatalog(input: unknown): SkillManifest[] {
  if (Array.isArray(input)) return input.filter(looksLikeManifest);
  if (isObject(input) && Array.isArray(input.skills)) {
    return input.skills.filter(looksLikeManifest);
  }
  if (isObject(input) && Array.isArray(input.items)) {
    return input.items.filter(looksLikeManifest);
  }
  return [];
}

export function normalizeInstalls(input: unknown): SkillInstallRecord[] {
  if (Array.isArray(input)) return input.filter(looksLikeInstall);
  if (isObject(input) && Array.isArray(input.installs)) {
    return input.installs.filter(looksLikeInstall);
  }
  if (isObject(input) && Array.isArray(input.items)) {
    return input.items.filter(looksLikeInstall);
  }
  return [];
}

export function normalizeStats(input: unknown): SkillStatsSnapshot | null {
  if (looksLikeStats(input)) return input;
  if (isObject(input)) {
    if (looksLikeStats(input.snapshot)) return input.snapshot;
    if (looksLikeStats(input.stats)) return input.stats;
  }
  return null;
}

function forbiddenNotice(): BrowseNotice {
  return {
    title: 'Permission required',
    body: 'This wallet cannot install skills on this deployment.',
  };
}

function signInNotice(message = 'Sign in to Agentic Cloud with your wallet to install and manage skills.'): BrowseNotice {
  return {
    title: 'Sign in required',
    body: message,
  };
}

function notDeployedNotice(): BrowseNotice {
  return {
    title: 'Skills API unavailable',
    body: '/api/skills returned 404. Check that this UI is pointed at a render-web server with Skills routes enabled.',
  };
}

function renderError(message: string): string {
  return `
    <div class="skills-browse-error" role="alert">
      <div><strong>Something went wrong</strong>${escapeHtml(message)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-skills-browse-action="dismiss-error">×</button>
    </div>
  `;
}

function renderNotice(notice: BrowseNotice): string {
  return `
    <div class="skills-browse-notice" role="status">
      <div><strong>${escapeHtml(notice.title)}</strong>${escapeHtml(notice.body)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-skills-browse-action="dismiss-notice">×</button>
    </div>
  `;
}

function renderInstallControl(row: CardRow, busy: boolean): string {
  if (row.installStatus === 'active') {
    return `<span class="skills-browse-installed" aria-label="Installed">Installed</span>`;
  }
  if (row.installStatus === 'paused') {
    return `<span class="skills-browse-installed paused" aria-label="Paused">Paused</span>`;
  }
  if (row.installStatus === 'expired' || row.installStatus === 'revoked') {
    // Treat as not-installed; user can re-install.
  }
  const label = busy ? 'Installing…' : 'Install';
  const disabled = busy || requiresMonetizationAcceptance(row) ? 'disabled' : '';
  return `
    <button
      type="button"
      class="skills-browse-button"
      data-skills-browse-action="install"
      data-skill-id="${escapeHtml(row.manifest.id)}"
      ${disabled}
    >${label}</button>
  `;
}

function requiresMonetizationAcceptance(row: CardRow): boolean {
  if (!row.manifest.monetization) return false;
  if (row.installStatus === 'active' || row.installStatus === 'paused') return false;
  return state.monetizationAccepted[row.manifest.id] !== true;
}

function renderMonetizationAcceptance(row: CardRow, busy: boolean): string {
  if (!row.manifest.monetization) return '';
  if (row.installStatus === 'active' || row.installStatus === 'paused') return '';
  const checked = state.monetizationAccepted[row.manifest.id] ? 'checked' : '';
  const terms = formatMonetization(row.manifest.monetization, {
    treasuryActive: state.treasuryActive,
    platformFeeBps: state.platformFeeBps,
  }) || 'Paid author terms';
  return `
    <label class="skills-browse-paid-terms">
      <input
        type="checkbox"
        data-skill-id="${escapeHtml(row.manifest.id)}"
        data-skills-browse-monetization="accept"
        ${checked}
        ${busy ? 'disabled' : ''}
      />
      <span>Accept ${escapeHtml(terms)} for this install.</span>
    </label>
  `;
}

function renderInstallParams(row: CardRow, busy: boolean): string {
  if (row.installStatus === 'active' || row.installStatus === 'paused') return '';
  const keys = requiredInstallParamKeys(row.manifest);
  if (keys.length === 0) return '';
  const draft = state.installParamDrafts[row.manifest.id] ?? {};
  const error = state.installParamErrors[row.manifest.id];
  return `
    <div class="skills-browse-install-params" data-skills-install-params="${escapeHtml(row.manifest.id)}">
      ${keys.map((key) => `
        <label class="skills-browse-param-field">
          <span>${escapeHtml(installParamLabel(key))}</span>
          <input
            type="text"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(draft[key] ?? '')}"
            data-skill-id="${escapeHtml(row.manifest.id)}"
            data-install-param-key="${escapeHtml(key)}"
            ${busy ? 'disabled' : ''}
          />
        </label>
      `).join('')}
      ${error ? `<p class="skills-browse-param-error" role="alert">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderInstallError(row: CardRow): string {
  const error = state.installErrors[row.manifest.id];
  return error ? `<p class="skills-browse-param-error" role="alert">${escapeHtml(error)}</p>` : '';
}

export function renderCard(row: CardRow, busyInstallId: string | null): string {
  const busy = busyInstallId === row.manifest.id;
  const monetizationLine = formatMonetization(row.manifest.monetization, {
    treasuryActive: state.treasuryActive,
    platformFeeBps: state.platformFeeBps,
  });
  return `
    <article class="skills-browse-card" data-skill-id="${escapeHtml(row.manifest.id)}">
      <div class="skills-browse-card-head">
        <h3>${escapeHtml(row.manifest.name)}</h3>
        <span class="skills-browse-category">${escapeHtml(categoryLabel(row.manifest.category))}</span>
      </div>
      <p class="skills-browse-card-description">${escapeHtml(row.manifest.description)}</p>
      <dl class="skills-browse-stats">
        <dt>Installs</dt>
        <dd>${escapeHtml(formatInstalls(row.stats?.installs))}</dd>
        <dt>Success</dt>
        <dd>${escapeHtml(formatSuccessRate(row.stats?.successRate))}</dd>
      </dl>
      ${monetizationLine ? `<p class="skills-browse-monetization">${escapeHtml(monetizationLine)}</p>` : ''}
      ${renderMonetizationAcceptance(row, busy)}
      ${renderInstallParams(row, busy)}
      ${renderInstallError(row)}
      <div class="skills-browse-card-footer">
        ${renderInstallControl(row, busy)}
      </div>
    </article>
  `;
}

function renderBody(): string {
  if (state.phase === 'idle' || state.phase === 'loading') {
    return `<p class="skills-browse-loading" data-skills-browse-loading>Loading skills…</p>`;
  }
  if (state.rows.length === 0) {
    return `<p class="skills-browse-empty">No skills published yet. Run <code>agentic-skill publish</code> to add yours.</p>`;
  }
  return `
    <div class="skills-browse-grid">
      ${state.rows.map((row) => renderCard(row, state.busyInstallId)).join('')}
    </div>
  `;
}

export function renderBrowsePanel(): string {
  const errorBlock = state.error ? renderError(state.error) : '';
  const noticeBlock = state.notice ? renderNotice(state.notice) : '';
  return `
    <section class="skills-browse-root" data-skills-browse-root>
      <header class="skills-browse-header">
        <div>
          <h2>Browse skills</h2>
          <p>Installable strategy recipes. Each run still proposes an approval — skills never move funds on their own.</p>
        </div>
        <div class="skills-browse-header-actions">
          <button type="button" class="skills-browse-button refresh" data-skills-browse-action="refresh">Refresh</button>
        </div>
      </header>
      ${noticeBlock}
      ${errorBlock}
      ${renderBody()}
    </section>
  `;
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-skills-browse-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderBrowsePanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  root.replaceWith(next);
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function openInstalledTab(): void {
  if (typeof document === 'undefined') return;
  setActiveSkillsSubTab('installed');
  const installedPill = document.querySelector<HTMLButtonElement>('[data-skills-subtab="installed"]');
  installedPill?.click();
}

function showToast(message: string, action?: { label: string; onClick: () => void }): void {
  if (typeof document === 'undefined') return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'skills-browse-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.replaceChildren(document.createTextNode(message));
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick, { once: true });
    toastEl.appendChild(button);
  }
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove('visible');
  }, 3_000);
}

export async function loadCatalog(): Promise<void> {
  const requestId = ++catalogLoadSeq;
  const isCurrentRequest = () => requestId === catalogLoadSeq;

  state.phase = 'loading';
  state.error = '';
  state.notice = null;
  rerenderPanelOnly();

  const [catalogRes, installsRes] = await Promise.all([
    getJson<unknown>('/api/skills'),
    getJson<unknown>('/api/skills/installs'),
  ]);

  if (!isCurrentRequest()) return;

  if (catalogRes.kind === 'unauthenticated') {
    state.notice = signInNotice(catalogRes.message);
    state.rows = [];
    state.phase = 'ready';
    rerenderPanelOnly();
    return;
  }
  if (catalogRes.kind === 'forbidden') {
    state.notice = forbiddenNotice();
    state.rows = [];
    state.phase = 'ready';
    rerenderPanelOnly();
    return;
  }
  if (catalogRes.kind === 'notDeployed') {
    state.notice = notDeployedNotice();
    state.rows = [];
    state.phase = 'ready';
    rerenderPanelOnly();
    return;
  }
  if (catalogRes.kind === 'error' || catalogRes.kind === 'networkError') {
    state.phase = 'error';
    state.error = catalogRes.message;
    rerenderPanelOnly();
    return;
  }

  const manifests = normalizeCatalog(catalogRes.value);
  const installs = installsRes.kind === 'ok' ? normalizeInstalls(installsRes.value) : [];
  if (installsRes.kind === 'unauthenticated') {
    state.notice = signInNotice(installsRes.message);
  }
  const installMap = new Map<string, SkillInstallStatus>();
  for (const i of installs) {
    installMap.set(i.skillId, i.status);
  }

  if (isObject(catalogRes.value)) {
    state.treasuryActive = Boolean((catalogRes.value as { treasuryActive?: unknown }).treasuryActive);
    const feeBps = (catalogRes.value as { platformFeeBps?: unknown }).platformFeeBps;
    state.platformFeeBps = typeof feeBps === 'number' && Number.isFinite(feeBps) ? feeBps : 0;
  } else {
    state.treasuryActive = false;
    state.platformFeeBps = 0;
  }

  state.rows = manifests.map((m) => ({
    manifest: m,
    stats: null,
    installStatus: installMap.get(m.id) ?? 'none',
  }));
  state.phase = 'ready';
  rerenderPanelOnly();

  // Stats fetched in parallel after the cards render — non-blocking.
  const rowsForStats = state.rows;
  await Promise.all(
    rowsForStats.map(async (row) => {
      const r = await getJson<unknown>(
        `/api/aggregator/skills/${encodeURIComponent(row.manifest.id)}`,
      );
      if (isCurrentRequest() && r.kind === 'ok') {
        row.stats = normalizeStats(r.value);
      }
    }),
  );
  if (!isCurrentRequest()) return;
  rerenderPanelOnly();
}

function installParamsForRow(row: CardRow): Record<string, string> | undefined {
  const keys = requiredInstallParamKeys(row.manifest);
  if (keys.length === 0) return undefined;
  const draft = state.installParamDrafts[row.manifest.id] ?? {};
  const params: Record<string, string> = {};
  for (const key of keys) {
    const value = (draft[key] ?? '').trim();
    if (!value) {
      state.installParamErrors[row.manifest.id] = `${installParamLabel(key)} is required.`;
      return undefined;
    }
    params[key] = value;
  }
  delete state.installParamErrors[row.manifest.id];
  return params;
}

function capsWithInstallParams(caps: SkillManifest['caps'], installParams: Record<string, string> | undefined): SkillManifest['caps'] {
  if (!installParams) return caps;
  const recipients = new Set(caps.allowlistedRecipients ?? []);
  for (const [key, value] of Object.entries(installParams)) {
    if (INSTALL_RECIPIENT_KEYS.has(key) && value.trim()) {
      recipients.add(value.trim());
    }
  }
  if (recipients.size === 0) return caps;
  return {
    ...caps,
    allowlistedRecipients: [...recipients],
  };
}

export async function handleInstall(skillId: string): Promise<void> {
  if (state.busyInstallId) return;
  const row = state.rows.find((r) => r.manifest.id === skillId);
  if (!row) return;

  state.error = '';
  delete state.installErrors[skillId];
  if (row.manifest.monetization && state.monetizationAccepted[skillId] !== true) {
    state.installErrors[skillId] = 'Accept the author payment terms to install this skill.';
    rerenderPanelOnly();
    return;
  }
  const installParams = installParamsForRow(row);
  if (requiredInstallParamKeys(row.manifest).length > 0 && !installParams) {
    rerenderPanelOnly();
    return;
  }

  state.busyInstallId = skillId;
  rerenderPanelOnly();

  const body: InstallSkillRequest = {
    skillId: row.manifest.id,
    manifestVersion: row.manifest.version,
    caps: capsWithInstallParams(row.manifest.caps, installParams),
    acceptMonetization: true,
    ...(installParams ? { installParams } : {}),
  };
  const result = await postJson<{
    installId?: string;
    monetizationScheduleId?: string;
    install?: { id?: string; skillId?: string; status?: string };
  }>(
    '/api/skills/installs',
    body,
  );
  state.busyInstallId = null;

  if (result.kind === 'ok') {
    row.installStatus = 'active';
    rerenderPanelOnly();
    emitSkillsInstallsChanged({
      source: 'browse',
      skillId: row.manifest.id,
      installId: result.value.install?.id ?? result.value.installId,
      status: result.value.install?.status ?? 'active',
    });
    showToast(`Installed · ${row.manifest.name}`, {
      label: 'View Installed',
      onClick: openInstalledTab,
    });
    return;
  }
  if (result.kind === 'unauthenticated') {
    state.notice = signInNotice(result.message);
  } else if (result.kind === 'forbidden') {
    state.notice = forbiddenNotice();
  } else if (result.kind === 'notDeployed') {
    state.notice = notDeployedNotice();
  } else {
    state.error = result.message;
  }
  rerenderPanelOnly();
}

export function invalidateCatalogAfterInstallChange(): void {
  catalogLoadSeq += 1;
  state.phase = 'idle';
  state.error = '';
  state.notice = null;
  state.busyInstallId = null;
  if (typeof document !== 'undefined' && document.querySelector('[data-skills-browse-root]')) {
    void loadCatalog();
  }
}

function handleAction(action: string, target: HTMLElement): void {
  if (action === 'refresh') {
    void loadCatalog();
    return;
  }
  if (action === 'install') {
    const id = target.dataset.skillId;
    if (id) void handleInstall(id);
    return;
  }
  if (action === 'dismiss-error') {
    state.error = '';
    rerenderPanelOnly();
    return;
  }
  if (action === 'dismiss-notice') {
    state.notice = null;
    rerenderPanelOnly();
    return;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const trigger = target.closest<HTMLElement>('[data-skills-browse-action]');
    if (!trigger) return;
    const action = trigger.dataset.skillsBrowseAction;
    if (!action) return;
    event.preventDefault();
    handleAction(action, trigger);
  });
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | null;
    if (target?.dataset.skillsBrowseMonetization === 'accept' && target.dataset.skillId) {
      state.monetizationAccepted[target.dataset.skillId] = target.checked;
      delete state.installErrors[target.dataset.skillId];
      rerenderPanelOnly();
      return;
    }
    if (!target?.dataset.installParamKey || !target.dataset.skillId) return;
    const skillId = target.dataset.skillId;
    const key = target.dataset.installParamKey;
    state.installParamDrafts[skillId] = {
      ...(state.installParamDrafts[skillId] ?? {}),
      [key]: target.value,
    };
    delete state.installParamErrors[skillId];
  });
  onSkillsInstallsChanged((detail) => {
    if (detail.source === 'browse') return;
    invalidateCatalogAfterInstallChange();
  });
}

registerSkillsSubTab({
  id: 'browse',
  label: 'Browse',
  description: 'Installable strategy recipes',
  render: () => {
    if (state.phase === 'idle') {
      state.phase = 'loading';
      void loadCatalog();
    }
    return renderBrowsePanel();
  },
});
