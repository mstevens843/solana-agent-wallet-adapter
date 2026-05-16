import './sessions.css';

import type {
  StreamingSessionRecord,
  StreamingVoucherRecord,
} from '@solana-agent-wallet-adapter/workflow';
import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';
import {
  DEFAULT_USDC_MINT,
  VOUCHERS_PER_PAGE,
  filteredSessions,
  getSessionsState,
  handleStreamingApprovalStatus,
  loadSessions,
  openSessionDetail,
  requestRevokeSelectedSession,
  selectSession,
  selectedDetail,
  setCreateModalOpen,
  setSessionsFilter,
  setVoucherPage,
  startSessionDetailPolling,
  stopSessionDetailPolling,
  submitCreateSession,
  subscribeSessionsState,
  updateCreateDraftField,
  validateCreateDraft,
  type CreateSessionDraft,
  type SessionsStatusFilter,
} from '../sessionState.js';
import { addStreamingApprovalCompletedListener } from '../streamingApprovalEvents.js';
import { getConnectedAddress, getConnectedCluster } from '../walletState.js';

const FILTERS: readonly SessionsStatusFilter[] = ['active', 'expired', 'settled', 'revoked'];
const ROOT_SELECTOR = '[data-sessions-root]';

let domInstalled = false;
let initialLoadScheduled = false;
let countdownTimer: number | null = null;

function escapeHtml(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortAddress(value: string | undefined | null): string {
  if (!value) return '';
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function formatAmount(value: string | undefined | null): string {
  if (!value) return '0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function formatDateTime(value: string | undefined | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function expiryCountdown(value: string | undefined | null, now = Date.now()): string {
  if (!value) return 'No expiry';
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt)) return value;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return 'Expired';
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function progressPercent(session: StreamingSessionRecord): number {
  const cap = Number(session.capAmount);
  const spent = Number(session.spentAmount);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(spent) || spent <= 0) return 0;
  return Math.min(100, Math.max(0, (spent / cap) * 100));
}

function sessionStatusClass(status: StreamingSessionRecord['status']): string {
  if (status === 'active' || status === 'pending') return 'sessions-pill--active';
  if (status === 'expired') return 'sessions-pill--expired';
  if (status === 'revoked') return 'sessions-pill--revoked';
  return 'sessions-pill--settled';
}

function sessionStatusLabel(status: StreamingSessionRecord['status']): string {
  return status === 'pending' ? 'pending grant' : status;
}

function tokenLabel(session: StreamingSessionRecord): string {
  return session.tokenMint === DEFAULT_USDC_MINT ? 'USDC' : shortAddress(session.tokenMint);
}

function filteredCount(filter: SessionsStatusFilter): number {
  const snapshot = getSessionsState();
  if (filter === 'active') {
    return snapshot.sessions.filter((session) => session.status === 'active' || session.status === 'pending').length;
  }
  return snapshot.sessions.filter((session) => session.status === filter).length;
}

function filterButton(filter: SessionsStatusFilter): string {
  const snapshot = getSessionsState();
  const active = snapshot.filter === filter;
  const label = filter.charAt(0).toUpperCase() + filter.slice(1);
  return `
    <button
      type="button"
      class="sessions-filter-button ${active ? 'active' : ''}"
      data-sessions-filter="${escapeHtml(filter)}"
      aria-pressed="${active ? 'true' : 'false'}"
    >
      <span>${escapeHtml(label)}</span>
      <strong>${filteredCount(filter)}</strong>
    </button>
  `;
}

export function sessionRowHtml(session: StreamingSessionRecord, selectedId: string | null): string {
  const selected = session.id === selectedId;
  const percent = progressPercent(session);
  return `
    <li>
      <button
        type="button"
        class="sessions-row ${selected ? 'selected' : ''}"
        data-sessions-select="${escapeHtml(session.id)}"
      >
        <span class="sessions-row-main">
          <span class="sessions-row-head">
            <strong>${escapeHtml(shortAddress(session.id))}</strong>
            <span class="sessions-pill ${sessionStatusClass(session.status)}">${escapeHtml(sessionStatusLabel(session.status))}</span>
          </span>
          <span class="sessions-row-meta">
            <span>${escapeHtml(formatAmount(session.spentAmount))} / ${escapeHtml(formatAmount(session.capAmount))} ${escapeHtml(tokenLabel(session))}</span>
            <span>Expires ${escapeHtml(expiryCountdown(session.expiresAt))}</span>
          </span>
          <span class="sessions-mini-progress" aria-hidden="true">
            <span style="width: ${percent.toFixed(2)}%"></span>
          </span>
        </span>
      </button>
    </li>
  `;
}

