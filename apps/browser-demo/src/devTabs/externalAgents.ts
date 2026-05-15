import { registerDevTab } from '../devTabRegistry.js';
import { isDevWallet } from '../devGate.js';
import './externalAgents.css';

// Main.ts does not call onMount; only render() is invoked by activePanel().
// This module triggers its first fetch from render() via queueMicrotask, then
// patches the panel body in place when the network resolves.

type CacheState = 'idle' | 'loading' | 'loaded' | 'error';

interface InboundMandate {
  inboundId: string;
  approvalId: string;
  mandateSource: { agentId: string; agentLabel: string };
  amount: number | string;
  tokenMint: string;
  memo?: string;
  createdAt: string;
  approvalStatus: string;
}

let cacheState: CacheState = 'idle';
let mandates: InboundMandate[] = [];
let errorMessage = '';
let lastFetchedFor: string | null = null;

function currentDevWallet(): string | null {
  return document.body.dataset.walletAddress || null;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeText(value);
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const deltaMs = Date.now() - t;
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function guard(): boolean {
  const addr = currentDevWallet();
  if (addr !== lastFetchedFor && cacheState !== 'loading') {
    cacheState = 'idle';
    mandates = [];
    errorMessage = '';
  }
  return isDevWallet(addr);
}

function rowHtml(m: InboundMandate): string {
  const sourceAgent = m.mandateSource ?? { agentId: '', agentLabel: '' };
  const agentLabel = escapeText(sourceAgent.agentLabel || sourceAgent.agentId || 'unknown agent');
  const tokenShort = escapeText(short(m.tokenMint ?? ''));
  const memo = m.memo
    ? `<span class="external-agents-row-memo">${escapeText(m.memo)}</span>`
    : '';
  return `
    <li class="external-agents-row" data-inbound-id="${escapeAttr(m.inboundId ?? '')}">
      <div class="external-agents-row-main">
        <div class="external-agents-row-head">
          <strong class="external-agents-row-agent">${agentLabel}</strong>
          <span class="external-agents-row-time" title="${escapeAttr(m.createdAt ?? '')}">${escapeText(formatRelative(m.createdAt ?? ''))}</span>
        </div>
        <div class="external-agents-row-meta">
          <span class="external-agents-row-amount">${escapeText(String(m.amount ?? ''))} ${tokenShort}</span>
          ${memo}
        </div>
        <div class="external-agents-row-status">Status: ${escapeText(m.approvalStatus ?? 'unknown')}</div>
      </div>
      <div class="external-agents-row-actions">
        <button type="button" class="primary" data-tab="inbox" data-external-agents-approve="${escapeAttr(m.approvalId ?? '')}">Open approval</button>
      </div>
    </li>
  `;
}

function bodyHtml(): string {
  switch (cacheState) {
    case 'idle':
    case 'loading':
      return `<p class="external-agents-loading">Loading inbound mandates…</p>`;
    case 'error':
      return `
        <div class="external-agents-error">
          <p>Could not load inbound AP2 mandates: ${escapeText(errorMessage || 'unknown error')}</p>
          <button type="button" class="utility" data-external-agents-retry>Retry</button>
        </div>
      `;
    case 'loaded':
      if (mandates.length === 0) {
        return `<p class="external-agents-empty">No inbound AP2 mandates yet. When an external agent sends one, it will appear here as an approval card in <strong>Needs Approval</strong>.</p>`;
      }
      return `<ol class="external-agents-list">${mandates.map(rowHtml).join('')}</ol>`;
  }
}

function patchPanel(): void {
  const el = document.getElementById('external-agents-body');
  if (!el) return;
  el.innerHTML = bodyHtml();
  const retry = el.querySelector<HTMLButtonElement>('[data-external-agents-retry]');
  if (retry) {
    retry.addEventListener(
      'click',
      () => {
        cacheState = 'idle';
        void fetchInbound();
      },
      { once: true },
    );
  }
}

async function fetchInbound(): Promise<void> {
  const addr = currentDevWallet();
  if (!addr || !isDevWallet(addr)) return;
  if (cacheState === 'loading') return;
  cacheState = 'loading';
  errorMessage = '';
  lastFetchedFor = addr;
  patchPanel();
  try {
    const res = await fetch('/api/ap2/inbound', { credentials: 'include' });
    if (res.status === 404) {
      mandates = [];
      cacheState = 'loaded';
    } else if (res.status === 403) {
      errorMessage = 'AP2 inbound is disabled for this wallet on this deploy.';
      cacheState = 'error';
    } else if (!res.ok) {
      errorMessage = `HTTP ${res.status}`;
      cacheState = 'error';
    } else {
      const payload = (await res.json().catch(() => null)) as
        | { items?: InboundMandate[] }
        | null;
      mandates = Array.isArray(payload?.items) ? payload!.items! : [];
      cacheState = 'loaded';
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Network error';
    cacheState = 'error';
  }
  patchPanel();
}

function render(): string {
  if (cacheState === 'idle') {
    queueMicrotask(() => {
      void fetchInbound();
    });
  }
  return `
    <details class="external-agents-panel rail-details" open data-layout="external-agents-panel">
      <summary>
        <strong>External Agents</strong>
        <span class="external-agents-sub">Inbound AP2 mandates</span>
      </summary>
      <section id="external-agents-body" class="external-agents-body" aria-label="Inbound AP2 mandates">
        ${bodyHtml()}
      </section>
    </details>
  `;
}

registerDevTab({
  id: 'external-agents',
  label: 'External Agents',
  mobileLabel: 'Agents',
  guard,
  render,
});
