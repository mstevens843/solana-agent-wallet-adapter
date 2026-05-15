import './agentCard.css';
import { currentAddress } from '../connectionState.js';

const PUBLIC_AGENT_CARD_URL = 'https://agentic-signer.com/.well-known/agent.json';
const LOCAL_AGENT_CARD_PATH = '/api/agents/card';
const PUBLIC_AGENT_CARD_PATH = '/.well-known/agent.json';
const BODY_ELEMENT_ID = 'dev-agent-card-body';
const DEV_WALLET_HEADER = 'x-agentic-wallet-address';
const USER_FACING_DESCRIPTION =
  'Other apps and agents can use this profile to send payment requests to this wallet. Every request still opens for review before anything is signed.';

type FetchStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error';

interface TabState {
  status: FetchStatus;
  cardJson?: unknown;
  errorMessage?: string;
  fetchedAt?: number;
}

interface AgentCardFetchResult {
  status: 'loaded' | 'unavailable' | 'error';
  cardJson?: unknown;
  errorMessage?: string;
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

function cardRecordFromState(): Record<string, unknown> | null {
  return typeof tabState.cardJson === 'object' && tabState.cardJson !== null && !Array.isArray(tabState.cardJson)
    ? (tabState.cardJson as Record<string, unknown>)
    : null;
}

function profileOrigin(card: Record<string, unknown> | null): string {
  return cardString(card, 'url') || PUBLIC_AGENT_CARD_URL.replace(PUBLIC_AGENT_CARD_PATH, '');
}

function profileEndpoint(card: Record<string, unknown> | null): string {
  const origin = profileOrigin(card).replace(/\/+$/, '');
  if (origin.endsWith(PUBLIC_AGENT_CARD_PATH)) return origin;
  return `${origin}${PUBLIC_AGENT_CARD_PATH}`;
}

function protocolPills(protocols: readonly string[]): string {
  if (protocols.length === 0) return '<span class="dev-agent-card-muted">None published</span>';
  return protocols
    .map((proto) => `<span class="dev-agent-card-protocol-pill">${escapeHtml(proto)}</span>`)
    .join('');
}

function tokenPills(tokens: readonly string[]): string {
  if (tokens.length === 0) return '<span class="dev-agent-card-muted">No tokens listed</span>';
  return tokens
    .map((token) => `<span class="dev-agent-card-token-pill">${escapeHtml(token)}</span>`)
    .join('');
}

function identitySummaryHtml(card: Record<string, unknown> | null): string {
  if (!card) return '';
  const walletAddress = typeof card.walletAddress === 'string' ? card.walletAddress : '';
  const protocols = stringArray(card.supportedProtocols);
  const tokens = stringArray(card.supportedTokens);
  const version = typeof card.version === 'string' ? card.version : '';
  const parts: string[] = [];
  if (walletAddress) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Wallet</span><code>${escapeHtml(shortAddress(walletAddress))}</code></article>`);
  }
  if (protocols.length > 0) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Request types</span><span class="dev-agent-card-protocols">${protocolPills(protocols)}</span></article>`);
  }
  if (tokens.length > 0) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Accepted tokens</span><span class="dev-agent-card-protocols">${tokenPills(tokens)}</span></article>`);
  }
  if (version) {
    parts.push(`<article class="dev-agent-card-summary-item"><span>Profile version</span><code>${escapeHtml(version)}</code></article>`);
  }
  if (parts.length === 0) return '';
  return `<div class="dev-agent-card-summary">${parts.join('')}</div>`;
}

function requestOverviewHtml(card: Record<string, unknown> | null): string {
  const protocols = stringArray(card?.supportedProtocols);
  const rows = [
    [
      'Incoming payments',
      protocols.includes('ap2') ? 'Ready' : 'Not listed',
      'External agents can send payment mandates to the approval inbox.',
    ],
    [
      'Checkout payments',
      protocols.includes('acp') ? 'Ready' : 'Not listed',
      'Merchant carts can be reviewed before the wallet pays them.',
    ],
    [
      'Approval mode',
      'Always review',
      'The profile advertises capabilities; it does not give anyone auto-signing access.',
    ],
  ];
  return `
    <section class="dev-agent-card-section" aria-label="Payment request overview">
      <div class="dev-agent-card-section-head">
        <span>Requests</span>
        <h3>How this profile is used</h3>
      </div>
      <div class="dev-agent-card-capability-grid">
        ${rows.map(([label, value, description]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <p>${escapeHtml(description)}</p>
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
    : '<p class="dev-agent-card-muted">No permissions are listed for this payment profile.</p>';
  return `
    <section class="dev-agent-card-section" aria-label="Agent skills">
      <div class="dev-agent-card-section-head">
        <span>Permissions</span>
        <h3>What other apps can ask for</h3>
      </div>
      <div class="dev-agent-card-skills-list">
        ${body}
      </div>
      ${hiddenCount > 0 ? `<p class="dev-agent-card-more-note">${hiddenCount} more permission(s) in developer details.</p>` : ''}
    </section>
  `;
}

function readableCardHtml(card: Record<string, unknown> | null): string {
  const name = cardString(card, 'name') || 'Agent Wallet';
  const url = profileEndpoint(card);
  const tokens = stringArray(card?.supportedTokens);
  return `
    <div class="dev-agent-card-readable">
      <section class="dev-agent-card-profile" aria-label="Agent identity summary">
        <div>
          <span class="dev-agent-card-readable-kicker">Active payment profile</span>
          <h3>${escapeHtml(name)}</h3>
          <p>${escapeHtml(USER_FACING_DESCRIPTION)}</p>
        </div>
        <div class="dev-agent-card-profile-side">
          <span>Accepts</span>
          <div class="dev-agent-card-protocols">${tokenPills(tokens)}</div>
        </div>
      </section>
      ${identitySummaryHtml(card)}
      <section class="dev-agent-card-section" aria-label="Payment profile link">
        <div class="dev-agent-card-section-head">
          <span>Profile link</span>
          <h3>Where compatible apps discover this wallet</h3>
        </div>
        <code class="dev-agent-card-url">${escapeHtml(url)}</code>
      </section>
      ${requestOverviewHtml(card)}
      ${skillsOverviewHtml(card)}
    </div>
  `;
}

function rawJsonHtml(): string {
  return `
    <details class="dev-agent-card-advanced">
      <summary>
        <span>Developer details</span>
        <strong>View technical profile JSON</strong>
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
      return '<span class="dev-agent-card-status">Checking…</span>';
    case 'loaded':
      if (isEmptyCard(tabState.cardJson)) {
        return '<span class="dev-agent-card-status dev-agent-card-status--pending">Needs setup</span>';
      }
      return `<span class="dev-agent-card-status dev-agent-card-status--ok">Live · ${formatTime(tabState.fetchedAt)}</span>`;
    case 'unavailable':
      return '<span class="dev-agent-card-status dev-agent-card-status--pending">Unavailable</span>';
    case 'error':
      return '<span class="dev-agent-card-status dev-agent-card-status--error">Check failed</span>';
    case 'idle':
    default:
      return '';
  }
}

export function bodyHtml(): string {
  if (tabState.status === 'idle' || tabState.status === 'loading') {
    return '<p class="dev-agent-card-empty dev-tab-loading-state">Checking this wallet&apos;s payment profile…</p>';
  }
  if (tabState.status === 'unavailable') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">
        This wallet&apos;s payment profile is not reachable from this app session.
      </p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry fetch</button>
    `;
  }
  if (tabState.status === 'error') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">Could not check payment profile: ${escapeHtml(tabState.errorMessage ?? 'Unknown error')}</p>
      <button type="button" class="button utility" data-dev-agent-card-retry>Retry</button>
    `;
  }
  if (isEmptyCard(tabState.cardJson)) {
    return '<p class="dev-agent-card-empty dev-tab-empty-state">This wallet does not have a payment profile yet.</p>';
  }
  const card = cardRecordFromState();
  return `
    ${readableCardHtml(card)}
    ${rawJsonHtml()}
  `;
}

function routeCardHtml(): string {
  const status = statusBadgeHtml() || '<span class="dev-agent-card-status dev-agent-card-status--idle">Ready</span>';
  const card = cardRecordFromState();
  const walletAddress = cardString(card, 'walletAddress');
  const protocols = stringArray(card?.supportedProtocols);
  const headline = tabState.status === 'loaded' && !isEmptyCard(tabState.cardJson)
    ? 'Discoverable'
    : tabState.status === 'loading'
      ? 'Checking'
      : 'Not reachable';
  return `
    <aside class="dev-agent-card-route-card" aria-label="Agent profile status">
      <div class="dev-agent-card-status-head">
        <span>Profile status</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      <div class="dev-agent-card-route-body">
        <div>
          <span>Wallet</span>
          <strong>${walletAddress ? escapeHtml(shortAddress(walletAddress)) : 'Connected wallet'}</strong>
        </div>
        <div>
          <span>Requests</span>
          <strong>${escapeHtml(formatProtocols(protocols).toUpperCase())}</strong>
        </div>
        <div class="dev-agent-card-status-cell" data-dev-agent-card-status-slot>
          ${status}
        </div>
      </div>
    </aside>
  `;
}

export function panelHtml(): string {
  const canCopyJson = tabState.status === 'loaded' && !isEmptyCard(tabState.cardJson);
  const card = cardRecordFromState();
  const url = profileEndpoint(card);
  const copyJsonButton = canCopyJson
    ? `<button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(stableJson(tabState.cardJson))}"
          data-copy-id="dev-agent-card-json"
          data-copy-name="Technical profile JSON"
        >Copy JSON</button>`
    : '';
  return `
    <section class="panel dev-agent-card-panel dev-tab-shell" data-layout="dev-agent-card">
      <header class="dev-agent-card-head dev-tab-header">
        <div class="dev-tab-header-main">
          <p class="dev-agent-card-eyebrow dev-tab-kicker">Agent payments profile</p>
          <div class="dev-tab-title-row">
            <h2>Payment Profile</h2>
            <span class="dev-agent-card-identity-pill">Approval required</span>
          </div>
          <p>
            Let compatible apps find this wallet, send payment requests, and route checkout carts.
            You stay in control because every request must be approved before signing.
          </p>
          <div class="dev-agent-card-actions dev-tab-actions">
            <button
              type="button"
              class="button utility"
              data-copy="${escapeHtml(url)}"
              data-copy-id="dev-agent-card-public-url"
              data-copy-name="Payment profile link"
            >Copy profile link</button>
            ${copyJsonButton}
            <a class="button-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open profile</a>
            <button type="button" class="button utility" data-dev-agent-card-retry>Refresh</button>
          </div>
        </div>
        ${routeCardHtml()}
      </header>
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
  let lastError: string | undefined;
  let unavailable = false;
  try {
    for (const path of agentCardFetchPaths()) {
      const result = await fetchAgentCardPath(path);
      if (result.status === 'loaded') {
        tabState.cardJson = result.cardJson;
        tabState.status = 'loaded';
        tabState.fetchedAt = Date.now();
        updateBody();
        return;
      }
      if (result.status === 'unavailable') {
        unavailable = true;
      } else {
        tabState.status = 'error';
        tabState.errorMessage = result.errorMessage;
        updateBody();
        return;
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }
  if (lastError && !unavailable) {
    tabState.status = 'error';
    tabState.errorMessage = lastError;
  } else {
    tabState.status = 'unavailable';
    tabState.errorMessage = lastError;
  }
  updateBody();
}

function agentCardFetchPaths(): string[] {
  const paths = [LOCAL_AGENT_CARD_PATH, PUBLIC_AGENT_CARD_PATH];
  if (typeof window !== 'undefined') {
    try {
      const publicUrl = new URL(PUBLIC_AGENT_CARD_URL);
      if (publicUrl.origin !== window.location.origin) paths.push(PUBLIC_AGENT_CARD_URL);
    } catch {
      paths.push(PUBLIC_AGENT_CARD_URL);
    }
  }
  return [...new Set(paths)];
}

async function fetchAgentCardPath(path: string): Promise<AgentCardFetchResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const sameOrigin = isSameOriginFetchPath(path);
  const walletAddress = sameOrigin ? currentAddress() : null;
  if (walletAddress) headers[DEV_WALLET_HEADER] = walletAddress;

  let response: Response;
  try {
    response = await fetch(path, {
      credentials: sameOrigin ? 'include' : 'omit',
      headers,
    });
  } catch (error) {
    return {
      status: 'error',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 403 || response.status === 404) {
    return { status: 'unavailable' };
  }
  if (!response.ok) {
    return { status: 'error', errorMessage: `HTTP ${response.status}` };
  }

  const raw = await response.text();
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && raw.trimStart().startsWith('<')) {
    return { status: 'unavailable' };
  }

  try {
    return { status: 'loaded', cardJson: JSON.parse(raw) };
  } catch {
    return {
      status: 'error',
      errorMessage: 'Agent Card route returned invalid JSON.',
    };
  }
}

function isSameOriginFetchPath(path: string): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return new URL(path, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
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
