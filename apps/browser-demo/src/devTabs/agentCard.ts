import './agentCard.css';
import { registerDevTab } from '../devTabRegistry.js';
import { isDevWallet } from '../devGate.js';
import { getConnectedAddress } from '../walletState.js';

const PUBLIC_AGENT_CARD_URL = 'https://agentic-signer.com/.well-known/agent.json';
const LOCAL_AGENT_CARD_PATH = '/api/agents/card';
const BODY_ELEMENT_ID = 'dev-agent-card-body';

type FetchStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error';

interface TabState {
  status: FetchStatus;
  cardJson?: unknown;
  errorMessage?: string;
  fetchedAt?: number;
}

const tabState: TabState = { status: 'idle' };
let kickoffScheduled = false;

export function shortAddress(address: string | undefined | null): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function formatProtocols(protocols: readonly string[] | undefined | null): string {
  if (!protocols || protocols.length === 0) return '—';
  return protocols.join(' · ');
}

function isEmptyCard(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}

function summaryHtml(card: Record<string, unknown> | null): string {
  if (!card) return '';
  const walletAddress = typeof card.walletAddress === 'string' ? card.walletAddress : '';
  const protocols = Array.isArray(card.supportedProtocols)
    ? (card.supportedProtocols as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  const version = typeof card.version === 'string' ? card.version : '';
  const parts: string[] = [];
  if (walletAddress) {
    parts.push(`<span class="dev-agent-card-summary-item">Wallet <code>${escapeHtml(shortAddress(walletAddress))}</code></span>`);
  }
  if (protocols.length > 0) {
    const pills = protocols
      .map((proto) => `<span class="dev-agent-card-protocol-pill">${escapeHtml(proto)}</span>`)
      .join('');
    parts.push(`<span class="dev-agent-card-summary-item">${pills}</span>`);
  }
  if (version) {
    parts.push(`<span class="dev-agent-card-summary-item">v<code>${escapeHtml(version)}</code></span>`);
  }
  if (parts.length === 0) return '';
  return `<div class="dev-agent-card-summary">${parts.join('')}</div>`;
}

export function statusBadgeHtml(): string {
  switch (tabState.status) {
    case 'loading':
      return '<span class="dev-agent-card-status">Fetching…</span>';
    case 'loaded':
      if (isEmptyCard(tabState.cardJson)) {
        return '<span class="dev-agent-card-status dev-agent-card-status--pending">Empty response</span>';
      }
      return `<span class="dev-agent-card-status dev-agent-card-status--ok">Loaded · ${formatTime(tabState.fetchedAt)}</span>`;
    case 'unavailable':
      return '<span class="dev-agent-card-status dev-agent-card-status--pending">Endpoint unreachable</span>';
    case 'error':
      return '<span class="dev-agent-card-status dev-agent-card-status--error">Fetch failed</span>';
    case 'idle':
    default:
      return '';
  }
}

export function bodyHtml(): string {
  if (tabState.status === 'idle' || tabState.status === 'loading') {
    return '<p class="dev-agent-card-empty">Fetching the live AgentCard for this wallet…</p>';
  }
  if (tabState.status === 'unavailable') {
    return `
      <p class="dev-agent-card-empty">
        Agent Card endpoint <code>${escapeHtml(LOCAL_AGENT_CARD_PATH)}</code> didn't respond.
        The route may not be deployed at this origin, or this wallet may not have dev access.
        The public URL below still resolves to whatever build is currently on agentic-signer.com.
      </p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry fetch</button>
    `;
  }
  if (tabState.status === 'error') {
    return `
      <p class="dev-agent-card-empty">Could not fetch AgentCard: ${escapeHtml(tabState.errorMessage ?? 'Unknown error')}</p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry</button>
    `;
  }
  if (isEmptyCard(tabState.cardJson)) {
    return '<p class="dev-agent-card-empty">Agent Card response was empty. The route responded but returned no fields.</p>';
  }
  const card = typeof tabState.cardJson === 'object' && tabState.cardJson !== null && !Array.isArray(tabState.cardJson)
    ? (tabState.cardJson as Record<string, unknown>)
    : null;
  return `${summaryHtml(card)}<pre class="dev-agent-card-json">${escapeHtml(stableJson(tabState.cardJson))}</pre>`;
}

export function panelHtml(): string {
  const canCopyJson = tabState.status === 'loaded' && !isEmptyCard(tabState.cardJson);
  const copyJsonButton = canCopyJson
    ? `<button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(stableJson(tabState.cardJson))}"
          data-copy-id="dev-agent-card-json"
          data-copy-name="AgentCard JSON"
        >Copy JSON</button>`
    : '';
  return `
    <section class="panel dev-agent-card-panel" data-layout="dev-agent-card">
      <header class="dev-agent-card-head">
        <div>
          <p class="dev-agent-card-eyebrow">A2A AgentCard · Layer 1 dev preview</p>
          <h2>Agent Card</h2>
          <p>
            Public-facing identity document that external AI agents read to discover this
            wallet's supported payment protocols and capabilities. Lives at
            <code>/.well-known/agent.json</code> for the public web; this preview shows what is
            live right now.
          </p>
        </div>
        ${statusBadgeHtml()}
      </header>
      <div class="dev-agent-card-actions">
        <button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(PUBLIC_AGENT_CARD_URL)}"
          data-copy-id="dev-agent-card-public-url"
          data-copy-name="Public AgentCard URL"
        >Copy public URL</button>
        ${copyJsonButton}
        <a class="button-link" href="${escapeHtml(PUBLIC_AGENT_CARD_URL)}" target="_blank" rel="noreferrer">View live</a>
        <button type="button" class="button utility" data-dev-agent-card-retry>Refresh</button>
      </div>
      <div class="dev-agent-card-body" id="${BODY_ELEMENT_ID}">
        ${bodyHtml()}
      </div>
    </section>
  `;
}

export async function fetchAgentCard(): Promise<void> {
  if (tabState.status === 'loading') return;
  tabState.status = 'loading';
  tabState.errorMessage = undefined;
  updateBody();
  try {
    const response = await fetch(LOCAL_AGENT_CARD_PATH, { credentials: 'include' });
    if (response.status === 404) {
      tabState.status = 'unavailable';
    } else if (!response.ok) {
      tabState.status = 'error';
      tabState.errorMessage = `HTTP ${response.status}`;
    } else {
      tabState.cardJson = await response.json();
      tabState.status = 'loaded';
      tabState.fetchedAt = Date.now();
    }
  } catch (error) {
    tabState.status = 'error';
    tabState.errorMessage = error instanceof Error ? error.message : String(error);
  }
  updateBody();
}

function updateBody(): void {
  if (typeof document === 'undefined') return;
  const body = document.getElementById(BODY_ELEMENT_ID);
  if (body) body.innerHTML = bodyHtml();
  const statusSlot = document.querySelector('[data-layout="dev-agent-card"] .dev-agent-card-head');
  if (statusSlot) {
    const existing = statusSlot.querySelector('.dev-agent-card-status');
    if (existing) existing.remove();
    const html = statusBadgeHtml();
    if (html) statusSlot.insertAdjacentHTML('beforeend', html);
  }
}

export function escapeHtml(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stableJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '';
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('[data-dev-agent-card-retry]')) {
      event.preventDefault();
      void fetchAgentCard();
    }
  });
}

registerDevTab({
  id: 'agent-card',
  label: 'Agent Card',
  mobileLabel: 'Card',
  guard: () => isDevWallet(getConnectedAddress()),
  render: () => {
    if (tabState.status === 'idle' && !kickoffScheduled) {
      kickoffScheduled = true;
      Promise.resolve().then(() => {
        kickoffScheduled = false;
        void fetchAgentCard();
      });
    }
    return panelHtml();
  },
});

export function __resetTabStateForTests(next?: Partial<TabState>): void {
  tabState.status = next?.status ?? 'idle';
  tabState.cardJson = next?.cardJson;
  tabState.errorMessage = next?.errorMessage;
  tabState.fetchedAt = next?.fetchedAt;
  kickoffScheduled = false;
}

export function __getTabStateForTests(): Readonly<TabState> {
  return {
    status: tabState.status,
    cardJson: tabState.cardJson,
    errorMessage: tabState.errorMessage,
    fetchedAt: tabState.fetchedAt,
  };
}
