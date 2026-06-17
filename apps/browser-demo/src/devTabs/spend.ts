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
import { t, tf } from '../demo-i18n/uiLang.js';
import { isDevWallet } from '../devGate.js';
import { registerDevTab } from '../devTabRegistry.js';

type SpendFilter = 'all' | 'needs_approval' | 'active_schedules' | 'live_streams' | 'settled';
type LoadState = 'idle' | 'loading' | 'loaded' | 'error';
type SpendCounts = Record<SpendFilter, number>;

interface SpendState {
  status: LoadState;
  envelopes: SpendEnvelope[];
  filter: SpendFilter;
  counts: SpendCounts | null;
  errorMessage: string;
  lastFetchedFor: string | null;
  loadedFilter: SpendFilter | null;
  nextCursor: string | null;
  selectedEnvelopeKey: string | null;
  loadingMore: boolean;
}

interface SpendEnvelopeResponse {
  envelopes?: SpendEnvelope[];
  items?: SpendEnvelope[];
  counts?: Partial<SpendCounts>;
  pagination?: {
    nextCursor?: string;
  };
  nextCursor?: string;
}

const FILTERS: readonly SpendFilter[] = ['all', 'needs_approval', 'active_schedules', 'live_streams', 'settled'];
const PAGE_LIMIT = 50;

const state: SpendState = {
  status: 'idle',
  envelopes: [],
  filter: 'all',
  counts: null,
  errorMessage: '',
  lastFetchedFor: null,
  loadedFilter: null,
  nextCursor: null,
  selectedEnvelopeKey: null,
  loadingMore: false,
};

