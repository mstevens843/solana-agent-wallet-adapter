import { registerDevTab } from '../devTabRegistry.js';
import { isDevWallet } from '../devGate.js';
import { currentAddress, refreshConnection } from '../connectionState.js';
import './externalAgents.css';

// Mirrors the server's normalizeApprovalForResponse() at
// apps/render-web/src/cloud/ap2Routes.ts:401-418 and the metadata enrichment
// at lines 209-216 (which adds `publicKey` to `ap2VerifiedAgent`).
export interface NormalizedApproval {
  id: string;
  kind: string;
  status: string;
  summary: string;
  amount: string | null;
  token: string | null;
  recipient: string | null;
  cluster: string | null;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  txid: string | null;
  txStatus: string | null;
  metadata: NormalizedApprovalMetadata;
  params: Record<string, unknown>;
}

export interface NormalizedApprovalMetadata {
  ap2VerifiedAgent?: { agentId: string; agentLabel: string; publicKey?: string };
  ap2MandateId?: string;
  ap2MandateType?: string;
  ap2ProtocolVersion?: string;
  connectorId?: string;
  connectorName?: string;
  [key: string]: unknown;
}

export type CacheState = 'idle' | 'loading' | 'loaded' | 'error';

interface TabState {
  status: CacheState;
  inbound: NormalizedApproval[];
  errorMessage: string;
  lastFetchedFor: string | null;
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'approved',
  'denied',
  'cancelled',
  'expired',
  'rejected',
]);

const state: TabState = {
  status: 'idle',
  inbound: [],
  errorMessage: '',
  lastFetchedFor: null,
};

// ---------------- Pure helpers (exported for tests) ----------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function shortAddress(value: string): string {
  if (!value) return '';
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

export function formatRelative(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso || '';
  const deltaMs = now - parsed;
  if (deltaMs < 0) return 'in the future';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function sortInbound(items: NormalizedApproval[]): NormalizedApproval[] {
  return [...items].sort((left, right) => {
    const leftTerminal = TERMINAL_STATUSES.has(left.status) ? 1 : 0;
    const rightTerminal = TERMINAL_STATUSES.has(right.status) ? 1 : 0;
    if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
    return (right.createdAt ?? '').localeCompare(left.createdAt ?? '');
  });
}

function statusPillClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'ready' || normalized === 'pending') return 'pending';
  if (normalized === 'approved') return 'approved';
  if (TERMINAL_STATUSES.has(normalized)) return 'terminated';
  if (normalized === 'failed') return 'terminated';
  return 'neutral';
}

// ---------------- Renderers (exported for tests) ----------------

export function rowHtml(item: NormalizedApproval): string {
  const agent = item.metadata?.ap2VerifiedAgent;
  const agentLabel = escapeHtml((agent?.agentLabel?.trim() || agent?.agentId?.trim() || 'unknown agent'));
  const amountText =
    item.amount && item.token
      ? `${escapeHtml(item.amount)} ${escapeHtml(item.token)}`
      : item.amount
        ? escapeHtml(item.amount)
        : '—';
  const recipientHtml = item.recipient
    ? `<span class="external-agents-row-recipient">to ${escapeHtml(shortAddress(item.recipient))}</span>`
    : '';
  const clusterHtml = item.cluster
    ? `<span class="external-agents-row-cluster">${escapeHtml(item.cluster)}</span>`
    : '';
  const terminal = TERMINAL_STATUSES.has(item.status);
  const buttonLabel = terminal ? 'Open in Inbox' : 'Open approval';
  return `
    <li class="external-agents-row${terminal ? ' terminal' : ''}" data-inbound-id="${escapeHtml(item.id)}">
      <div class="external-agents-row-main">
        <div class="external-agents-row-head">
          <strong class="external-agents-row-agent">${agentLabel}</strong>
          <span class="external-agents-row-status status-pill ${escapeHtml(statusPillClass(item.status))}">${escapeHtml(item.status)}</span>
          <span class="external-agents-row-time" title="${escapeHtml(item.createdAt)}">${escapeHtml(formatRelative(item.createdAt))}</span>
        </div>
        <p class="external-agents-row-summary">${escapeHtml(item.summary)}</p>
        <div class="external-agents-row-meta">
          <span class="external-agents-row-amount">${amountText}</span>
          ${recipientHtml}
          <span class="external-agents-row-kind">${escapeHtml(item.kind.replace(/_/g, ' '))}</span>
          ${clusterHtml}
        </div>
      </div>
      <div class="external-agents-row-actions">
        <button type="button" class="primary" data-tab="inbox" data-external-agents-open="${escapeHtml(item.id)}">${buttonLabel}</button>
      </div>
    </li>
  `;
}

export function bodyHtml(snapshot: TabState = state): string {
  switch (snapshot.status) {
    case 'idle':
    case 'loading':
      return `<p class="external-agents-loading">Loading inbound mandates…</p>`;
    case 'error':
      return `
        <div class="external-agents-error">
          <p>Could not load inbound AP2 mandates: ${escapeHtml(snapshot.errorMessage || 'unknown error')}</p>
          <button type="button" class="utility" data-external-agents-retry>Retry</button>
        </div>
      `;
    case 'loaded':
      if (snapshot.inbound.length === 0) {
        return `<p class="external-agents-empty">No inbound AP2 mandates yet. When an external agent sends one, it will appear here as an approval card in <strong>Needs Approval</strong>.</p>`;
      }
      return `<ol class="external-agents-list">${sortInbound(snapshot.inbound).map(rowHtml).join('')}</ol>`;
  }
}

// ---------------- DOM patcher ----------------

