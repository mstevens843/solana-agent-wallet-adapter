import './installed.css';
import { parseIntervalSpec } from '@solana-agent-wallet-adapter/skills-runtime';
import type { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { emitSkillsInstallsChanged, onSkillsInstallsChanged } from './events.js';
import { getJson, postJson } from './fetchHelpers.js';
import { registerSkillsSubTab, setActiveSkillsSubTab } from './subTabRegistry.js';

type SkillInstallRecord = skills.SkillInstallRecord;
type SkillInstallStatus = skills.SkillInstallStatus;
type SkillManifest = skills.SkillManifest;
type SkillSchedule = skills.SkillSchedule;

export interface InstallRow {
  install: SkillInstallRecord;
  manifest?: SkillManifest;
  recentExecutionCount?: number;
  lastExecutionAt?: string;
  nextRunAt?: string;
  recurringScheduleStatus?: string;
}

export type InstalledPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface InstalledNotice {
  title: string;
  body: string;
}

export interface InstalledState {
  phase: InstalledPhase;
  rows: InstallRow[];
  error: string;
  notice: InstalledNotice | null;
  fetchedAt: number;
  silentRefetching: boolean;
  actionInFlight: string | null;
  actionError: string;
  pendingUninstallId: string | null;
  pendingUninstallExpiresAt: number;
}

const TTL_MS = 60_000;
const UNINSTALL_CONFIRM_MS = 5_000;

const state: InstalledState = {
  phase: 'idle',
  rows: [],
  error: '',
  notice: null,
  fetchedAt: 0,
  silentRefetching: false,
  actionInFlight: null,
  actionError: '',
  pendingUninstallId: null,
  pendingUninstallExpiresAt: 0,
};

let pendingUninstallTimer: ReturnType<typeof setTimeout> | null = null;

export function __resetStateForTests(next: Partial<InstalledState> = {}): void {
  state.phase = next.phase ?? 'idle';
  state.rows = next.rows ?? [];
  state.error = next.error ?? '';
  state.notice = next.notice ?? null;
  state.fetchedAt = next.fetchedAt ?? 0;
  state.silentRefetching = next.silentRefetching ?? false;
  state.actionInFlight = next.actionInFlight ?? null;
  state.actionError = next.actionError ?? '';
  state.pendingUninstallId = next.pendingUninstallId ?? null;
  state.pendingUninstallExpiresAt = next.pendingUninstallExpiresAt ?? 0;
  if (pendingUninstallTimer) {
    clearTimeout(pendingUninstallTimer);
    pendingUninstallTimer = null;
  }
}

export function __getStateForTests(): Readonly<InstalledState> {
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

export function shortAddress(addr: string): string {
  if (!addr || addr.length <= 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

const STATUS_LABELS: Record<SkillInstallStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  expired: 'Expired',
  revoked: 'Revoked',
};

export function statusLabel(status: SkillInstallStatus | string): string {
  if (status in STATUS_LABELS) return STATUS_LABELS[status as SkillInstallStatus];
  return String(status);
}

export function statusModifier(status: SkillInstallStatus | string): string {
  switch (status) {
    case 'active':
      return 'is-active';
    case 'paused':
      return 'is-paused';
    case 'expired':
      return 'is-expired';
    case 'revoked':
      return 'is-revoked';
    default:
      return 'is-expired';
  }
}

const CRON_LABELS: Record<string, string> = {
  '* * * * *': 'Every minute',
  '0 * * * *': 'Every hour',
  '0 0 * * *': 'Daily at 00:00 UTC',
  '0 9 * * *': 'Daily at 09:00 UTC',
  '0 0 * * 0': 'Weekly on Sunday',
  '0 0 * * 1': 'Weekly on Monday',
  '0 0 * * 5': 'Weekly on Friday',
  '0 9 * * 1-5': 'Weekdays at 09:00 UTC',
  '0 9 * * 0,6': 'Weekends at 09:00 UTC',
};

export function humanizeSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '—';
  const s = Math.round(totalSeconds);
  if (s === 60) return 'Every minute';
  if (s === 3600) return 'Every hour';
  if (s === 86_400) return 'Every day';
  if (s === 604_800) return 'Every week';
  if (s % 604_800 === 0) return `Every ${s / 604_800}w`;
  if (s % 86_400 === 0) return `Every ${s / 86_400}d`;
  if (s % 3600 === 0) return `Every ${s / 3600}h`;
  if (s % 60 === 0) return `Every ${s / 60}m`;
  return `Every ${s}s`;
}

function intervalSpecToSeconds(spec: string): number | undefined {
  const parsed = parseIntervalSpec(spec);
  if (typeof parsed === 'number') return parsed / 1_000;
  if (!/^\d+$/.test(spec)) return undefined;
  const legacySeconds = Number.parseInt(spec, 10);
  return Number.isFinite(legacySeconds) && legacySeconds > 0 ? legacySeconds : undefined;
}

export function humanizeSchedule(schedule: SkillSchedule | undefined | null): string {
  if (!schedule || typeof schedule !== 'object') return 'Schedule unavailable';
  const spec = String(schedule.spec ?? '').trim();
  if (schedule.kind === 'cron') {
    if (spec in CRON_LABELS) return CRON_LABELS[spec]!;
    return spec ? `cron(${spec})` : 'Cron schedule';
  }
  if (schedule.kind === 'interval') {
    const seconds = intervalSpecToSeconds(spec);
    if (seconds !== undefined) return humanizeSeconds(seconds);
    return spec ? `Interval(${spec})` : 'Interval schedule';
  }
  if (schedule.kind === 'price-trigger') {
    return 'On price trigger';
  }
  return 'Schedule unavailable';
}

export function humanizeRelative(iso: string, nowMs: number): string {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return iso;
  const diff = target - nowMs;
  const future = diff >= 0;
  const abs = Math.abs(diff);
  if (abs < 60_000) return future ? 'in <1m' : 'just now';
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

export function formatRecentCount(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '7d: —';
  const rounded = Math.max(0, Math.round(n));
  return `7d: ${rounded} run${rounded === 1 ? '' : 's'}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeInstall(v: unknown): v is SkillInstallRecord {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.skillId === 'string' &&
    typeof v.status === 'string'
  );
}

function looksLikeManifest(v: unknown): v is SkillManifest {
  return isObject(v) && typeof v.id === 'string' && typeof v.version === 'string';
}

function asInstallRow(v: unknown): InstallRow | null {
  if (!isObject(v)) return null;
  if (looksLikeInstall(v)) {
    const row: InstallRow = { install: v };
    const maybeManifest = (v as Record<string, unknown>).manifest;
    if (looksLikeManifest(maybeManifest)) row.manifest = maybeManifest;
    const recent = (v as Record<string, unknown>).recentExecutionCount;
    if (typeof recent === 'number' && Number.isFinite(recent)) row.recentExecutionCount = recent;
    const last = (v as Record<string, unknown>).lastExecutionAt;
    if (typeof last === 'string') row.lastExecutionAt = last;
    const next = (v as Record<string, unknown>).nextRunAt;
    if (typeof next === 'string') row.nextRunAt = next;
    const recurringStatus = (v as Record<string, unknown>).recurringScheduleStatus;
    if (typeof recurringStatus === 'string') row.recurringScheduleStatus = recurringStatus;
    return row;
  }
  // Tolerate { install, manifest?, recentExecutionCount?, ... } envelope.
  const inner = (v as Record<string, unknown>).install;
  if (looksLikeInstall(inner)) {
    const row: InstallRow = { install: inner };
    const maybeManifest = (v as Record<string, unknown>).manifest;
    if (looksLikeManifest(maybeManifest)) row.manifest = maybeManifest;
    const recent = (v as Record<string, unknown>).recentExecutionCount;
    if (typeof recent === 'number' && Number.isFinite(recent)) row.recentExecutionCount = recent;
    const last = (v as Record<string, unknown>).lastExecutionAt;
    if (typeof last === 'string') row.lastExecutionAt = last;
    const next = (v as Record<string, unknown>).nextRunAt;
    if (typeof next === 'string') row.nextRunAt = next;
    const recurringStatus = (v as Record<string, unknown>).recurringScheduleStatus;
    if (typeof recurringStatus === 'string') row.recurringScheduleStatus = recurringStatus;
    return row;
  }
  return null;
}

export function normalizeInstallsResponse(input: unknown): InstallRow[] {
  let arr: unknown[] = [];
  if (Array.isArray(input)) arr = input;
  else if (isObject(input) && Array.isArray(input.installRows)) arr = input.installRows;
  else if (isObject(input) && Array.isArray(input.installs)) arr = input.installs;
  else if (isObject(input) && Array.isArray(input.items)) arr = input.items;
  return arr
    .map(asInstallRow)
    .filter((row): row is InstallRow => row !== null)
    .filter((row) => row.install.status !== 'revoked');
}

export function normalizeCatalogResponse(input: unknown): SkillManifest[] {
  if (Array.isArray(input)) return input.filter(looksLikeManifest);
  if (isObject(input) && Array.isArray(input.skills)) return input.skills.filter(looksLikeManifest);
  if (isObject(input) && Array.isArray(input.items)) return input.items.filter(looksLikeManifest);
  return [];
}

function joinManifests(rows: InstallRow[], catalog: SkillManifest[]): InstallRow[] {
  if (catalog.length === 0) return rows;
  const byId = new Map<string, SkillManifest>();
  for (const m of catalog) byId.set(m.id, m);
  return rows.map((row) => {
    if (row.manifest) return row;
    const found = byId.get(row.install.skillId);
    return found ? { ...row, manifest: found } : row;
  });
}

function forbiddenNotice(): InstalledNotice {
  return {
    title: 'Permission required',
    body: 'This wallet cannot manage these installed skills.',
  };
}

function signInNotice(message = 'Sign in to Agentic Cloud with your wallet to manage installed skills.'): InstalledNotice {
  return {
    title: 'Sign in required',
    body: message,
  };
}

function notDeployedNotice(): InstalledNotice {
  return {
    title: 'Skills API unavailable',
    body: '/api/skills/installs returned 404. Check that this UI is pointed at a render-web server with Skills routes enabled.',
  };
}

function renderError(message: string): string {
  return `
    <div class="skills-installed-banner is-error" role="alert">
      <div><strong>Something went wrong</strong>${escapeHtml(message)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-skills-installed-action="dismiss-error">×</button>
    </div>
  `;
}

function renderActionError(message: string): string {
  return `
    <div class="skills-installed-banner is-action-error" role="alert">
      <div><strong>Action failed</strong>${escapeHtml(message)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-skills-installed-action="dismiss-action-error">×</button>
    </div>
  `;
}

function renderNotice(notice: InstalledNotice, modifier: 'is-forbidden' | 'is-not-deployed' | 'is-auth'): string {
  return `
    <div class="skills-installed-banner ${modifier}" role="status">
      <div><strong>${escapeHtml(notice.title)}</strong>${escapeHtml(notice.body)}</div>
      <button type="button" class="dismiss" aria-label="Dismiss" data-skills-installed-action="dismiss-notice">×</button>
    </div>
  `;
}

function rowTitle(row: InstallRow): string {
  if (row.manifest?.name) return row.manifest.name;
  return `Skill ${shortAddress(row.install.skillId)}`;
}

function rowScheduleLine(row: InstallRow, nowMs: number): string {
  if (row.nextRunAt) return `Next run ${humanizeRelative(row.nextRunAt, nowMs)}`;
  return humanizeSchedule(row.manifest?.schedule);
}

function rowRunBoundaryLine(row: InstallRow): string {
  switch (row.install.status) {
    case 'active':
      return 'When due, this creates a Needs Approval item.';
    case 'paused':
      return 'Paused; no new approval items will be created.';
    case 'expired':
      return 'Expired; install it again to create future approvals.';
    case 'revoked':
      return 'Uninstalled from this wallet.';
    default:
      return 'Every run still requires wallet approval.';
  }
}

interface MonetizationSplitSnapshot {
  platformWallet: string;
  platformAmount: string;
  totalAmount: string;
  platformFeeBps: number;
}

function readMonetizationSplit(metadata: unknown): MonetizationSplitSnapshot | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const snapshot = (metadata as Record<string, unknown>).monetizationSplit;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  const s = snapshot as Record<string, unknown>;
  const platformWallet = s.platformWallet;
  const platformAmount = s.platformAmount;
  const totalAmount = s.totalAmount;
  const platformFeeBps = s.platformFeeBps;
  if (typeof platformWallet !== 'string' || !platformWallet) return undefined;
  if (typeof platformAmount !== 'string' || !platformAmount) return undefined;
  if (typeof totalAmount !== 'string' || !totalAmount) return undefined;
  if (typeof platformFeeBps !== 'number' || !Number.isFinite(platformFeeBps)) return undefined;
  return { platformWallet, platformAmount, totalAmount, platformFeeBps };
}

function rowMonetizationLine(row: InstallRow): string {
  const split = readMonetizationSplit(row.install.metadata);
  const monetization = row.manifest?.monetization;
  // Token symbol comes from the manifest's monetization.token (default USDC
  // when omitted, set to 'SKR' on Seeker-priced skills). The split snapshot
  // uses the same token by construction — the install handler records
  // `monetizationToken` on the recurring schedule metadata.
  const token = monetization?.token ?? 'USDC';
  if (split && monetization) {
    const cadence = monetization.kind === 'monthly' ? '/mo' : monetization.kind === 'one-time' ? ' once' : '';
    return `Pays $${split.totalAmount} ${token}${cadence} · author $${authorAmountFromSplit(split, monetization)} · Agentic $${split.platformAmount}`;
  }
  if (monetization?.kind === 'monthly' && monetization.amount) {
    return `Pays $${monetization.amount} ${token}/mo · paid to author`;
  }
  if (monetization?.kind === 'one-time' && monetization.amount) {
    return `Pays $${monetization.amount} ${token} once · paid to author`;
  }
  return '';
}

function authorAmountFromSplit(split: MonetizationSplitSnapshot, monetization: { amount?: string }): string {
  // Author portion is total minus platform amount. Recompute from strings to
  // avoid bigint imports here; both are USDC (6 decimals) decimal strings.
  if (!monetization.amount || !/^\d+(\.\d+)?$/.test(split.totalAmount) || !/^\d+(\.\d+)?$/.test(split.platformAmount)) {
    return split.totalAmount;
  }
  const decimals = 6;
  const scale = (value: string): bigint => {
    const [intPart, fracPart = ''] = value.split('.');
    return BigInt((intPart ?? '0') + fracPart.padEnd(decimals, '0').slice(0, decimals));
  };
  const raw = scale(split.totalAmount) - scale(split.platformAmount);
  if (raw < 0n) return split.totalAmount;
  const out = raw.toString().padStart(decimals + 1, '0');
  const intPart = out.slice(0, -decimals);
  const fracPart = out.slice(-decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

function rowDeferredBanner(row: InstallRow): string {
  const metadata = row.install.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  if ((metadata as Record<string, unknown>).performanceFeeDeferred !== true) return '';
  return `
    <p class="skills-installed-row-banner">
      Performance-fee settlement is manual for now. Author payouts will be added in a follow-up.
    </p>
  `;
}

function rowOneTimePendingBanner(row: InstallRow): string {
  const metadata = row.install.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const approvalId = (metadata as Record<string, unknown>).oneTimeApprovalId;
  if (typeof approvalId !== 'string' || !approvalId) return '';
  return `
    <p class="skills-installed-row-banner">
      Pending initial approval — review the one-time payment in your Needs Approval inbox.
    </p>
  `;
}

export interface RowRenderOptions {
  busyInstallId: string | null;
  pendingUninstallId: string | null;
  pendingUninstallExpiresAt: number;
  nowMs: number;
}

export function renderRow(row: InstallRow, opts: RowRenderOptions): string {
  const { install } = row;
  const busy = opts.busyInstallId === install.id;
  const isActive = install.status === 'active';
  const isPaused = install.status === 'paused';
  const canToggle = isActive || isPaused;
  const toggleLabel = isPaused ? 'Resume' : 'Pause';
  const toggleAction = isPaused ? 'resume' : 'pause';
  const disabled = busy ? 'disabled' : '';
  const runNowButton = isActive
    ? `
      <button
        type="button"
        class="skills-installed-button"
        data-skills-installed-action="run-now"
        data-install-id="${escapeHtml(install.id)}"
        ${disabled}
      >Run now</button>
    `
    : '';
  const isPendingUninstall =
    opts.pendingUninstallId === install.id && opts.pendingUninstallExpiresAt > opts.nowMs;
  const uninstallLabel = isPendingUninstall ? 'Click again to confirm' : 'Uninstall';
  const uninstallClass = isPendingUninstall
    ? 'skills-installed-button is-confirming'
    : 'skills-installed-button is-danger';
  const rowClasses = `skills-installed-row${busy ? ' is-busy' : ''}`;

  const toggleButton = canToggle
    ? `
      <button
        type="button"
        class="skills-installed-button"
        data-skills-installed-action="${toggleAction}"
        data-install-id="${escapeHtml(install.id)}"
        ${disabled}
      >${toggleLabel}</button>
    `
    : '';

  return `
    <article class="${rowClasses}" data-install-id="${escapeHtml(install.id)}" data-status="${escapeHtml(install.status)}">
      <div class="skills-installed-row-name">
        <strong>${escapeHtml(rowTitle(row))}</strong>
        <span class="skills-installed-row-id">${escapeHtml(shortAddress(install.id))}</span>
      </div>
      <span class="skills-installed-row-status ${statusModifier(install.status)}">${escapeHtml(statusLabel(install.status))}</span>
      <div class="skills-installed-row-meta">
        <span class="skills-installed-row-schedule">${escapeHtml(rowScheduleLine(row, opts.nowMs))}</span>
        <span class="skills-installed-row-boundary">${escapeHtml(rowRunBoundaryLine(row))}</span>
        ${row.lastExecutionAt ? `<span class="skills-installed-row-last">Last run ${escapeHtml(humanizeRelative(row.lastExecutionAt, opts.nowMs))}</span>` : ''}
        ${(() => { const line = rowMonetizationLine(row); return line ? `<span class="skills-installed-row-monetization">${escapeHtml(line)}</span>` : ''; })()}
      </div>
      ${rowDeferredBanner(row)}
      ${rowOneTimePendingBanner(row)}
      <div class="skills-installed-row-runs">
        <span class="skills-installed-row-runs-label">Recent</span>
        ${escapeHtml(formatRecentCount(row.recentExecutionCount))}
      </div>
      <div class="skills-installed-row-actions">
        ${runNowButton}
        ${toggleButton}
        <button
          type="button"
          class="${uninstallClass}"
          data-skills-installed-action="uninstall"
          data-install-id="${escapeHtml(install.id)}"
          ${disabled}
        >${escapeHtml(uninstallLabel)}</button>
      </div>
    </article>
  `;
}

function renderEmpty(): string {
  return `
    <p class="skills-installed-empty">
      No skills installed yet.
      <button type="button" class="skills-installed-empty-link" data-skills-installed-action="go-browse">Browse the catalog →</button>
    </p>
  `;
}

function renderLoading(): string {
  return `<p class="skills-installed-loading">Loading installed skills…</p>`;
}

function renderHeader(): string {
  const spinner = state.silentRefetching ? '<span class="skills-installed-spinner" aria-label="Refreshing"></span>' : '';
  return `
    <header class="skills-installed-header">
      <div>
        <h2>Installed</h2>
        <p>Active skills, next run, and controls. Every run still needs approval.</p>
      </div>
      <div class="skills-installed-header-actions">
        ${spinner}
        <button type="button" class="skills-installed-button" data-skills-installed-action="refresh">Refresh</button>
      </div>
    </header>
  `;
}

function renderBody(): string {
  if (state.phase === 'loading' && state.rows.length === 0) return renderLoading();
  if (state.phase === 'error') return '';
  if (state.rows.length === 0) return renderEmpty();
  const opts: RowRenderOptions = {
    busyInstallId: state.actionInFlight,
    pendingUninstallId: state.pendingUninstallId,
    pendingUninstallExpiresAt: state.pendingUninstallExpiresAt,
    nowMs: Date.now(),
  };
  return `
    <div class="skills-installed-grid">
      ${state.rows.map((row) => renderRow(row, opts)).join('')}
    </div>
  `;
}

export function renderInstalledPanel(): string {
  const errorBlock = state.error ? renderError(state.error) : '';
  const actionErrorBlock = state.actionError ? renderActionError(state.actionError) : '';
  let noticeBlock = '';
  if (state.notice) {
    const modifier = state.notice.title === 'Sign in required'
      ? 'is-auth'
      : state.notice.title === 'Permission required'
        ? 'is-forbidden'
        : 'is-not-deployed';
    noticeBlock = renderNotice(state.notice, modifier);
  }
  return `
    <section class="skills-installed-root" data-skills-installed-root>
      ${renderHeader()}
      ${noticeBlock}
      ${errorBlock}
      ${actionErrorBlock}
      ${renderBody()}
    </section>
  `;
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-skills-installed-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderInstalledPanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  root.replaceWith(next);
}

export async function loadInstalls(opts: { silent?: boolean } = {}): Promise<void> {
  const silent = opts.silent === true;
  if (silent) {
    state.silentRefetching = true;
  } else {
    state.phase = 'loading';
    state.error = '';
    state.notice = null;
  }
  rerenderPanelOnly();

  const [installsRes, catalogRes] = await Promise.all([
    getJson<unknown>('/api/skills/installs'),
    getJson<unknown>('/api/skills'),
  ]);

  if (installsRes.kind === 'forbidden') {
    state.notice = forbiddenNotice();
    state.rows = [];
    state.phase = 'ready';
    state.fetchedAt = Date.now();
    state.silentRefetching = false;
    rerenderPanelOnly();
    return;
  }
  if (installsRes.kind === 'notDeployed') {
    state.notice = notDeployedNotice();
    state.rows = [];
    state.phase = 'ready';
    state.fetchedAt = Date.now();
    state.silentRefetching = false;
    rerenderPanelOnly();
    return;
  }
  if (installsRes.kind === 'unauthenticated') {
    state.notice = signInNotice(installsRes.message);
    state.rows = [];
    state.phase = 'ready';
    state.fetchedAt = Date.now();
    state.silentRefetching = false;
    rerenderPanelOnly();
    return;
  }
  if (installsRes.kind === 'error' || installsRes.kind === 'networkError') {
    state.phase = 'error';
    state.error = installsRes.message;
    state.silentRefetching = false;
    rerenderPanelOnly();
    return;
  }

  const baseRows = normalizeInstallsResponse(installsRes.value);
  const catalog = catalogRes.kind === 'ok' ? normalizeCatalogResponse(catalogRes.value) : [];
  state.rows = joinManifests(baseRows, catalog);
  state.phase = 'ready';
  state.fetchedAt = Date.now();
  state.silentRefetching = false;
  rerenderPanelOnly();
}

export function invalidateInstalledCache(): void {
  state.fetchedAt = 0;
  state.error = '';
  state.notice = null;
  state.actionError = '';
  if (typeof document !== 'undefined' && document.querySelector('[data-skills-installed-root]')) {
    const silent = state.phase === 'ready' && state.rows.length > 0;
    void loadInstalls({ silent });
    return;
  }
  state.phase = 'idle';
  state.silentRefetching = false;
}

async function runMutation(
  installId: string,
  action: 'pause' | 'resume' | 'uninstall' | 'run-now',
): Promise<void> {
  if (state.actionInFlight) return;
  const rowBefore = state.rows.find((row) => row.install.id === installId);
  state.actionInFlight = installId;
  state.actionError = '';
  rerenderPanelOnly();

  const result = await postJson<unknown>(
    `/api/skills/installs/${encodeURIComponent(installId)}/${action === 'run-now' ? 'run' : action}`,
    {},
  );
  state.actionInFlight = null;

  if (result.kind === 'ok') {
    if (action === 'uninstall' && rowBefore?.install.monetizationScheduleId) {
      const verifyError = await verifyRecurringSchedulePaused(rowBefore.install.monetizationScheduleId);
      if (verifyError) state.actionError = verifyError;
    }
    rerenderPanelOnly();
    await loadInstalls();
    emitSkillsInstallsChanged({
      source: 'installed',
      installId,
      skillId: rowBefore?.install.skillId,
      status: action === 'uninstall' ? 'revoked' : action === 'pause' ? 'paused' : 'active',
    });
    return;
  }
  if (result.kind === 'unauthenticated') {
    state.actionError = result.message;
  } else if (result.kind === 'forbidden') {
    state.actionError = 'This wallet does not have permission to manage that skill.';
  } else if (result.kind === 'notDeployed') {
    state.actionError = 'Skills API is unavailable in this environment; this action cannot run.';
  } else {
    state.actionError = result.message;
  }
  rerenderPanelOnly();
}

async function verifyRecurringSchedulePaused(scheduleId: string): Promise<string> {
  const result = await getJson<unknown>('/api/recurring');
  if (result.kind !== 'ok') {
    return 'Skill was uninstalled, but the linked creator payment schedule could not be verified.';
  }
  const schedules = isObject(result.value) && Array.isArray(result.value.schedules)
    ? result.value.schedules
    : [];
  const schedule = schedules.find((entry): entry is Record<string, unknown> =>
    isObject(entry) && entry.id === scheduleId,
  );
  if (!schedule) {
    return 'Skill was uninstalled, but the linked creator payment schedule was not returned by /api/recurring.';
  }
  if (schedule.status !== 'paused') {
    return `Skill was uninstalled, but the linked creator payment schedule is ${String(schedule.status)}.`;
  }
  return '';
}

export async function handlePause(installId: string): Promise<void> {
  await runMutation(installId, 'pause');
}

export async function handleResume(installId: string): Promise<void> {
  await runMutation(installId, 'resume');
}

export async function handleUninstall(installId: string): Promise<void> {
  const now = Date.now();
  const armed =
    state.pendingUninstallId === installId && state.pendingUninstallExpiresAt > now;
  if (!armed) {
    state.pendingUninstallId = installId;
    state.pendingUninstallExpiresAt = now + UNINSTALL_CONFIRM_MS;
    if (pendingUninstallTimer) clearTimeout(pendingUninstallTimer);
    pendingUninstallTimer = setTimeout(() => {
      pendingUninstallTimer = null;
      if (state.pendingUninstallId === installId) {
        state.pendingUninstallId = null;
        state.pendingUninstallExpiresAt = 0;
        rerenderPanelOnly();
      }
    }, UNINSTALL_CONFIRM_MS);
    rerenderPanelOnly();
    return;
  }
  state.pendingUninstallId = null;
  state.pendingUninstallExpiresAt = 0;
  if (pendingUninstallTimer) {
    clearTimeout(pendingUninstallTimer);
    pendingUninstallTimer = null;
  }
  await runMutation(installId, 'uninstall');
}

export async function handleRunNow(installId: string): Promise<void> {
  await runMutation(installId, 'run-now');
}

export async function handleAction(action: string, installId = ''): Promise<void> {
  if (action === 'refresh') {
    await loadInstalls();
    return;
  }
  if (action === 'go-browse') {
    setActiveSkillsSubTab('browse');
    if (typeof document !== 'undefined') {
      const browsePill = document.querySelector<HTMLButtonElement>('[data-skills-subtab="browse"]');
      browsePill?.click();
    }
    return;
  }
  if (action === 'dismiss-error') {
    state.error = '';
    rerenderPanelOnly();
    return;
  }
  if (action === 'dismiss-action-error') {
    state.actionError = '';
    rerenderPanelOnly();
    return;
  }
  if (action === 'dismiss-notice') {
    state.notice = null;
    rerenderPanelOnly();
    return;
  }
  if (!installId) return;
  if (action === 'pause') {
    await handlePause(installId);
    return;
  }
  if (action === 'resume') {
    await handleResume(installId);
    return;
  }
  if (action === 'uninstall') {
    await handleUninstall(installId);
    return;
  }
  if (action === 'run-now') {
    await handleRunNow(installId);
    return;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const trigger = target.closest<HTMLElement>('[data-skills-installed-action]');
    if (!trigger) return;
    const action = trigger.dataset.skillsInstalledAction;
    if (!action) return;
    event.preventDefault();
    const installId = trigger.dataset.installId ?? '';
    void handleAction(action, installId);
  });
  onSkillsInstallsChanged((detail) => {
    if (detail.source === 'installed') return;
    invalidateInstalledCache();
  });
}

registerSkillsSubTab({
  id: 'installed',
  label: 'Installed',
  mobileLabel: 'Installed',
  description: 'Your skills with status, next run, pause / uninstall.',
  onMount: () => {
    if (state.phase === 'loading' || state.silentRefetching) return;
    void loadInstalls({ silent: state.phase === 'ready' && state.rows.length > 0 });
  },
  render: () => {
    if (state.phase === 'idle') {
      state.phase = 'loading';
      void loadInstalls();
    } else if (
      state.phase === 'ready' &&
      !state.silentRefetching &&
      state.fetchedAt > 0 &&
      Date.now() - state.fetchedAt > TTL_MS
    ) {
      state.silentRefetching = true;
      Promise.resolve().then(() => {
        void loadInstalls({ silent: true });
      });
    }
    return renderInstalledPanel();
  },
});