function filterLabel(filter: SpendFilter): string {
  switch (filter) {
    case 'all':
      return t('All');
    case 'needs_approval':
      return t('Needs Approval');
    case 'active_schedules':
      return t('Active Schedules');
    case 'live_streams':
      return t('Live Streams');
    case 'settled':
      return t('Settled');
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

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function tokenLabelFromMint(mint: string): string {
  if (mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC';
  return shortAddress(mint);
}

function streamingTokenLabel(envelope: Extract<SpendEnvelope, { kind: 'streaming' }>): string {
  return typeof envelope.session.metadata?.tokenSymbol === 'string' && envelope.session.metadata.tokenSymbol.trim()
    ? envelope.session.metadata.tokenSymbol.trim()
    : tokenLabelFromMint(envelope.session.tokenMint);
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

function envelopeKey(envelope: SpendEnvelope): string {
  return `${envelope.kind}:${envelopeId(envelope)}`;
}

function parseEnvelopeKey(key: string): { kind: SpendEnvelope['kind']; id: string } | null {
  const separator = key.indexOf(':');
  if (separator < 1) return null;
  const kind = key.slice(0, separator) as SpendEnvelope['kind'];
  const id = key.slice(separator + 1);
  if ((kind === 'one-time' || kind === 'recurring' || kind === 'streaming') && id) return { kind, id };
  return null;
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
  if (state.counts) return state.counts[filter] ?? 0;
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
      <span>${escapeHtml(filterLabel(filter))}</span>
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
      const recipient = schedule.recipient ? tf(' to {recipient}', { recipient: shortAddress(schedule.recipient) }) : '';
      const displayAmount = scheduleDisplayAmount(schedule);
      return `${displayAmount} ${token} ${cadence}${recipient}`;
    }
    case 'streaming': {
      const token = streamingTokenLabel(envelope);
      return tf('{spent} of {cap} {token} streamed', { spent: envelope.session.spentAmount, cap: envelope.session.capAmount, token });
    }
  }
}

/**
 * For skill-monetization schedules with a platform split, `schedule.amount`
 * stores the author portion only; the user actually pays `metadata.totalAmount`.
 * Always render the user-facing total in user-visible UI.
 */
function scheduleDisplayAmount(schedule: { amount: string; metadata?: unknown }): string {
  const metadata = schedule.metadata as Record<string, unknown> | undefined | null;
  const total = metadata?.totalAmount;
  if (typeof total === 'string' && /^\d+(\.\d+)?$/.test(total)) return total;
  return schedule.amount;
}

function envelopePrimaryAction(envelope: SpendEnvelope): string {
  const key = envelopeKey(envelope);
  const selected = state.selectedEnvelopeKey === key;
  const label = selected
    ? t('Hide')
    : envelope.kind === 'one-time'
      ? t('Review')
      : envelope.kind === 'recurring'
        ? t('Manage')
        : t('Inspect');
  return `<button type="button" class="${envelope.kind === 'one-time' ? 'primary' : 'utility'}" data-spend-select="${escapeHtml(key)}">${label}</button>`;
}

function legacyEnvelopeAction(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return `<button type="button" class="utility" data-spend-legacy-tab="inbox" data-spend-open="${escapeHtml(envelope.action.id)}">${t('Open in Needs Approval')}</button>`;
    case 'recurring':
      return `<button type="button" class="utility" data-spend-legacy-tab="schedule" data-recurring-view="active" data-spend-open="${escapeHtml(envelope.schedule.id)}">${t('Open in Repeat Payments')}</button>`;
    case 'streaming':
      return `<button type="button" class="utility" data-spend-legacy-tab="sessions" data-spend-open="${escapeHtml(envelope.session.id)}">${t('Open in Sessions')}</button>`;
  }
}

function detailRow(label: string, value: string | undefined, title = value): string {
  if (!value) return '';
  return `
    <div class="spend-detail-row" ${title ? `title="${escapeHtml(title)}"` : ''}>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `;
}

function envelopeDetailHtml(envelope: SpendEnvelope): string {
  const remaining = envelopeRemaining(envelope);
  const nextEvent = envelopeNextEvent(envelope);
  const status = envelopeStatus(envelope);
  const rows = [
    detailRow(t('Status'), titleCase(status)),
    detailRow(t('Remaining'), remaining.label),
    detailRow(nextEvent.label, nextEvent.at ? formatTime(nextEvent.at) : undefined, nextEvent.at),
    ...kindDetailRows(envelope),
  ].join('');
  return `
    <section class="spend-row-detail" aria-label="${escapeHtml(t('Spend envelope detail'))}">
      <dl class="spend-detail-grid">${rows}</dl>
      <div class="spend-detail-actions">
        ${spendInlineActions(envelope)}
        ${legacyEnvelopeAction(envelope)}
      </div>
    </section>
  `;
}

function kindDetailRows(envelope: SpendEnvelope): string[] {
  switch (envelope.kind) {
    case 'one-time':
      return [
        detailRow(t('Request ID'), shortAddress(envelope.action.id), envelope.action.id),
        detailRow(t('Kind'), titleCase(envelope.action.kind)),
        detailRow(t('Recipient'), envelope.action.recipient ? shortAddress(envelope.action.recipient) : undefined, envelope.action.recipient),
      ];
    case 'recurring':
      return [
        detailRow(t('Schedule ID'), shortAddress(envelope.schedule.id), envelope.schedule.id),
        detailRow(t('Cadence'), titleCase(envelope.schedule.cadence)),
        detailRow(t('Recipient'), envelope.schedule.recipient ? shortAddress(envelope.schedule.recipient) : undefined, envelope.schedule.recipient),
      ];
    case 'streaming':
      return [
        detailRow(t('Session ID'), shortAddress(envelope.session.id), envelope.session.id),
        detailRow(t('Mint'), tokenLabelFromMint(envelope.session.tokenMint), envelope.session.tokenMint),
        detailRow(t('Delegate'), shortAddress(envelope.session.delegatePubkey), envelope.session.delegatePubkey),
      ];
  }
}

function spendInlineActions(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return approvalInlineActions(envelope.action);
    case 'recurring':
      return recurringInlineActions(envelope.schedule);
    case 'streaming':
      return `<span class="spend-detail-note">${t('Streaming revoke and voucher inspection stay in Sessions for this release.')}</span>`;
  }
}