function sessionsListHtml(): string {
  const snapshot = getSessionsState();
  const rows = filteredSessions(snapshot);
  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    return '<p class="dev-tab-loading-state sessions-list-state">Loading streaming sessions...</p>';
  }
  if (snapshot.status === 'error' && rows.length === 0) {
    return `
      <div class="sessions-error">
        <p>${escapeHtml(snapshot.errorMessage || 'Could not load streaming sessions.')}</p>
        <button type="button" class="utility" data-sessions-refresh>Retry</button>
      </div>
    `;
  }
  if (rows.length === 0) {
    return `
      <div class="dev-tab-empty-state sessions-list-state">
        <p>No ${escapeHtml(snapshot.filter)} streaming sessions.</p>
      </div>
    `;
  }
  return `<ol class="sessions-list">${rows.map((session) => sessionRowHtml(session, snapshot.selectedSessionId)).join('')}</ol>`;
}

function progressHtml(session: StreamingSessionRecord): string {
  const percent = progressPercent(session);
  return `
    <div class="sessions-progress" aria-label="Session spend">
      <div class="sessions-progress-label">
        <span>${escapeHtml(formatAmount(session.spentAmount))} spent</span>
        <strong>${escapeHtml(percent.toFixed(0))}%</strong>
        <span>${escapeHtml(formatAmount(session.capAmount))} cap</span>
      </div>
      <div class="sessions-progress-track">
        <span style="width: ${percent.toFixed(2)}%"></span>
      </div>
    </div>
  `;
}

function allowlistHtml(session: StreamingSessionRecord): string {
  const allowlist = session.recipientAllowlist ?? [];
  if (allowlist.length === 0) {
    return '<span class="sessions-allowlist-empty">Any recipient</span>';
  }
  return allowlist.map((recipient) =>
    `<span class="sessions-chip" title="${escapeHtml(recipient)}">${escapeHtml(shortAddress(recipient))}</span>`,
  ).join('');
}

function voucherRowHtml(voucher: StreamingVoucherRecord): string {
  const status = voucher.settledAt ? 'settled' : 'issued';
  return `
    <li class="sessions-voucher-row">
      <span>
        <strong>${escapeHtml(formatAmount(voucher.amount))}</strong>
        <em>${escapeHtml(status)}</em>
      </span>
      <span title="${escapeHtml(voucher.recipient)}">${escapeHtml(shortAddress(voucher.recipient))}</span>
      <span title="${escapeHtml(voucher.voucherHash)}">${escapeHtml(shortAddress(voucher.voucherHash))}</span>
      <span>${escapeHtml(formatDateTime(voucher.issuedAt))}</span>
    </li>
  `;
}

