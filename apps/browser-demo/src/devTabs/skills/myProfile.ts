import './myProfile.css';
import { getJson } from './fetchHelpers.js';
import { registerSkillsSubTab } from './subTabRegistry.js';
import { getConnectedAddress } from '../../walletState.js';
import { t, tf } from '../../demo-i18n/uiLang.js';

// Mirrors WalletStatsSnapshot at packages/workflow/src/dev/aggregator.ts:18-27.
// Inlined to keep the workflow `/dev` subpath (which transitively pulls
// node:crypto) out of the browser bundle.
export interface WalletStatsSnapshot {
  walletAddress: string;
  totalSkillsInstalled: number;
  totalExecutions: number;
  successRate: number;
  totalProfitUsd?: string;
  totalGasUsd?: string;
  installedSkillIds: string[];
  computedAt: string;
}

export type ProfilePhase =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'signedOut'
  | 'notDeployed'
  | 'noWallet';

export interface ProfilePanelState {
  phase: ProfilePhase;
  wallet: string | undefined;
  snapshot: WalletStatsSnapshot | null;
  errorMessage: string;
  fetchedAt: number;
}

const PUBLIC_PROFILE_URL_BASE = 'https://agentic-signer.com/u/';
const MALFORMED_WALLET_STATS_RESPONSE = 'Malformed wallet stats response.';

const panelState: ProfilePanelState = {
  phase: 'idle',
  wallet: undefined,
  snapshot: null,
  errorMessage: '',
  fetchedAt: 0,
};

let kickoffScheduled = false;

export function __resetPanelStateForTests(next: Partial<ProfilePanelState> = {}): void {
  panelState.phase = next.phase ?? 'idle';
  panelState.wallet = next.wallet;
  panelState.snapshot = next.snapshot ?? null;
  panelState.errorMessage = next.errorMessage ?? '';
  panelState.fetchedAt = next.fetchedAt ?? 0;
  kickoffScheduled = false;
}

export function __getPanelStateForTests(): Readonly<ProfilePanelState> {
  return {
    phase: panelState.phase,
    wallet: panelState.wallet,
    snapshot: panelState.snapshot,
    errorMessage: panelState.errorMessage,
    fetchedAt: panelState.fetchedAt,
  };
}

