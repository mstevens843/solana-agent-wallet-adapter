import './agentCard.css';

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function cardString(card: Record<string, unknown> | null, key: string): string {
  if (!card) return '';
  const value = card[key];
  return typeof value === 'string' ? value : '';
}

function protocolPills(protocols: readonly string[]): string {
  if (protocols.length === 0) return '<span class="dev-agent-card-muted">None published</span>';
  return protocols
    .map((proto) => `<span class="dev-agent-card-protocol-pill">${escapeHtml(proto)}</span>`)
    .join('');
}

function identitySummaryHtml(card: Record<string, unknown> | null): string {
  if (!card) return '';
  const walletAddress = typeof card.walletAddress === 'string' ? card.walletAddress : '';
  const protocols = stringArray(card.supportedProtocols);
  const version = typeof card.version === 'string' ? card.version : '';
  const parts: string[] = [];
  if (walletAddress) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Wallet</span><code>${escapeHtml(shortAddress(walletAddress))}</code></article>`);
  }
  if (protocols.length > 0) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Protocols</span><span class="dev-agent-card-protocols">${protocolPills(protocols)}</span></article>`);
  }
  if (version) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Version</span><code>${escapeHtml(version)}</code></article>`);
  }
  if (parts.length === 0) return '';
  return `<div class="dev-agent-card-summary">${parts.join('')}</div>`;
}

function capabilityOverviewHtml(card: Record<string, unknown> | null): string {
  const capabilities = card?.capabilities && typeof card.capabilities === 'object' && !Array.isArray(card.capabilities)
    ? (card.capabilities as Record<string, unknown>)
    : {};
  const rows = [
    ['Streaming', capabilities.streaming === true ? 'Enabled' : 'Off'],
    ['Push notifications', capabilities.pushNotifications === true ? 'Enabled' : 'Off'],
    ['State history', capabilities.stateTransitionHistory === true ? 'Enabled' : 'Off'],
  ];
  return `
    <section class="dev-agent-card-section" aria-label="Agent capabilities">
      <div class="dev-agent-card-section-head">
        <span>Capabilities</span>
        <h3>What agents can discover</h3>
      </div>
      <div class="dev-agent-card-capability-grid">
        ${rows.map(([label, value]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function skillsOverviewHtml(card: Record<string, unknown> | null): string {
  const skills = Array.isArray(card?.skills) ? card.skills : [];
  const visible = skills
    .filter((skill): skill is Record<string, unknown> => skill !== null && typeof skill === 'object' && !Array.isArray(skill))
    .slice(0, 4);
  const hiddenCount = Math.max(0, skills.length - visible.length);
  const body = visible.length > 0
    ? visible.map((skill) => {
      const name = typeof skill.name === 'string' ? skill.name : 'Unnamed skill';
      const description = typeof skill.description === 'string' ? skill.description : 'No description published.';
      const id = typeof skill.id === 'string' ? skill.id : '';
      return `
        <article class="dev-agent-card-skill">
          <div>
            <strong>${escapeHtml(name)}</strong>
            ${id ? `<code>${escapeHtml(id)}</code>` : ''}
          </div>
          <p>${escapeHtml(description)}</p>
        </article>
      `;
    }).join('')
    : '<p class="dev-agent-card-muted">No skills are published in this Agent Card.</p>';
  return `
    <section class="dev-agent-card-section" aria-label="Agent skills">
      <div class="dev-agent-card-section-head">
        <span>Skills</span>
        <h3>Actions this wallet advertises</h3>
      </div>
      <div class="dev-agent-card-skills-list">
        ${body}
      </div>
      ${hiddenCount > 0 ? `<p class="dev-agent-card-more-note">${hiddenCount} more skill(s) in raw Agent Card.</p>` : ''}
    </section>
  `;
}

function readableCardHtml(card: Record<string, unknown> | null): string {
  const name = cardString(card, 'name') || 'Agent Wallet';
  const description = cardString(card, 'description') || 'Public identity and capabilities profile for this wallet.';
  const url = cardString(card, 'url') || PUBLIC_AGENT_CARD_URL;
  const protocols = stringArray(card?.supportedProtocols);
  return `
    <div class="dev-agent-card-readable">
      <section class="dev-agent-card-profile" aria-label="Agent identity summary">
        <div>
          <span class="dev-agent-card-readable-kicker">Agent identity</span>
          <h3>${escapeHtml(name)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="dev-agent-card-profile-side">
          <span>Protocols</span>
          <div class="dev-agent-card-protocols">${protocolPills(protocols)}</div>
        </div>
      </section>
      ${identitySummaryHtml(card)}
      <section class="dev-agent-card-section" aria-label="Public Agent Card URL">
        <div class="dev-agent-card-section-head">
          <span>Public URL</span>
          <h3>Where other agents read this profile</h3>
        </div>
        <code class="dev-agent-card-url">${escapeHtml(url)}</code>
      </section>
      ${capabilityOverviewHtml(card)}
      ${skillsOverviewHtml(card)}
    </div>
  `;
}

function rawJsonHtml(): string {
  return `
    <details class="dev-agent-card-advanced">
      <summary>
        <span>Advanced</span>
        <strong>View raw Agent Card</strong>
      </summary>
      <div class="dev-agent-card-json-window terminal-preview-window">
        <div class="terminal-preview-bar dev-agent-card-json-bar">
          <span></span>
          <span></span>
          <span></span>
          <strong>agent.json</strong>
        </div>
        <pre class="dev-agent-card-json">${escapeHtml(stableJson(tabState.cardJson))}</pre>
      </div>
    </details>
  `;
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
    return '<p class="dev-agent-card-empty dev-tab-loading-state">Fetching the live Agent Card for this wallet…</p>';
  }
  if (tabState.status === 'unavailable') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">
        Agent Card endpoint <code>${escapeHtml(LOCAL_AGENT_CARD_PATH)}</code> didn't respond.
        The route may not be deployed at this origin, or this wallet may not have dev access.
        The public URL below still resolves to whatever build is currently on agentic-signer.com.
      </p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry fetch</button>
    `;
  }
  if (tabState.status === 'error') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">Could not fetch Agent Card: ${escapeHtml(tabState.errorMessage ?? 'Unknown error')}</p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry</button>
    `;
  }
  if (isEmptyCard(tabState.cardJson)) {
    return '<p class="dev-agent-card-empty dev-tab-empty-state">Agent Card response was empty. The route responded but returned no fields.</p>';
  }
  const card = typeof tabState.cardJson === 'object' && tabState.cardJson !== null && !Array.isArray(tabState.cardJson)
    ? (tabState.cardJson as Record<string, unknown>)
    : null;
  return `
    ${readableCardHtml(card)}
    ${rawJsonHtml()}
  `;
}

function routeCardHtml(): string {
  const status = statusBadgeHtml() || '<span class="dev-agent-card-status dev-agent-card-status--idle">Ready</span>';
  return `
    <div class="dev-agent-card-route-card terminal-preview-window" aria-label="AgentCard route">
      <div class="terminal-preview-bar dev-agent-card-route-bar">
        <span></span>
        <span></span>
        <span></span>
        <strong>identity-route</strong>
      </div>
      <div class="dev-agent-card-route-body">
        <div>
          <span>Preview route</span>
          <strong>${escapeHtml(LOCAL_AGENT_CARD_PATH)}</strong>
        </div>
        <div>
          <span>Public</span>
          <strong>/.well-known/agent.json</strong>
        </div>
        <div class="dev-agent-card-status-cell" data-dev-agent-card-status-slot>
          ${status}
        </div>
      </div>
    </div>
  `;
}

export function panelHtml(): string {
  const canCopyJson = tabState.status === 'loaded' && !isEmptyCard(tabState.cardJson);
  const copyJsonButton = canCopyJson
    ? `<button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(stableJson(tabState.cardJson))}"
          data-copy-id="dev-agent-card-json"
          data-copy-name="Raw Agent Card JSON"
        >Copy raw JSON</button>`
    : '';
  return `
    <section class="panel dev-agent-card-panel dev-tab-shell" data-layout="dev-agent-card">
      <header class="dev-agent-card-head dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-agent-card-eyebrow dev-tab-kicker">A2A Agent Card · Public identity</p>
          <div class="dev-tab-title-row">
            <h2>Agent Card</h2>
            <span class="dev-agent-card-identity-pill">Public identity</span>
          </div>
          <p>
            Public identity profile for this wallet. Other agents use it to discover supported
            protocols, capabilities, and skills; the raw <code>agent.json</code> stays available
            for developers below.
          </p>
        </div>
        ${routeCardHtml()}
      </header>
      <div class="dev-agent-card-actions dev-tab-actions">
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
  const statusSlot = document.querySelector('[data-dev-agent-card-status-slot]');
  if (statusSlot) {
    statusSlot.innerHTML = statusBadgeHtml() || '<span class="dev-agent-card-status dev-agent-card-status--idle">Ready</span>';
    return;
  }
  const legacyStatusSlot = document.querySelector('[data-layout="dev-agent-card"] .dev-agent-card-head');
  if (legacyStatusSlot) {
    const existing = legacyStatusSlot.querySelector('.dev-agent-card-status');
    if (existing) existing.remove();
    const html = statusBadgeHtml();
    if (html) legacyStatusSlot.insertAdjacentHTML('beforeend', html);
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

export function renderAgentCardPanel(): string {
  if (tabState.status === 'idle' && !kickoffScheduled) {
    kickoffScheduled = true;
    Promise.resolve().then(() => {
      kickoffScheduled = false;
      void fetchAgentCard();
    });
  }
  return panelHtml();
}

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
