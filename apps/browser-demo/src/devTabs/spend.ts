import './spend.css';

import {
  envelopeId,
  envelopeNextEvent,
  envelopeProtocolBadge,
  envelopeRemaining,
  envelopeStatus,
  type SpendEnvelope,
  type SpendEnvelopeStatus,
} from '@solana-agent-wallet-adapter/workflow';

import { currentAddress, refreshConnection } from '../connectionState.js';
import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';

type SpendFilter = 'all' | 'needs_approval' | 'active_schedules' | 'live_streams' | 'settled';
type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

interface SpendState {
  status: LoadState;
  envelopes: SpendEnvelope[];
  filter: SpendFilter;
  errorMessage: string;
  lastFetchedFor: string | null;
}

const FILTERS: readonly SpendFilter[] = ['all', 'needs_approval', 'active_schedules', 'live_streams', 'settled'];
const FILTER_LABELS: Record<SpendFilter, string> = {
  all: 'All',
  needs_approval: 'Needs Approval',
  active_schedules: 'Active Schedules',
  live_streams: 'Live Streams',
  settled: 'Settled',
};

const state: SpendState = {
  status: 'idle',
  envelopes: [],
  filter: 'all',
  errorMessage: '',
  lastFetchedFor: null,
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function matchesFilter(envelope: SpendEnvelope, filter: SpendFilter): boolean {
  if (filter === 'all') return true;
  const status = envelopeStatus(envelope);
  switch (filter) {
    case 'needs_approval':
      return status === 'needs_approval';
    case 'active_schedules':
      return envelope.kind === 'recurring' && status === 'active';
    case 'live_streams':
      return envelope.kind === 'streaming' && (status === 'active' || status === 'needs_approval');
    case 'settled':
      return isTerminalStatus(status);
  }
}

function isTerminalStatus(status: SpendEnvelopeStatus): boolean {
  return status === 'settled' || status === 'expired' || status === 'cancelled' || status === 'failed';
}

function filteredEnvelopes(snapshot: SpendState = state): SpendEnvelope[] {
  return snapshot.envelopes.filter((envelope) => matchesFilter(envelope, snapshot.filter));
}

function filterCount(filter: SpendFilter): number {
  return state.envelopes.filter((envelope) => matchesFilter(envelope, filter)).length;
}

function filterButton(filter: SpendFilter): string {
  const active = state.filter === filter;
  return `
    <button
      type="button"
      class="spend-filter-chip ${active ? 'active' : ''}"
      data-spend-filter="${escapeHtml(filter)}"
    >
      <span>${escapeHtml(FILTER_LABELS[filter])}</span>
      <strong>${filterCount(filter)}</strong>
    </button>
  `;
}

function envelopeSummary(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return envelope.action.summary || titleCase(envelope.action.kind);
    case 'recurring': {
      const schedule = envelope.schedule;
      const token = schedule.outputToken ?? schedule.token;
      const cadence = titleCase(schedule.cadence);
      const recipient = schedule.recipient ? ` to ${shortAddress(schedule.recipient)}` : '';
      return `${schedule.amount} ${token} ${cadence}${recipient}`;
    }
    case 'streaming': {
      const token = typeof envelope.session.metadata?.tokenSymbol === 'string'
        ? envelope.session.metadata.tokenSymbol
        : 'USDC';
      return `${envelope.session.spentAmount} of ${envelope.session.capAmount} ${token} streamed`;
    }
  }
}

function envelopePrimaryAction(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return `<button type="button" class="primary" data-tab="inbox" data-spend-open="${escapeHtml(envelope.action.id)}">Review</button>`;
    case 'recurring':
      return `<button type="button" class="utility" data-tab="schedule" data-recurring-view="active" data-spend-open="${escapeHtml(envelope.schedule.id)}">Manage</button>`;
    case 'streaming':
      return `<button type="button" class="utility" data-tab="sessions" data-spend-open="${escapeHtml(envelope.session.id)}">Manage</button>`;
  }
}

export function spendRowHtml(envelope: SpendEnvelope): string {
  const protocol = envelopeProtocolBadge(envelope);
  const status = envelopeStatus(envelope);
  const remaining = envelopeRemaining(envelope);
  const nextEvent = envelopeNextEvent(envelope);
  return `
    <li class="spend-row spend-row--${escapeHtml(envelope.kind)}" data-spend-envelope="${escapeHtml(envelope.kind)}:${escapeHtml(envelopeId(envelope))}">
      <div class="spend-row-main">
        <div class="spend-badge-stack">
          <span class="spend-badge spend-badge--protocol spend-badge--${escapeHtml(protocol.id)}">${escapeHtml(protocol.label)}</span>
          <span class="spend-badge spend-badge--kind">${escapeHtml(titleCase(envelope.kind))}</span>
        </div>
        <strong>${escapeHtml(envelopeSummary(envelope))}</strong>
        <span class="spend-row-meta">
          <span>${escapeHtml(remaining.label)}</span>
          <span>${escapeHtml(nextEvent.label)}${nextEvent.at ? ` ${escapeHtml(formatTime(nextEvent.at))}` : ''}</span>
        </span>
      </div>
      <div class="spend-row-side">
        <span class="spend-status spend-status--${escapeHtml(status)}">${escapeHtml(titleCase(status))}</span>
        ${envelopePrimaryAction(envelope)}
      </div>
    </li>
  `;
}