export function __getKickoffScheduledForTests(): boolean {
  return kickoffScheduled;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

export function shortAddress(value: string): string {
  if (!value) return '';
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function buildPublicProfileUrl(wallet: string): string {
  return `${PUBLIC_PROFILE_URL_BASE}${wallet}`;
}

export function formatSuccessRate(rate: number): string {
  if (!Number.isFinite(rate)) return '-';
  const clamped = Math.max(0, Math.min(1, rate));
  return `${Math.round(clamped * 100)}%`;
}

export function formatUsd(value: string | undefined): string {
  if (value === undefined || value === null || value === '') return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return `$${num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const deltaMs = Math.max(0, now - ts);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return tf('{n}s ago', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return tf('{n}m ago', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return tf('{n}h ago', { n: hr });
  const days = Math.floor(hr / 24);
  return tf('{n}d ago', { n: days });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeWalletStats(value: unknown): value is WalletStatsSnapshot {
  return (
    isObject(value) &&
    typeof value.walletAddress === 'string' &&
    typeof value.totalSkillsInstalled === 'number' &&
    typeof value.totalExecutions === 'number' &&
    typeof value.successRate === 'number' &&
    Array.isArray(value.installedSkillIds) &&
    value.installedSkillIds.every((id) => typeof id === 'string') &&
    typeof value.computedAt === 'string'
  );
}

export function normalizeWalletStats(input: unknown): WalletStatsSnapshot | null {
  if (looksLikeWalletStats(input)) return input;
  if (isObject(input) && looksLikeWalletStats(input.snapshot)) return input.snapshot;
  return null;
}

function renderHeading(): string {
  return `
    <header class="skills-profile-heading">
      <span class="skills-profile-tag">${t('Public profile')}</span>
      <h2>${t('My track record')}</h2>
      <p>
        ${t('Preview the public receipt-backed profile for this wallet. Copy the URL when you want to share the skill record outside the app.')}
      </p>
    </header>
  `;
}

function renderCopyUrlRow(wallet: string): string {
  const url = buildPublicProfileUrl(wallet);
  const safeUrl = escapeHtml(url);
  return `
    <div class="skills-profile-actions">
      <code class="skills-profile-url">${safeUrl}</code>
      <div class="skills-profile-action-buttons">
        <button
          type="button"
          class="skills-profile-button"
          data-skills-profile-action="copy-url"
          data-skills-profile-value="${safeUrl}"
        >${t('Copy URL')}</button>
        <a
          class="skills-profile-button skills-profile-button-secondary"
          href="${safeUrl}"
          target="_blank"
          rel="noreferrer"
          data-skills-profile-action="view-live"
        >${t('View live →')}</a>
        <button
          type="button"
          class="skills-profile-button skills-profile-button-ghost"
          data-skills-profile-action="refresh"
        >${t('Refresh')}</button>
      </div>
    </div>
  `;
}

function renderStatCard(label: string, value: string): string {
  return `
    <div class="skills-profile-stat-card">
      <span class="skills-profile-stat-label">${escapeHtml(label)}</span>
      <span class="skills-profile-stat-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderStatsRow(snapshot: WalletStatsSnapshot): string {
  return `
    <div class="skills-profile-stats">
      ${renderStatCard(t('Skills installed'), String(snapshot.totalSkillsInstalled))}
      ${renderStatCard(t('Executions'), String(snapshot.totalExecutions))}
      ${renderStatCard(t('Success rate'), formatSuccessRate(snapshot.successRate))}
      ${renderStatCard(t('Profit (USD)'), formatUsd(snapshot.totalProfitUsd))}
      ${renderStatCard(t('Gas spent (USD)'), formatUsd(snapshot.totalGasUsd))}
    </div>
  `;
}

function renderSkillsChips(ids: readonly string[]): string {
  if (ids.length === 0) {
    return `<p class="skills-profile-empty-chips">${t('No skills installed yet.')}</p>`;
  }
  const items = ids
    .map(
      (id) =>
        `<a class="skills-profile-chip" href="https://agentic-signer.com/skills/${encodeURIComponent(
          id,
        )}" target="_blank" rel="noreferrer">${escapeHtml(id)}</a>`,
    )
    .join('');
  return `<div class="skills-profile-skills-chips">${items}</div>`;
}

function renderLoadedBody(snapshot: WalletStatsSnapshot, wallet: string): string {
  const computed = formatRelativeTime(snapshot.computedAt);
  const computedText = computed ? tf('Computed {when}', { when: escapeHtml(computed) }) : t('Computed just now');
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-header">
        <div>
          <span class="skills-profile-wallet">${escapeHtml(shortAddress(wallet))}</span>
          <span class="skills-profile-computed">${computedText}</span>
        </div>
      </div>
      ${renderStatsRow(snapshot)}
      <div class="skills-profile-section">
        <span class="skills-profile-section-label">${t('Installed skills')}</span>
        ${renderSkillsChips(snapshot.installedSkillIds)}
      </div>
    </div>
    ${renderCopyUrlRow(wallet)}
  `;
}

function renderEmptyBody(wallet: string): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice">
        <strong>${t('No executions yet')}</strong>
        <p>
          ${tf('Install a skill from the {browse} tab and approve its first proposal to start building a verifiable track record. Stats appear here once receipts land.', { browse: `<em>${t('Browse')}</em>` })}
        </p>
      </div>
    </div>
    ${renderCopyUrlRow(wallet)}
  `;
}

function renderLoadingBody(): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-skeleton" aria-busy="true">
        <span class="skills-profile-skeleton-line skills-profile-skeleton-line-wide"></span>
        <span class="skills-profile-skeleton-line"></span>
        <span class="skills-profile-skeleton-line"></span>
      </div>
    </div>
  `;
}

function renderForbiddenBody(): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice skills-profile-notice-warn">
        <strong>${t('Profile not available')}</strong>
        <p>
          ${t('This wallet\'s public skill profile is not available yet. Install a skill and approve a run to start building a receipt-backed profile.')}
        </p>
      </div>
    </div>
  `;
}

function renderSignedOutBody(): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice">
        <strong>${t('Sign in required')}</strong>
        <p>${escapeHtml(panelState.errorMessage || t('Sign in to Agentic Cloud with your wallet to preview your public skill profile.'))}</p>
      </div>
    </div>
  `;
}

function renderNotDeployedBody(wallet: string): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice">
        <strong>${t('Profile aggregator API unavailable')}</strong>
        <p>
          ${tf('The {endpoint} endpoint returned 404 in this environment. The public URL pattern below is still the canonical place for your page when this UI is pointed at a render-web server with aggregator routes enabled.', { endpoint: '<code>/api/aggregator/wallets/&lt;wallet&gt;</code>' })}
        </p>
      </div>
    </div>
    ${renderCopyUrlRow(wallet)}
  `;
}