function vouchersHtml(vouchers: readonly StreamingVoucherRecord[]): string {
  const snapshot = getSessionsState();
  if (vouchers.length === 0) {
    return '<p class="sessions-vouchers-empty">No vouchers issued yet.</p>';
  }
  const maxPage = Math.max(0, Math.ceil(vouchers.length / VOUCHERS_PER_PAGE) - 1);
  const page = Math.min(snapshot.voucherPage, maxPage);
  const start = page * VOUCHERS_PER_PAGE;
  const visible = [...vouchers]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(start, start + VOUCHERS_PER_PAGE);
  return `
    <div class="sessions-vouchers-table" role="table" aria-label="Issued vouchers">
      <div class="sessions-voucher-head" role="row">
        <span>Amount</span>
        <span>Recipient</span>
        <span>Voucher hash</span>
        <span>Issued</span>
      </div>
      <ol>${visible.map(voucherRowHtml).join('')}</ol>
    </div>
    <div class="sessions-voucher-pagination">
      <button type="button" class="utility" data-sessions-voucher-page="${page - 1}" ${page <= 0 ? 'disabled' : ''}>Previous</button>
      <span>Page ${page + 1} of ${maxPage + 1}</span>
      <button type="button" class="utility" data-sessions-voucher-page="${page + 1}" ${page >= maxPage ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function receiptHtml(session: StreamingSessionRecord): string {
  const detail = selectedDetail();
  const settlement = detail?.settlement;
  const receiptUrl = detail?.receiptUrl || (settlement?.receiptId || session.status === 'settled'
    ? `/api/streaming/sessions/${encodeURIComponent(session.id)}/receipt`
    : '');
  if (!receiptUrl) {
    return '<p class="sessions-receipt-empty">Settlement receipt appears here after settlement.</p>';
  }
  return `
    <a class="sessions-receipt-link" href="${escapeHtml(receiptUrl)}" target="_blank" rel="noreferrer">
      ${escapeHtml(settlement?.receiptId ? `Receipt ${shortAddress(settlement.receiptId)}` : 'Open settlement receipt')}
    </a>
  `;
}

export function detailHtml(): string {
  const snapshot = getSessionsState();
  const session = snapshot.selectedSessionId
    ? snapshot.sessions.find((candidate) => candidate.id === snapshot.selectedSessionId) ?? null
    : null;
  if (!session) {
    return `
      <section class="sessions-detail dev-tab-panel">
        <div class="dev-tab-empty-state">Select a session to inspect spend, vouchers, and settlement.</div>
      </section>
    `;
  }
  const detail = selectedDetail(snapshot);
  const vouchers = detail?.vouchers ?? [];
  const revokeDisabled = snapshot.busy === 'revoke' || session.status === 'revoked' || session.status === 'settled';
  return `
    <section class="sessions-detail dev-tab-panel" aria-label="Streaming session detail">
      <div class="sessions-detail-head">
        <div>
          <p class="dev-tab-kicker">Session detail</p>
          <h3>${escapeHtml(shortAddress(session.id))}</h3>
        </div>
        <span class="sessions-pill ${sessionStatusClass(session.status)}">${escapeHtml(sessionStatusLabel(session.status))}</span>
      </div>

      <div class="sessions-detail-grid">
        <div class="sessions-metric">
          <span>Live spend</span>
          <strong>${escapeHtml(formatAmount(session.spentAmount))} ${escapeHtml(tokenLabel(session))}</strong>
        </div>
        <div class="sessions-metric">
          <span>Cap</span>
          <strong>${escapeHtml(formatAmount(session.capAmount))} ${escapeHtml(tokenLabel(session))}</strong>
        </div>
        <div class="sessions-metric">
          <span>Expires</span>
          <strong data-sessions-countdown>${escapeHtml(expiryCountdown(session.expiresAt))}</strong>
        </div>
      </div>

      ${progressHtml(session)}

      <dl class="sessions-facts">
        <div><dt>Delegate</dt><dd title="${escapeHtml(session.delegatePubkey)}">${escapeHtml(shortAddress(session.delegatePubkey))}</dd></div>
        <div><dt>Signer</dt><dd title="${escapeHtml(session.ephemeralSignerPubkey)}">${escapeHtml(shortAddress(session.ephemeralSignerPubkey))}</dd></div>
        <div><dt>Mint</dt><dd title="${escapeHtml(session.tokenMint)}">${escapeHtml(tokenLabel(session))}</dd></div>
        <div><dt>Cluster</dt><dd>${escapeHtml(session.cluster)}</dd></div>
      </dl>

      <section class="sessions-subsection">
        <div class="sessions-subsection-head">
          <h4>Recipient allowlist</h4>
        </div>
        <div class="sessions-chip-row">${allowlistHtml(session)}</div>
      </section>

      <section class="sessions-subsection">
        <div class="sessions-subsection-head">
          <h4>Vouchers</h4>
          <span>${vouchers.length}</span>
        </div>
        ${vouchersHtml(vouchers)}
      </section>

      <section class="sessions-subsection">
        <div class="sessions-subsection-head">
          <h4>Settlement</h4>
        </div>
        ${receiptHtml(session)}
      </section>

      <div class="sessions-detail-actions">
        <button type="button" class="utility danger" data-sessions-revoke="${escapeHtml(session.id)}" ${revokeDisabled ? 'disabled' : ''}>
          ${snapshot.busy === 'revoke' ? 'Preparing revoke...' : 'Revoke'}
        </button>
      </div>
    </section>
  `;
}

function createFieldError(field: keyof CreateSessionDraft | 'form'): string {
  return getSessionsState().createErrors[field] ?? '';
}

function createModalHtml(): string {
  const snapshot = getSessionsState();
  if (!snapshot.createModalOpen) return '';
  const draft = snapshot.createDraft;
  const formError = createFieldError('form');
  const cluster = getConnectedCluster() || 'mainnet-beta';
  return `
    <div class="sessions-modal-backdrop" data-sessions-create-modal>
      <form class="sessions-modal" onsubmit="return false;">
        <div class="sessions-modal-head">
          <div>
            <p class="dev-tab-kicker">New streaming grant</p>
            <h3>Create Session</h3>
          </div>
          <button type="button" class="utility" data-sessions-close-create aria-label="Close">Close</button>
        </div>
        ${formError ? `<p class="sessions-form-error">${escapeHtml(formError)}</p>` : ''}
        <label>
          <span>Token mint</span>
          <input type="text" value="${escapeHtml(draft.tokenMint)}" data-sessions-create-field="tokenMint" autocomplete="off" />
          ${createFieldError('tokenMint') ? `<em>${escapeHtml(createFieldError('tokenMint'))}</em>` : ''}
        </label>
        <label>
          <span>Cap amount</span>
          <input type="text" inputmode="decimal" value="${escapeHtml(draft.capAmount)}" data-sessions-create-field="capAmount" placeholder="25" />
          ${createFieldError('capAmount') ? `<em>${escapeHtml(createFieldError('capAmount'))}</em>` : ''}
        </label>
        <label>
          <span>Expiry duration</span>
          <input type="number" min="1" max="60" step="1" value="${escapeHtml(draft.durationMinutes)}" data-sessions-create-field="durationMinutes" />
          ${createFieldError('durationMinutes') ? `<em>${escapeHtml(createFieldError('durationMinutes'))}</em>` : ''}
        </label>
        <div class="sessions-modal-context">
          <span>Cluster</span>
          <strong>${escapeHtml(cluster)}</strong>
        </div>
        <label>
          <span>Recipient allowlist</span>
          <textarea data-sessions-create-field="recipientAllowlist" rows="3" placeholder="Optional, comma or line separated">${escapeHtml(draft.recipientAllowlist)}</textarea>
          ${createFieldError('recipientAllowlist') ? `<em>${escapeHtml(createFieldError('recipientAllowlist'))}</em>` : ''}
        </label>
        <div class="sessions-modal-actions">
          <button type="button" class="utility" data-sessions-close-create>Cancel</button>
          <button type="button" class="primary" data-sessions-create-submit ${snapshot.busy === 'create' ? 'disabled' : ''}>
            ${snapshot.busy === 'create' ? 'Creating...' : 'Create Session'}
          </button>
        </div>
      </form>
    </div>
  `;
}

export function renderSessionsPanel(): string {
  ensureSessionsRuntime();
  const snapshot = getSessionsState();
  if (snapshot.status === 'idle' && !initialLoadScheduled) {
    initialLoadScheduled = true;
    queueMicrotask(() => {
      void loadSessions().finally(() => {
        initialLoadScheduled = false;
      });
    });
  }
  const activeCount = snapshot.sessions.filter((session) => session.status === 'active' || session.status === 'pending').length;
  const spent = snapshot.sessions
    .filter((session) => session.status === 'active' || session.status === 'settled')
    .reduce((total, session) => total + (Number(session.spentAmount) || 0), 0);
  return `
    <section class="sessions-shell dev-tab-shell" data-sessions-root>
      <header class="sessions-header dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-tab-kicker">Streaming payments</p>
          <div class="dev-tab-title-row">
            <h2>Sessions</h2>
            <span class="sessions-live-pill">${snapshot.status === 'loading' ? 'Syncing' : 'Live'}</span>
          </div>
          <p>Grant a bounded SPL Token delegate session, watch voucher spend, and revoke the delegate from your wallet.</p>
        </div>
        <div class="dev-tab-header-actions">
          <button type="button" class="primary" data-sessions-open-create>Create Session</button>
          <button type="button" class="utility" data-sessions-refresh ${snapshot.status === 'loading' ? 'disabled' : ''}>Refresh</button>
        </div>
      </header>

      ${snapshot.notice ? `<p class="sessions-notice sessions-notice--${escapeHtml(snapshot.notice.tone)}">${escapeHtml(snapshot.notice.message)}</p>` : ''}

      <div class="sessions-overview" aria-label="Streaming sessions summary">
        <div class="dev-tab-stat"><span>Active</span><strong>${activeCount}</strong></div>
        <div class="dev-tab-stat"><span>Live spend</span><strong>${escapeHtml(formatAmount(String(spent)))}</strong></div>
        <div class="dev-tab-stat"><span>Default mint</span><strong>USDC</strong></div>
      </div>

      <div class="sessions-filter-row" role="tablist" aria-label="Session status filter">
        ${FILTERS.map(filterButton).join('')}
      </div>

      <div class="sessions-layout">
        <section class="sessions-list-pane dev-tab-panel" aria-label="Streaming sessions">
          ${sessionsListHtml()}
        </section>
        ${detailHtml()}
      </div>

      ${createModalHtml()}
    </section>
  `;
}

function patchSessionsRoot(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector(ROOT_SELECTOR);
  if (!root) return;
  const template = document.createElement('template');
  template.innerHTML = renderSessionsPanel().trim();
  const next = template.content.firstElementChild;
  if (next) root.replaceWith(next);
}

function refreshCountdownText(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector(ROOT_SELECTOR);
  if (!root) {
    stopSessionDetailPolling();
    if (countdownTimer !== null) {
      // Phase 5.18 — guard `window` for non-browser environments (SSR, tests
      // that import this module outside of a JSDOM context). globalThis
      // exposes clearInterval in both Node and browsers.
      if (typeof window !== 'undefined') window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    return;
  }
  const session = getSessionsState().selectedSessionId
    ? getSessionsState().sessions.find((candidate) => candidate.id === getSessionsState().selectedSessionId)
    : undefined;
  const target = root.querySelector<HTMLElement>('[data-sessions-countdown]');
  if (session && target) target.textContent = expiryCountdown(session.expiresAt);
}

function ensureSessionsRuntime(): void {
  if (typeof document === 'undefined') return;
  if (!domInstalled) {
    domInstalled = true;
    installSessionsDomHandlers();
    subscribeSessionsState(patchSessionsRoot);
    addStreamingApprovalCompletedListener((detail) => {
      handleStreamingApprovalStatus(detail);
    });
  }
  startSessionDetailPolling();
  if (countdownTimer === null && typeof window !== 'undefined') {
    // Phase 5.18 — guard `window` for non-browser environments. If window is
    // unavailable we skip the countdown refresh; the per-render text still
    // calls expiryCountdown() so the user sees a fresh value on every
    // re-render, just without the per-second tick.
    countdownTimer = window.setInterval(refreshCountdownText, 1000);
  }
}

function installSessionsDomHandlers(): void {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const filterBtn = target.closest<HTMLButtonElement>('[data-sessions-filter]');
    if (filterBtn) {
      event.preventDefault();
      const filter = filterBtn.dataset.sessionsFilter as SessionsStatusFilter | undefined;
      if (filter && FILTERS.includes(filter)) setSessionsFilter(filter);
      return;
    }

    const rowBtn = target.closest<HTMLButtonElement>('[data-sessions-select]');
    if (rowBtn) {
      event.preventDefault();
      const sessionId = rowBtn.dataset.sessionsSelect;
      if (sessionId) void selectSession(sessionId);
      return;
    }

    if (target.closest('[data-sessions-refresh]')) {
      event.preventDefault();
      void loadSessions(true);
      return;
    }

    if (target.closest('[data-sessions-open-create]')) {
      event.preventDefault();
      setCreateModalOpen(true);
      return;
    }

    if (target.closest('[data-sessions-close-create]')) {
      event.preventDefault();
      setCreateModalOpen(false);
      return;
    }

    const createSubmit = target.closest<HTMLButtonElement>('[data-sessions-create-submit]');
    if (createSubmit) {
      event.preventDefault();
      void submitCreateSession();
      return;
    }

    const revokeBtn = target.closest<HTMLButtonElement>('[data-sessions-revoke]');
    if (revokeBtn) {
      event.preventDefault();
      void requestRevokeSelectedSession();
      return;
    }

    const voucherPage = target.closest<HTMLButtonElement>('[data-sessions-voucher-page]');
    if (voucherPage) {
      event.preventDefault();
      const page = Number(voucherPage.dataset.sessionsVoucherPage);
      if (Number.isInteger(page)) setVoucherPage(page);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    const field = target.dataset.sessionsCreateField as keyof CreateSessionDraft | undefined;
    if (!field) return;
    updateCreateDraftField(field, target.value);
  });
}

registerDevTab({
  id: 'sessions',
  label: 'Sessions',
  mobileLabel: 'Sessions',
  guard: () => isDevWallet(getConnectedAddress()),
  render: renderSessionsPanel,
});

export const __sessionsForTests = {
  detailHtml,
  expiryCountdown,
  filteredCount,
  progressPercent,
  renderSessionsPanel,
  openSessionDetail,
  sessionRowHtml,
  validateCreateDraft,
};