export function spendBodyHtml(snapshot: SpendState = state): string {
  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    return '<p class="dev-tab-loading-state spend-list-state">Loading spend envelopes...</p>';
  }
  if (snapshot.status === 'error') {
    return `
      <div class="spend-error">
        <p>${escapeHtml(snapshot.errorMessage || 'Could not load spend envelopes.')}</p>
        <button type="button" class="utility" data-spend-refresh>Retry</button>
      </div>
    `;
  }
  const rows = filteredEnvelopes(snapshot);
  if (rows.length === 0) {
    return `
      <div class="dev-tab-empty-state spend-list-state">
        <p>No ${escapeHtml(FILTER_LABELS[snapshot.filter].toLowerCase())} spend envelopes.</p>
      </div>
    `;
  }
  return `<ol class="spend-list">${rows.map(spendRowHtml).join('')}</ol>`;
}

export function renderSpendPanel(): string {
  if (state.status === 'idle') {
    queueMicrotask(() => {
      void loadSpendEnvelopes();
    });
  }
  const activeCount = state.envelopes.filter((envelope) => !isTerminalStatus(envelopeStatus(envelope))).length;
  const needsApprovalCount = filterCount('needs_approval');
  const liveStreamCount = filterCount('live_streams');
  return `
    <section class="spend-shell dev-tab-shell" data-spend-root>
      <header class="spend-header dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-tab-kicker">Spend envelopes</p>
          <div class="dev-tab-title-row">
            <h2>Spend</h2>
            <span class="spend-live-pill">${state.status === 'loading' ? 'Syncing' : 'Live'}</span>
          </div>
        </div>
        <div class="dev-tab-header-actions">
          <button type="button" class="utility" data-spend-refresh ${state.status === 'loading' ? 'disabled' : ''}>Refresh</button>
        </div>
      </header>
      <div class="spend-overview" aria-label="Spend summary">
        <div class="dev-tab-stat"><span>Active</span><strong>${activeCount}</strong></div>
        <div class="dev-tab-stat"><span>Needs Approval</span><strong>${needsApprovalCount}</strong></div>
        <div class="dev-tab-stat"><span>Live Streams</span><strong>${liveStreamCount}</strong></div>
      </div>
      <div class="spend-filter-row" role="tablist" aria-label="Spend envelope filters">
        ${FILTERS.map(filterButton).join('')}
      </div>
      <section class="spend-list-panel dev-tab-panel" aria-label="Spend envelopes" aria-busy="${state.status === 'loading'}">
        ${spendBodyHtml()}
      </section>
    </section>
  `;
}

export async function loadSpendEnvelopes(force = false): Promise<void> {
  if (state.status === 'loading' && !force) return;
  const initialAddr = currentAddress();
  if (initialAddr && !isDevWallet(initialAddr)) return;
  state.status = 'loading';
  state.errorMessage = '';
  patchSpendRoot();
  await refreshConnection();
  const addr = currentAddress();
  if (!addr || !isDevWallet(addr)) {
    state.status = 'idle';
    state.lastFetchedFor = null;
    patchSpendRoot();
    return;
  }
  state.lastFetchedFor = addr;
  try {
    const res = await fetch('/api/spend/envelopes?limit=100', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = (await res.json()) as { envelopes?: SpendEnvelope[]; items?: SpendEnvelope[] };
    state.envelopes = Array.isArray(payload.envelopes)
      ? payload.envelopes
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    state.status = 'loaded';
  } catch (err) {
    state.errorMessage = err instanceof Error ? err.message : 'Network error';
    state.status = 'error';
  }
  patchSpendRoot();
}

function patchSpendRoot(): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector('[data-spend-root]');
  if (!root || !root.parentNode) return;
  const template = document.createElement('template');
  template.innerHTML = renderSpendPanel().trim();
  const next = template.content.firstElementChild;
  if (next) root.replaceWith(next);
}

function installSpendHandlers(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const filter = target.closest<HTMLButtonElement>('[data-spend-filter]');
    if (filter?.dataset.spendFilter && FILTERS.includes(filter.dataset.spendFilter as SpendFilter)) {
      event.preventDefault();
      state.filter = filter.dataset.spendFilter as SpendFilter;
      patchSpendRoot();
      return;
    }
    if (target.closest('[data-spend-refresh]')) {
      event.preventDefault();
      void loadSpendEnvelopes(true);
    }
  });
}

installSpendHandlers();

registerDevTab({
  id: 'spend',
  label: 'Spend',
  mobileLabel: 'Spend',
  guard: () => isDevWallet(currentAddress()),
  render: renderSpendPanel,
});

export const __spendForTests = {
  getState: (): Readonly<SpendState> => state,
  resetState(next?: Partial<SpendState>): void {
    state.status = next?.status ?? 'idle';
    state.envelopes = next?.envelopes ?? [];
    state.filter = next?.filter ?? 'all';
    state.errorMessage = next?.errorMessage ?? '';
    state.lastFetchedFor = next?.lastFetchedFor ?? null;
  },
  matchesFilter,
  renderSpendPanel,
  spendBodyHtml,
  spendRowHtml,
};