function renderErrorBody(errorMessage: string): string {
  const displayMessage = errorMessage === MALFORMED_WALLET_STATS_RESPONSE
    ? t('Malformed wallet stats response.')
    : errorMessage;
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice skills-profile-notice-error">
        <strong>${t('Couldn\'t load profile stats')}</strong>
        <p>${escapeHtml(displayMessage)}</p>
        <button
          type="button"
          class="skills-profile-button"
          data-skills-profile-action="retry"
        >${t('Retry')}</button>
      </div>
    </div>
  `;
}

function renderNoWalletBody(): string {
  return `
    <div class="skills-profile-card">
      <div class="skills-profile-notice">
        <strong>${t('Connect a wallet')}</strong>
        <p>
          ${tf('Connect the wallet you use for skills to preview the public {path} profile that aggregates receipt-backed runs.', { path: '<code>/u/&lt;wallet&gt;</code>' })}
        </p>
      </div>
    </div>
  `;
}

export function renderMyProfilePanel(): string {
  let body = '';
  switch (panelState.phase) {
    case 'noWallet':
      body = renderNoWalletBody();
      break;
    case 'loading':
      body = renderLoadingBody();
      break;
    case 'forbidden':
      body = renderForbiddenBody();
      break;
    case 'signedOut':
      body = renderSignedOutBody();
      break;
    case 'notDeployed':
      body = renderNotDeployedBody(panelState.wallet ?? '');
      break;
    case 'error':
      body = renderErrorBody(panelState.errorMessage || t('Unknown error'));
      break;
    case 'empty':
      body = renderEmptyBody(panelState.wallet ?? '');
      break;
    case 'loaded':
      body = panelState.snapshot
        ? renderLoadedBody(panelState.snapshot, panelState.wallet ?? panelState.snapshot.walletAddress)
        : renderLoadingBody();
      break;
    case 'idle':
    default:
      body = renderLoadingBody();
      break;
  }
  return `
    <section class="skills-profile" data-skills-profile-root>
      ${renderHeading()}
      ${body}
    </section>
  `;
}

async function fetchWalletStats(wallet: string): Promise<void> {
  panelState.wallet = wallet;
  panelState.phase = 'loading';
  panelState.errorMessage = '';
  rerenderPanelOnly();
  const result = await getJson<unknown>(
    `/api/aggregator/wallets/${encodeURIComponent(wallet)}`,
  );
  if (panelState.wallet !== wallet) return;
  switch (result.kind) {
    case 'ok': {
      const snap = normalizeWalletStats(result.value);
      if (!snap) {
        panelState.snapshot = null;
        panelState.phase = 'error';
        panelState.errorMessage = MALFORMED_WALLET_STATS_RESPONSE;
        break;
      }
      panelState.snapshot = snap;
      if (
        (snap.totalExecutions ?? 0) === 0 &&
        (snap.totalSkillsInstalled ?? 0) === 0
      ) {
        panelState.phase = 'empty';
      } else {
        panelState.phase = 'loaded';
      }
      break;
    }
    case 'forbidden':
      panelState.phase = 'forbidden';
      break;
    case 'unauthenticated':
      panelState.phase = 'signedOut';
      panelState.errorMessage = result.message;
      break;
    case 'notDeployed':
      panelState.phase = 'notDeployed';
      break;
    case 'networkError':
      panelState.phase = 'error';
      panelState.errorMessage = result.message;
      break;
    case 'error':
      panelState.phase = 'error';
      panelState.errorMessage = result.message;
      break;
  }
  panelState.fetchedAt = Date.now();
  rerenderPanelOnly();
}

export async function __fetchWalletStatsForTests(wallet: string): Promise<void> {
  await fetchWalletStats(wallet);
}

function rerenderPanelOnly(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-skills-profile-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderMyProfilePanel().trim();
  const next = template.content.firstElementChild;
  if (!next) return;
  root.replaceWith(next);
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (typeof document === 'undefined') return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'skills-profile-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove('visible');
  }, 3_000);
}

async function handleAction(action: string, dataset: DOMStringMap): Promise<void> {
  switch (action) {
    case 'copy-url': {
      const value = dataset.skillsProfileValue ?? '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        showToast(t('Public URL copied'));
      } catch {
        showToast(t('Copy failed - clipboard permission denied'));
      }
      return;
    }
    case 'retry':
    case 'refresh': {
      const wallet = getConnectedAddress();
      if (!wallet) {
        panelState.phase = 'noWallet';
        rerenderPanelOnly();
        return;
      }
      await fetchWalletStats(wallet);
      return;
    }
    case 'view-live':
      // anchor's default click behavior handles navigation
      return;
    default:
      return;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    const trigger = target.closest<HTMLElement>('[data-skills-profile-action]');
    if (!trigger) return;
    const action = trigger.dataset.skillsProfileAction;
    if (!action) return;
    if (action !== 'view-live') {
      event.preventDefault();
    }
    void handleAction(action, trigger.dataset);
  });
}

registerSkillsSubTab({
  id: 'profile',
  label: 'My Profile',
  mobileLabel: 'Profile',
  description: 'Your verifiable public track record.',
  onMount: () => {
    if (panelState.phase === 'loading' || kickoffScheduled) return;
    const wallet = getConnectedAddress();
    if (!wallet) {
      panelState.phase = 'noWallet';
      panelState.wallet = undefined;
      panelState.snapshot = null;
      panelState.errorMessage = '';
      rerenderPanelOnly();
      return;
    }
    void fetchWalletStats(wallet);
  },
  render: () => {
    const wallet = getConnectedAddress();
    if (!wallet) {
      panelState.phase = 'noWallet';
      panelState.wallet = undefined;
      panelState.snapshot = null;
      panelState.errorMessage = '';
      return renderMyProfilePanel();
    }
    if (panelState.wallet !== wallet) {
      panelState.wallet = wallet;
      panelState.phase = 'idle';
      panelState.snapshot = null;
      panelState.errorMessage = '';
    }
    if (panelState.phase === 'idle' && !kickoffScheduled) {
      kickoffScheduled = true;
      Promise.resolve().then(() => {
        kickoffScheduled = false;
        void fetchWalletStats(wallet);
      });
    }
    return renderMyProfilePanel();
  },
});