function approvalInlineActions(action: Extract<SpendEnvelope, { kind: 'one-time' }>['action']): string {
  if (action.status === 'approval_pending') {
    return `<button type="button" class="primary" data-spend-approval-op="confirm" data-spend-action-id="${escapeHtml(action.id)}">${t('Check confirmation')}</button>`;
  }
  if (envelopeStatus({ kind: 'one-time', action }) !== 'needs_approval') {
    return `<span class="spend-detail-note">${t('No approval action is pending.')}</span>`;
  }
  return `
    <button type="button" class="primary" data-spend-approval-op="execute" data-spend-action-id="${escapeHtml(action.id)}">${t('Approve')}</button>
    <button type="button" class="utility danger" data-spend-approval-op="reject" data-spend-action-id="${escapeHtml(action.id)}">${t('Deny')}</button>
  `;
}

function recurringInlineActions(schedule: Extract<SpendEnvelope, { kind: 'recurring' }>['schedule']): string {
  if (schedule.status === 'active') {
    return `<button type="button" class="utility" data-spend-recurring-op="pause" data-spend-schedule-id="${escapeHtml(schedule.id)}">${t('Pause')}</button>`;
  }
  if (schedule.status === 'paused') {
    return `<button type="button" class="primary" data-spend-recurring-op="resume" data-spend-schedule-id="${escapeHtml(schedule.id)}">${t('Resume')}</button>`;
  }
  return `<span class="spend-detail-note">${t('This schedule is settled.')}</span>`;
}

export function spendRowHtml(envelope: SpendEnvelope): string {
  const protocol = envelopeProtocolBadge(envelope);
  const status = envelopeStatus(envelope);
  const remaining = envelopeRemaining(envelope);
  const nextEvent = envelopeNextEvent(envelope);
  const key = envelopeKey(envelope);
  const selected = state.selectedEnvelopeKey === key;
  return `
    <li class="spend-row spend-row--${escapeHtml(envelope.kind)} ${selected ? 'selected' : ''}" data-spend-envelope="${escapeHtml(key)}">
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
      ${selected ? envelopeDetailHtml(envelope) : ''}
    </li>
  `;
}

export function spendBodyHtml(snapshot: SpendState = state): string {
  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    return `<p class="dev-tab-loading-state spend-list-state">${t('Loading spend envelopes...')}</p>`;
  }
  if (snapshot.status === 'error') {
    return `
      <div class="spend-error">
        <p>${escapeHtml(snapshot.errorMessage || t('Could not load spend envelopes.'))}</p>
        <button type="button" class="utility" data-spend-refresh>${t('Retry')}</button>
      </div>
    `;
  }
  const rows = filteredEnvelopes(snapshot);
  if (rows.length === 0) {
    return `
      <div class="dev-tab-empty-state spend-list-state">
        <p>${escapeHtml(tf('No {filter} spend envelopes.', { filter: filterLabel(snapshot.filter).toLowerCase() }))}</p>
      </div>
    `;
  }
  return `
    <ol class="spend-list">${rows.map(spendRowHtml).join('')}</ol>
    ${snapshot.nextCursor ? `
      <div class="spend-load-more-row">
        <button type="button" class="utility" data-spend-load-more ${snapshot.loadingMore ? 'disabled' : ''}>
          ${snapshot.loadingMore ? t('Loading...') : t('Load more')}
        </button>
      </div>
    ` : ''}
  `;
}

export function renderSpendPanel(): string {
  const addr = currentAddress();
  const walletChanged = Boolean(addr && isDevWallet(addr) && state.lastFetchedFor && state.lastFetchedFor !== addr);
  const filterChanged = Boolean(state.loadedFilter && state.loadedFilter !== state.filter);
  if (state.status === 'idle' || (state.status !== 'loading' && (walletChanged || filterChanged))) {
    queueMicrotask(() => {
      void loadSpendEnvelopes(true);
    });
  }
  const activeCount = state.counts
    ? Math.max(0, state.counts.all - state.counts.settled)
    : state.envelopes.filter((envelope) => !isTerminalStatus(envelopeStatus(envelope))).length;
  const needsApprovalCount = filterCount('needs_approval');
  const liveStreamCount = filterCount('live_streams');
  return `
    <section class="spend-shell dev-tab-shell" data-spend-root>
      <header class="spend-header dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-tab-kicker">${t('Spend envelopes')}</p>
          <div class="dev-tab-title-row">
            <h2>${t('Spend')}</h2>
            <span class="spend-live-pill">${state.status === 'loading' ? t('Syncing') : t('Live')}</span>
          </div>
        </div>
        <div class="dev-tab-header-actions">
          <button type="button" class="utility" data-spend-refresh ${state.status === 'loading' ? 'disabled' : ''}>${t('Refresh')}</button>
        </div>
      </header>
      <div class="spend-overview" aria-label="${escapeHtml(t('Spend summary'))}">
        <div class="dev-tab-stat"><span>${t('Active')}</span><strong>${activeCount}</strong></div>
        <div class="dev-tab-stat"><span>${t('Needs Approval')}</span><strong>${needsApprovalCount}</strong></div>
        <div class="dev-tab-stat"><span>${t('Live Streams')}</span><strong>${liveStreamCount}</strong></div>
      </div>
      <div class="spend-filter-row" role="tablist" aria-label="${escapeHtml(t('Spend envelope filters'))}">
        ${FILTERS.map(filterButton).join('')}
      </div>
      <section class="spend-list-panel dev-tab-panel" aria-label="${escapeHtml(t('Spend envelopes'))}" aria-busy="${state.status === 'loading'}">
        ${spendBodyHtml()}
      </section>
    </section>
  `;
}

