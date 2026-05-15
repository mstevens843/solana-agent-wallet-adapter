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

function statusBadgeHtml(): string {
  switch (tabState.status) {
    case 'loading':
      return '<span class="dev-agent-card-status">Fetching…</span>';
    case 'loaded':
      return `<span class="dev-agent-card-status dev-agent-card-status--ok">Loaded · ${formatTime(tabState.fetchedAt)}</span>`;
    case 'unavailable':
      return '<span class="dev-agent-card-status dev-agent-card-status--pending">Endpoint pending</span>';
    case 'error':
      return '<span class="dev-agent-card-status dev-agent-card-status--error">Fetch failed</span>';
    case 'idle':
    default:
      return '';
  }
}

function bodyHtml(): string {
  if (tabState.status === 'idle' || tabState.status === 'loading') {
    return '<p class="dev-agent-card-empty">Fetching the live AgentCard for this wallet…</p>';
  }
  if (tabState.status === 'unavailable') {
    return `
      <p class="dev-agent-card-empty">
        Agent Card endpoint <code>${escapeHtml(LOCAL_AGENT_CARD_PATH)}</code> is not yet available.
        It ships with the Agent 7 deploy. Until then the public URL below still resolves to
        whatever build is currently on agentic-signer.com.
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
  return `<pre class="dev-agent-card-json">${escapeHtml(stableJson(tabState.cardJson))}</pre>`;
}

function panelHtml(): string {
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
        <a class="button-link" href="${escapeHtml(PUBLIC_AGENT_CARD_URL)}" target="_blank" rel="noreferrer">View live</a>
        <button type="button" class="button utility" data-dev-agent-card-retry>Refresh</button>
      </div>
      <div class="dev-agent-card-body" id="${BODY_ELEMENT_ID}">
        ${bodyHtml()}
      </div>
    </section>
  `;
}

async function fetchAgentCard(): Promise<void> {
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

function escapeHtml(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stableJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(timestamp: number | undefined): string {
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