function patchPanel(): void {
  if (typeof document === 'undefined') return;
  const body = document.getElementById('external-agents-body');
  if (body) {
    body.setAttribute('aria-busy', String(state.status === 'loading'));
    body.innerHTML = bodyHtml();
  }
  const refresh = document.querySelector<HTMLButtonElement>('[data-external-agents-refresh]');
  if (refresh) {
    refresh.disabled = state.status === 'loading';
    refresh.textContent = state.status === 'loading' ? 'Refreshing…' : 'Refresh';
  }
}

// ---------------- Async fetch ----------------

export async function fetchInbound(force = false): Promise<void> {
  // Synchronous re-entrancy guard: mutate state before any await so the
  // second call in the same tick sees `loading` and returns early.
  if (state.status === 'loading' && !force) return;
  const initialAddr = currentAddress();
  if (initialAddr && !isDevWallet(initialAddr)) return;
  state.status = 'loading';
  state.errorMessage = '';
  patchPanel();
  await refreshConnection();
  const addr = currentAddress();
  if (!addr || !isDevWallet(addr)) {
    // Connection went away while we were resolving the session — clear the
    // loading state so the panel doesn't get stuck.
    state.status = 'idle';
    state.lastFetchedFor = null;
    patchPanel();
    return;
  }
  state.lastFetchedFor = addr;
  patchPanel();
  try {
    const res = await fetch('/api/ap2/inbound', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) {
      state.inbound = [];
      state.status = 'loaded';
    } else if (res.status === 403) {
      state.errorMessage = 'AP2 inbound is disabled for this wallet on this deploy.';
      state.status = 'error';
    } else if (res.status === 401) {
      state.errorMessage = 'Sign into Agentic Cloud to view AP2 mandates.';
      state.status = 'error';
    } else if (!res.ok) {
      state.errorMessage = `HTTP ${res.status}`;
      state.status = 'error';
    } else {
      const payload = (await res.json().catch(() => null)) as
        | { inbound?: NormalizedApproval[] }
        | null;
      state.inbound = Array.isArray(payload?.inbound) ? (payload!.inbound as NormalizedApproval[]) : [];
      state.status = 'loaded';
    }
  } catch (err) {
    state.errorMessage = err instanceof Error ? err.message : 'Network error';
    state.status = 'error';
  }
  patchPanel();
}

// ---------------- Tab guard + render ----------------

function guard(): boolean {
  const addr = currentAddress();
  if (addr !== state.lastFetchedFor && state.status !== 'loading') {
    state.status = 'idle';
    state.inbound = [];
    state.errorMessage = '';
  }
  return isDevWallet(addr);
}

function render(): string {
  if (state.status === 'idle') {
    queueMicrotask(() => {
      void fetchInbound();
    });
  }
  const refreshing = state.status === 'loading';
  return `
    <details class="external-agents-panel rail-details" open data-layout="external-agents-panel">
      <summary>
        <div class="external-agents-summary-text">
          <strong>External Agents</strong>
          <span class="external-agents-sub">Inbound AP2 mandates</span>
        </div>
        <div class="external-agents-summary-actions">
          <button type="button" class="utility" data-external-agents-refresh${refreshing ? ' disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </summary>
      <section id="external-agents-body" class="external-agents-body" aria-label="Inbound AP2 mandates" aria-busy="${refreshing}">
        ${bodyHtml()}
      </section>
    </details>
  `;
}

// ---------------- Deep-link scroll + click delegation ----------------

function scrollToInboxApproval(approvalId: string): void {
  if (!approvalId || typeof document === 'undefined') return;
  // Two RAFs let main.ts's data-tab="inbox" handler finish its re-render
  // first, then we scroll the now-mounted approval card into view.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const selector = `[data-action-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(approvalId) : approvalId.replace(/"/g, '\\"')}"]`;
      const anchor = document.querySelector(selector);
      const article = anchor?.closest('article');
      if (article instanceof HTMLElement) {
        article.scrollIntoView({ behavior: 'smooth', block: 'center' });
        article.classList.add('external-agents-flash');
        window.setTimeout(() => article.classList.remove('external-agents-flash'), 1600);
      }
    }),
  );
}

function installPanelClickHandler(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const refreshBtn = target.closest<HTMLButtonElement>('[data-external-agents-refresh]');
    if (refreshBtn) {
      event.preventDefault();
      state.status = 'idle';
      void fetchInbound(true);
      return;
    }
    const retryBtn = target.closest<HTMLButtonElement>('[data-external-agents-retry]');
    if (retryBtn) {
      event.preventDefault();
      state.status = 'idle';
      void fetchInbound(true);
      return;
    }
    const openBtn = target.closest<HTMLElement>('[data-external-agents-open]');
    if (openBtn) {
      const approvalId = openBtn.getAttribute('data-external-agents-open') ?? '';
      // data-tab="inbox" on the same button lets main.ts switch the active
      // tab; we just queue the scroll for after its re-render.
      scrollToInboxApproval(approvalId);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.status === 'error' || (state.status === 'loaded' && state.inbound.length === 0)) {
      state.status = 'idle';
    }
  });
}

installPanelClickHandler();

registerDevTab({
  id: 'external-agents',
  label: 'External Agents',
  mobileLabel: 'Agents',
  guard,
  render,
});

// ---------------- Test-only surface ----------------

export const __externalAgentsForTests = {
  getState: (): Readonly<TabState> => state,
  resetState(next?: Partial<TabState>): void {
    state.status = next?.status ?? 'idle';
    state.inbound = next?.inbound ?? [];
    state.errorMessage = next?.errorMessage ?? '';
    state.lastFetchedFor = next?.lastFetchedFor ?? null;
  },
  statusPillClass,
  bodyHtml,
  rowHtml,
  sortInbound,
  fetchInbound,
};