export async function loadSpendEnvelopes(force = false, append = false): Promise<void> {
  if (append && !state.nextCursor) return;
  if (state.status === 'loading' && !force) return;
  if (state.loadingMore && !force) return;
  const initialAddr = currentAddress();
  if (initialAddr && !isDevWallet(initialAddr)) return;
  const requestedFilter = state.filter;
  const requestedCursor = append ? state.nextCursor : null;
  if (append) {
    state.loadingMore = true;
  } else {
    state.status = 'loading';
    state.nextCursor = null;
  }
  state.errorMessage = '';
  patchSpendRoot();
  await refreshConnection();
  const addr = currentAddress();
  if (!addr || !isDevWallet(addr)) {
    state.status = 'idle';
    state.envelopes = [];
    state.counts = null;
    state.lastFetchedFor = null;
    state.loadedFilter = null;
    state.nextCursor = null;
    state.loadingMore = false;
    patchSpendRoot();
    return;
  }
  state.lastFetchedFor = addr;
  try {
    const query = new URLSearchParams({
      filter: requestedFilter,
      limit: String(PAGE_LIMIT),
    });
    if (requestedCursor) query.set('cursor', requestedCursor);
    const res = await fetch(`/api/spend/envelopes?${query.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(tf('HTTP {status}', { status: res.status }));
    }
    const payload = (await res.json()) as SpendEnvelopeResponse;
    const page = responseEnvelopes(payload);
    if (state.filter !== requestedFilter || currentAddress() !== addr) {
      state.status = 'idle';
      state.loadingMore = false;
      patchSpendRoot();
      return;
    }
    state.envelopes = append ? mergeEnvelopePages(state.envelopes, page) : page;
    state.counts = normalizeCounts(payload.counts);
    state.loadedFilter = requestedFilter;
    state.nextCursor = payload.pagination?.nextCursor ?? payload.nextCursor ?? null;
    state.status = 'loaded';
  } catch (err) {
    state.errorMessage = err instanceof Error ? err.message : t('Network error');
    state.status = append && state.envelopes.length ? 'loaded' : 'error';
  } finally {
    state.loadingMore = false;
  }
  patchSpendRoot();
}

function responseEnvelopes(payload: SpendEnvelopeResponse): SpendEnvelope[] {
  if (Array.isArray(payload.envelopes)) return payload.envelopes;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function mergeEnvelopePages(current: SpendEnvelope[], next: SpendEnvelope[]): SpendEnvelope[] {
  const byKey = new Map<string, SpendEnvelope>();
  for (const envelope of current) byKey.set(envelopeKey(envelope), envelope);
  for (const envelope of next) byKey.set(envelopeKey(envelope), envelope);
  return Array.from(byKey.values());
}

function normalizeCounts(counts: Partial<SpendCounts> | undefined): SpendCounts | null {
  if (!counts) return null;
  return {
    all: countOrZero(counts.all),
    needs_approval: countOrZero(counts.needs_approval),
    active_schedules: countOrZero(counts.active_schedules),
    live_streams: countOrZero(counts.live_streams),
    settled: countOrZero(counts.settled),
  };
}

function countOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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
      setSpendFilter(filter.dataset.spendFilter as SpendFilter);
      return;
    }
    const select = target.closest<HTMLButtonElement>('[data-spend-select]');
    if (select?.dataset.spendSelect && parseEnvelopeKey(select.dataset.spendSelect)) {
      event.preventDefault();
      const key = select.dataset.spendSelect;
      state.selectedEnvelopeKey = state.selectedEnvelopeKey === key ? null : key;
      patchSpendRoot();
      return;
    }
    if (target.closest('[data-spend-load-more]')) {
      event.preventDefault();
      void loadSpendEnvelopes(false, true);
      return;
    }
    const approval = target.closest<HTMLButtonElement>('[data-spend-approval-op]');
    if (approval?.dataset.spendApprovalOp && approval.dataset.spendActionId) {
      event.preventDefault();
      dispatchSpendEvent('spend:approval-op', {
        actionId: approval.dataset.spendActionId,
        op: approval.dataset.spendApprovalOp,
      });
      return;
    }
    const recurring = target.closest<HTMLButtonElement>('[data-spend-recurring-op]');
    if (recurring?.dataset.spendRecurringOp && recurring.dataset.spendScheduleId) {
      event.preventDefault();
      dispatchSpendEvent('spend:recurring-op', {
        scheduleId: recurring.dataset.spendScheduleId,
        op: recurring.dataset.spendRecurringOp,
      });
      return;
    }
    const legacy = target.closest<HTMLButtonElement>('[data-spend-legacy-tab]');
    if (legacy?.dataset.spendLegacyTab) {
      event.preventDefault();
      dispatchSpendEvent('spend:legacy-open', {
        tab: legacy.dataset.spendLegacyTab,
        open: legacy.dataset.spendOpen,
        recurringView: legacy.dataset.recurringView,
      });
      return;
    }
    if (target.closest('[data-spend-refresh]')) {
      event.preventDefault();
      void loadSpendEnvelopes(true);
    }
  });
}

function setSpendFilter(filter: SpendFilter, selectedEnvelopeKey: string | null = null): void {
  state.filter = filter;
  state.selectedEnvelopeKey = selectedEnvelopeKey;
  state.nextCursor = null;
  if (state.loadedFilter !== filter) {
    state.envelopes = [];
    state.loadedFilter = null;
  }
  patchSpendRoot();
  void loadSpendEnvelopes(true);
}

function dispatchSpendEvent(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

let spendWindowHandlersInstalled = false;

function installSpendWindowHandlers(): void {
  if (typeof window === 'undefined' || spendWindowHandlersInstalled) return;
  spendWindowHandlersInstalled = true;
  window.addEventListener('spend:set-filter', (event) => {
    const detail = spendEventDetail(event);
    const filter = detail?.filter;
    if (typeof filter !== 'string' || !FILTERS.includes(filter as SpendFilter)) return;
    const envelopeKey = typeof detail?.envelopeKey === 'string' && parseEnvelopeKey(detail.envelopeKey)
      ? detail.envelopeKey
      : null;
    setSpendFilter(filter as SpendFilter, envelopeKey);
  });
  window.addEventListener('spend:refresh', () => {
    void loadSpendEnvelopes(true);
  });
}

function spendEventDetail(event: Event): Record<string, unknown> | null {
  if (!('detail' in event) || typeof event.detail !== 'object' || event.detail === null) return null;
  return event.detail as Record<string, unknown>;
}

installSpendHandlers();
installSpendWindowHandlers();

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
    state.counts = next?.counts ?? null;
    state.errorMessage = next?.errorMessage ?? '';
    state.lastFetchedFor = next?.lastFetchedFor ?? null;
    state.loadedFilter = next?.loadedFilter ?? null;
    state.nextCursor = next?.nextCursor ?? null;
    state.selectedEnvelopeKey = next?.selectedEnvelopeKey ?? null;
    state.loadingMore = next?.loadingMore ?? false;
  },
  loadSpendEnvelopes,
  matchesFilter,
  renderSpendPanel,
  spendBodyHtml,
  spendRowHtml,
};
