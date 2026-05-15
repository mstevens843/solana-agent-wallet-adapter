import './agentCard.css';
import {
  ALLOWED_PROFILE_PROTOCOLS,
  ALLOWED_PROFILE_TOKENS,
  PROFILE_PAYLOAD_VERSION,
  validateProfilePayload,
  type AgentPaymentProfilePayload,
  type AllowedProfileProtocol,
  type AllowedProfileToken,
  type ProfilePayloadValidationError,
} from '@solana-agent-wallet-adapter/a2a-agent-card';

import { cloudWalletAvailable, cloudWalletRequest, cloudWalletSignMessage } from '../cloudWalletBridge.js';
import { currentAddress } from '../connectionState.js';

const PROFILE_PATH = '/api/preferences/agent-payment-profile';
const PROFILE_INTENT_PATH = '/api/agents/profile-intent';
const PROFILE_WRITE_PATH = '/api/agents/profile';
const BODY_ELEMENT_ID = 'dev-agent-card-body';

type FetchStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error';
type FormBusy = false | 'publish' | 'takedown';

interface FetchedProfile {
  payload: AgentPaymentProfilePayload | null;
  updatedAt: string | null;
  version: number;
}

interface DraftState {
  discoverable: boolean;
  displayName: string;
  acceptedTokens: Set<AllowedProfileToken>;
  protocols: Set<AllowedProfileProtocol>;
  contactEmail: string;
}

interface FormBanner {
  tone: 'success' | 'error';
  message: string;
}

interface TabState {
  status: FetchStatus;
  errorMessage?: string;
  fetchedAt?: number;
  fetched?: FetchedProfile;
  draft: DraftState;
  formBusy: FormBusy;
  formBanner?: FormBanner;
  fieldErrors: ProfilePayloadValidationError[];
}

interface ProfileIntentResponse {
  nonce: string;
  message: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  walletAddress: string;
  action: 'publish' | 'takedown';
}

interface ProfileWriteResponse {
  ok: true;
  profile: { namespace: string; payload: AgentPaymentProfilePayload | null; updatedAt: string; version: number } | null;
}

const tabState: TabState = {
  status: 'idle',
  draft: createBlankDraft(),
  formBusy: false,
  fieldErrors: [],
};
let kickoffScheduled = false;

export function shortAddress(address: string | undefined | null): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
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

export function formatTime(timestamp: number | string | undefined | null): string {
  if (!timestamp) return '';
  try {
    const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

function createBlankDraft(): DraftState {
  return {
    discoverable: false,
    displayName: '',
    acceptedTokens: new Set(['USDC', 'USDT', 'SOL']),
    protocols: new Set(['ap2', 'acp', 'a2a']),
    contactEmail: '',
  };
}

function defaultDisplayNameFor(address: string | null): string {
  if (!address) return 'My Agentic Wallet';
  return `Wallet ${shortAddress(address)}`;
}

function draftFromPayload(payload: AgentPaymentProfilePayload, fallbackAddress: string | null): DraftState {
  const displayName = payload.displayName.trim().length > 0
    ? payload.displayName.trim()
    : defaultDisplayNameFor(fallbackAddress);
  return {
    discoverable: payload.discoverable,
    displayName,
    acceptedTokens: new Set(payload.acceptedTokens),
    protocols: new Set(payload.protocols),
    contactEmail: payload.contactEmail ?? '',
  };
}

function draftFromBlank(address: string | null): DraftState {
  return {
    ...createBlankDraft(),
    displayName: defaultDisplayNameFor(address),
  };
}

function payloadFromDraft(draft: DraftState): AgentPaymentProfilePayload {
  const payload: AgentPaymentProfilePayload = {
    version: PROFILE_PAYLOAD_VERSION,
    discoverable: draft.discoverable,
    displayName: draft.displayName.trim(),
    acceptedTokens: Array.from(draft.acceptedTokens),
    protocols: Array.from(draft.protocols),
  };
  const email = draft.contactEmail.trim();
  if (email.length > 0) payload.contactEmail = email;
  return payload;
}

function perWalletUrl(address: string | null): string | null {
  if (!address || typeof window === 'undefined') return null;
  return `${window.location.origin}/agents/${address}/card.json`;
}

function profileSummaryStatus(): 'unpublished' | 'discoverable' | 'hidden' {
  if (!tabState.fetched || !tabState.fetched.payload) return 'unpublished';
  return tabState.fetched.payload.discoverable ? 'discoverable' : 'hidden';
}

function statusHeadline(): string {
  switch (profileSummaryStatus()) {
    case 'discoverable':
      return 'Discoverable';
    case 'hidden':
      return 'Hidden';
    case 'unpublished':
    default:
      return 'Not published';
  }
}

function statusBadgeHtml(): string {
  switch (tabState.status) {
    case 'loading':
      return '<span class="dev-agent-card-status">Checking…</span>';
    case 'loaded': {
      const status = profileSummaryStatus();
      if (status === 'discoverable') {
        return `<span class="dev-agent-card-status dev-agent-card-status--ok">Live · ${escapeHtml(formatTime(tabState.fetchedAt))}</span>`;
      }
      if (status === 'hidden') {
        return '<span class="dev-agent-card-status dev-agent-card-status--pending">Hidden</span>';
      }
      return '<span class="dev-agent-card-status dev-agent-card-status--pending">Not published</span>';
    }
    case 'unavailable':
      return '<span class="dev-agent-card-status dev-agent-card-status--pending">Unavailable</span>';
    case 'error':
      return '<span class="dev-agent-card-status dev-agent-card-status--error">Check failed</span>';
    case 'idle':
    default:
      return '';
  }
}

function fieldErrorFor(field: ProfilePayloadValidationError['field']): string | undefined {
  return tabState.fieldErrors.find((entry) => entry.field === field)?.message;
}

function renderToggleRow(): string {
  const checked = tabState.draft.discoverable ? 'checked' : '';
  return `
    <label class="ai-toggle dev-agent-card-form-toggle">
      <input type="checkbox" data-profile-toggle="discoverable" ${checked} />
      <span>
        <strong>Discoverable</strong>
        <em>Let compatible apps fetch this wallet's profile.</em>
      </span>
    </label>
  `;
}

function renderTokenChips(): string {
  const error = fieldErrorFor('acceptedTokens');
  const chips = ALLOWED_PROFILE_TOKENS.map((token) => {
    const selected = tabState.draft.acceptedTokens.has(token);
    return `
      <button
        type="button"
        class="dev-agent-card-chip dev-agent-card-token-pill dev-agent-card-chip-toggle"
        data-profile-chip-token="${escapeHtml(token)}"
        data-selected="${selected ? 'true' : 'false'}"
        role="switch"
        aria-checked="${selected ? 'true' : 'false'}"
      >${escapeHtml(token)}</button>
    `;
  }).join('');
  return `
    <div class="dev-agent-card-form-field">
      <label class="dev-agent-card-form-label" for="dev-agent-card-tokens">Accepted tokens</label>
      <p class="dev-agent-card-form-help">Pick what you'll take when an agent or merchant pays you.</p>
      <div class="dev-agent-card-chip-row" id="dev-agent-card-tokens">${chips}</div>
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderProtocolChips(): string {
  const error = fieldErrorFor('protocols');
  const labels: Record<AllowedProfileProtocol, string> = {
    ap2: 'AP2 Inbound',
    acp: 'ACP Checkout',
    a2a: 'A2A Discovery',
  };
  const chips = ALLOWED_PROFILE_PROTOCOLS.map((protocol) => {
    const selected = tabState.draft.protocols.has(protocol);
    return `
      <button
        type="button"
        class="dev-agent-card-chip dev-agent-card-protocol-pill dev-agent-card-chip-toggle"
        data-profile-chip-protocol="${escapeHtml(protocol)}"
        data-selected="${selected ? 'true' : 'false'}"
        role="switch"
        aria-checked="${selected ? 'true' : 'false'}"
      >${escapeHtml(labels[protocol])}</button>
    `;
  }).join('');
  return `
    <div class="dev-agent-card-form-field">
      <label class="dev-agent-card-form-label" for="dev-agent-card-protocols">Protocols</label>
      <p class="dev-agent-card-form-help">Which agent standards you speak. Most users keep all three on.</p>
      <div class="dev-agent-card-chip-row" id="dev-agent-card-protocols">${chips}</div>
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderDisplayNameField(): string {
  const error = fieldErrorFor('displayName');
  return `
    <div class="dev-agent-card-form-field">
      <label class="dev-agent-card-form-label" for="dev-agent-card-display-name">Display name</label>
      <input
        type="text"
        id="dev-agent-card-display-name"
        class="dev-agent-card-form-input"
        data-profile-field="displayName"
        value="${escapeHtml(tabState.draft.displayName)}"
        maxlength="64"
        placeholder="Mathew's Wallet"
        autocomplete="off"
      />
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderContactEmailField(): string {
  const error = fieldErrorFor('contactEmail');
  return `
    <div class="dev-agent-card-form-field">
      <label class="dev-agent-card-form-label" for="dev-agent-card-contact-email">Contact email <em>(optional)</em></label>
      <input
        type="email"
        id="dev-agent-card-contact-email"
        class="dev-agent-card-form-input"
        data-profile-field="contactEmail"
        value="${escapeHtml(tabState.draft.contactEmail)}"
        maxlength="254"
        placeholder="you@example.com"
        autocomplete="off"
      />
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderFormBanner(): string {
  if (!tabState.formBanner) return '';
  const cls = tabState.formBanner.tone === 'success'
    ? 'dev-agent-card-form-banner dev-agent-card-form-banner--ok'
    : 'dev-agent-card-form-banner dev-agent-card-form-banner--err';
  return `<p class="${cls}">${escapeHtml(tabState.formBanner.message)}</p>`;
}

function renderFormActions(): string {
  const busy = tabState.formBusy;
  const saveLabel = busy === 'publish' ? 'Saving…' : 'Save profile';
  const takedownLabel = busy === 'takedown' ? 'Taking down…' : 'Take profile down';
  const hasRecord = Boolean(tabState.fetched?.payload);
  return `
    <div class="dev-agent-card-form-actions">
      <button
        type="button"
        class="button primary"
        data-profile-action="save"
        ${busy ? 'disabled' : ''}
      >${escapeHtml(saveLabel)}</button>
      ${hasRecord ? `
        <button
          type="button"
          class="button utility"
          data-profile-action="takedown"
          ${busy ? 'disabled' : ''}
        >${escapeHtml(takedownLabel)}</button>
      ` : ''}
      <span class="dev-agent-card-form-hint">Validation runs before any wallet signature is requested.</span>
    </div>
  `;
}

function renderFormSection(): string {
  const onboarding = profileSummaryStatus() === 'unpublished'
    ? `<p class="dev-agent-card-form-onboard">Your wallet isn't discoverable yet. Edit below, then toggle Discoverable on and Save to publish.</p>`
    : '';
  return `
    <section class="dev-agent-card-section dev-agent-card-form-section" aria-label="Edit your payment profile">
      <div class="dev-agent-card-section-head">
        <span>Edit your payment profile</span>
        <h3>Control what agents see when they pay you</h3>
      </div>
      ${onboarding}
      ${renderFormBanner()}
      ${renderToggleRow()}
      ${renderDisplayNameField()}
      ${renderTokenChips()}
      ${renderProtocolChips()}
      ${renderContactEmailField()}
      ${renderFormActions()}
    </section>
  `;
}

function renderProfileLinkSection(address: string | null): string {
  const url = perWalletUrl(address);
  const status = profileSummaryStatus();
  if (!url) return '';
  if (status !== 'discoverable') {
    return `
      <section class="dev-agent-card-section dev-agent-card-link-section dev-agent-card-link-section--disabled" aria-label="Profile link">
        <div class="dev-agent-card-section-head">
          <span>Profile link</span>
          <h3>Where compatible apps will discover this wallet</h3>
        </div>
        <code class="dev-agent-card-url dev-agent-card-url--disabled">${escapeHtml(url)}</code>
        <p class="dev-agent-card-form-help">Toggle Discoverable on and Save to publish this link.</p>
      </section>
    `;
  }
  return `
    <section class="dev-agent-card-section dev-agent-card-link-section" aria-label="Profile link">
      <div class="dev-agent-card-section-head">
        <span>Profile link</span>
        <h3>Where compatible apps discover this wallet</h3>
      </div>
      <code class="dev-agent-card-url">${escapeHtml(url)}</code>
      <div class="dev-agent-card-link-actions">
        <button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(url)}"
          data-copy-id="dev-agent-card-profile-link"
          data-copy-name="Payment profile link"
        >Copy profile link</button>
        <a class="button-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open profile</a>
      </div>
    </section>
  `;
}

function renderDemoLink(): string {
  return `
    <section class="dev-agent-card-section dev-agent-card-demo-link" aria-label="Try a sample agent payment">
      <div>
        <h3>Want to see this in action?</h3>
        <p>Switch to Incoming Requests and queue a demo agent payment against this profile.</p>
      </div>
      <button type="button" class="button primary" data-profile-action="try-demo">
        Try a sample agent payment →
      </button>
    </section>
  `;
}

function renderExplainer(): string {
  return `
    <details class="panel public-request-context dev-agent-card-explainer">
      <summary>What's a payment profile?</summary>
      <p class="dev-agent-card-explainer-lede">
        A wallet address says <em>where</em> to send money. A payment profile says <em>how</em>.
      </p>
      <p>
        Address = phone number (44 chars, opaque). Profile = contact card with display name, accepted tokens,
        supported protocols, and an "always review" rule. It's the same idea as PayPal.me or a Stripe payment
        link — published at <code>/agents/&lt;wallet&gt;/card.json</code> so AI agents and merchant checkouts can
        fetch it automatically.
      </p>
      <div class="dev-agent-card-explainer-grid">
        <article>
          <h4>Without a profile</h4>
          <p>The external agent has to be hand-told your address, the token you accept, and the protocol you speak. Friction every time.</p>
        </article>
        <article>
          <h4>With a profile</h4>
          <p>The agent fetches your URL, gets address + tokens + protocols in one round-trip, builds the right mandate, drops it in your inbox.</p>
        </article>
      </div>
      <h4>When it matters</h4>
      <ul>
        <li>An AI agent (OpenAI Operator, Vercel AI, Google Agent Builder) is paying you autonomously — <strong>AP2</strong>.</li>
        <li>A merchant checkout (Stripe ACP) is routing payment to a non-custodial wallet — <strong>ACP</strong>.</li>
        <li>Another agent's wallet wants to discover yours programmatically — <strong>A2A</strong>.</li>
        <li>You want a stable, shareable URL that's friendlier than <code>4fTq…MoHd</code>.</li>
      </ul>
      <h4>When it doesn't</h4>
      <ul>
        <li>Human paying human → just paste the address.</li>
        <li>One-off transfer from someone who already has your address.</li>
      </ul>
      <p class="dev-agent-card-explainer-foot">
        The profile is an opt-in layer on top of your wallet. Toggle "Discoverable" off any time to take it down.
      </p>
    </details>
  `;
}

function routeCardHtml(): string {
  const status = statusBadgeHtml() || '<span class="dev-agent-card-status dev-agent-card-status--idle">Ready</span>';
  const address = currentAddress();
  const summary = profileSummaryStatus();
  const protocolText = summary === 'discoverable' && tabState.fetched?.payload
    ? tabState.fetched.payload.protocols.map((p) => p.toUpperCase()).join(' · ')
    : tabState.draft.protocols.size > 0
      ? Array.from(tabState.draft.protocols).map((p) => p.toUpperCase()).join(' · ')
      : '—';
  return `
    <aside class="dev-agent-card-route-card" aria-label="Agent profile status">
      <div class="dev-agent-card-status-head">
        <span>Profile status</span>
        <strong>${escapeHtml(statusHeadline())}</strong>
      </div>
      <div class="dev-agent-card-route-body">
        <div>
          <span>Wallet</span>
          <strong>${address ? escapeHtml(shortAddress(address)) : 'Not connected'}</strong>
        </div>
        <div>
          <span>Requests</span>
          <strong>${escapeHtml(protocolText)}</strong>
        </div>
        <div class="dev-agent-card-status-cell" data-dev-agent-card-status-slot>
          ${status}
        </div>
      </div>
    </aside>
  `;
}

function bodyHtml(): string {
  if (tabState.status === 'idle' || tabState.status === 'loading') {
    return '<p class="dev-agent-card-empty dev-tab-loading-state">Loading your payment profile…</p>';
  }
  if (tabState.status === 'unavailable') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">
        Sign in to Agentic Cloud to manage this wallet's payment profile. Connect your wallet and complete the cloud sign-in challenge, then return here.
      </p>
      <button type="button" class="button utility" data-profile-action="refresh">Retry</button>
    `;
  }
  if (tabState.status === 'error') {
    return `
      <p class="dev-agent-card-empty dev-tab-empty-state">Could not load profile: ${escapeHtml(tabState.errorMessage ?? 'Unknown error')}</p>
      <button type="button" class="button utility" data-profile-action="refresh">Retry</button>
    `;
  }
  const address = currentAddress();
  return `
    ${renderFormSection()}
    ${renderProfileLinkSection(address)}
    ${renderDemoLink()}
    ${renderExplainer()}
  `;
}

export function panelHtml(): string {
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
            Let compatible apps find this wallet, send payment requests, and route checkout carts. You stay in
            control because every request must be approved in your wallet before signing.
          </p>
          <div class="dev-agent-card-actions dev-tab-actions">
            <button type="button" class="button utility" data-profile-action="refresh">Refresh</button>
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

export async function fetchAgentProfile(): Promise<void> {
  if (tabState.status === 'loading') return;
  if (!cloudWalletAvailable()) {
    tabState.status = 'unavailable';
    updateBody();
    return;
  }
  tabState.status = 'loading';
  tabState.errorMessage = undefined;
  updateBody();

  try {
    const response = await cloudWalletRequest<{
      namespace?: string;
      payload?: unknown;
      updatedAt?: string | null;
      version?: number;
    }>(PROFILE_PATH);
    const validated = validateProfilePayload(response.payload);
    const fetched: FetchedProfile = {
      payload: validated.ok ? validated.payload : null,
      updatedAt: response.updatedAt ?? null,
      version: response.version ?? 0,
    };
    tabState.fetched = fetched;
    tabState.draft = fetched.payload
      ? draftFromPayload(fetched.payload, currentAddress())
      : draftFromBlank(currentAddress());
    tabState.fieldErrors = [];
    tabState.status = 'loaded';
    tabState.fetchedAt = Date.now();
  } catch (error) {
    if (isUnauthorized(error)) {
      tabState.status = 'unavailable';
      tabState.errorMessage = undefined;
    } else {
      tabState.status = 'error';
      tabState.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }
  updateBody();
}

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { status?: number; statusCode?: number; message?: string };
  if (record.status === 401 || record.statusCode === 401) return true;
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
  return message.includes('sign in required') || message.includes('signed in');
}

function updateBody(): void {
  if (typeof document === 'undefined') return;
  const body = document.getElementById(BODY_ELEMENT_ID);
  if (body) body.innerHTML = bodyHtml();
  const statusSlot = document.querySelector('[data-dev-agent-card-status-slot]');
  if (statusSlot) {
    statusSlot.innerHTML = statusBadgeHtml() || '<span class="dev-agent-card-status dev-agent-card-status--idle">Ready</span>';
  }
  const headlineSlot = document.querySelector<HTMLElement>('.dev-agent-card-status-head strong');
  if (headlineSlot) headlineSlot.textContent = statusHeadline();
}

function setDraft<K extends keyof DraftState>(key: K, value: DraftState[K]): void {
  tabState.draft = { ...tabState.draft, [key]: value };
}

function toggleSetMember<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

async function publishProfile(): Promise<void> {
  if (tabState.formBusy) return;
  if (!cloudWalletAvailable()) {
    tabState.formBanner = { tone: 'error', message: 'Connect your wallet first.' };
    updateBody();
    return;
  }
  const payload = payloadFromDraft(tabState.draft);
  const validation = validateProfilePayload(payload);
  if (!validation.ok) {
    tabState.fieldErrors = validation.errors;
    tabState.formBanner = { tone: 'error', message: 'Fix the highlighted fields and try again.' };
    updateBody();
    return;
  }
  tabState.fieldErrors = [];
  tabState.formBusy = 'publish';
  tabState.formBanner = undefined;
  updateBody();

  try {
    const intent = await cloudWalletRequest<ProfileIntentResponse>(PROFILE_INTENT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'publish', payload: validation.payload }),
    });
    const signed = await cloudWalletSignMessage(intent.message, 'Publish payment profile');
    const result = await cloudWalletRequest<ProfileWriteResponse>(PROFILE_WRITE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: intent.walletAddress,
        nonce: intent.nonce,
        message: intent.message,
        signature: signed.signature,
        domain: intent.domain,
        issuedAt: intent.issuedAt,
        expiresAt: intent.expiresAt,
        signatureEncoding: signed.encoding,
        payload: validation.payload,
      }),
    });
    if (result?.profile?.payload) {
      tabState.fetched = {
        payload: result.profile.payload,
        updatedAt: result.profile.updatedAt,
        version: result.profile.version,
      };
      tabState.draft = draftFromPayload(result.profile.payload, currentAddress());
      tabState.fetchedAt = Date.now();
    }
    tabState.formBanner = { tone: 'success', message: payload.discoverable
      ? 'Profile published. Your per-wallet URL is now live.'
      : 'Profile saved as hidden. Toggle Discoverable on to publish.' };
  } catch (error) {
    tabState.formBanner = { tone: 'error', message: humanizeError(error) };
  }
  tabState.formBusy = false;
  updateBody();
}

async function takedownProfile(): Promise<void> {
  if (tabState.formBusy) return;
  if (!cloudWalletAvailable()) {
    tabState.formBanner = { tone: 'error', message: 'Connect your wallet first.' };
    updateBody();
    return;
  }
  tabState.formBusy = 'takedown';
  tabState.formBanner = undefined;
  updateBody();
  try {
    const intent = await cloudWalletRequest<ProfileIntentResponse>(PROFILE_INTENT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'takedown' }),
    });
    const signed = await cloudWalletSignMessage(intent.message, 'Take down payment profile');
    const result = await cloudWalletRequest<ProfileWriteResponse>(PROFILE_WRITE_PATH, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: intent.walletAddress,
        nonce: intent.nonce,
        message: intent.message,
        signature: signed.signature,
        domain: intent.domain,
        issuedAt: intent.issuedAt,
        expiresAt: intent.expiresAt,
        signatureEncoding: signed.encoding,
      }),
    });
    if (result?.profile?.payload) {
      tabState.fetched = {
        payload: result.profile.payload,
        updatedAt: result.profile.updatedAt,
        version: result.profile.version,
      };
      tabState.draft = draftFromPayload(result.profile.payload, currentAddress());
      tabState.fetchedAt = Date.now();
    }
    tabState.formBanner = { tone: 'success', message: 'Profile taken down. Your per-wallet URL now returns 404.' };
  } catch (error) {
    tabState.formBanner = { tone: 'error', message: humanizeError(error) };
  }
  tabState.formBusy = false;
  updateBody();
}

function humanizeError(error: unknown): string {
  if (!error) return 'Profile update failed.';
  if (error instanceof Error) return error.message;
  return String(error);
}

function tryDemoAgentPayment(): void {
  if (typeof document === 'undefined') return;
  const subtab = document.querySelector<HTMLButtonElement>('[data-agent-protocols-subtab="external-agents"]');
  subtab?.click();
  requestAnimationFrame(() => {
    document.querySelector<HTMLButtonElement>('[data-external-agents-demo]')?.click();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const actionButton = target.closest<HTMLButtonElement>('[data-profile-action]');
    if (actionButton) {
      const action = actionButton.dataset.profileAction;
      switch (action) {
        case 'refresh':
          event.preventDefault();
          void fetchAgentProfile();
          return;
        case 'save':
          event.preventDefault();
          void publishProfile();
          return;
        case 'takedown':
          event.preventDefault();
          void takedownProfile();
          return;
        case 'try-demo':
          event.preventDefault();
          tryDemoAgentPayment();
          return;
        default:
          return;
      }
    }

    const tokenChip = target.closest<HTMLButtonElement>('[data-profile-chip-token]');
    if (tokenChip) {
      event.preventDefault();
      const token = tokenChip.dataset.profileChipToken as AllowedProfileToken | undefined;
      if (!token) return;
      setDraft('acceptedTokens', toggleSetMember(tabState.draft.acceptedTokens, token));
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'acceptedTokens');
      updateBody();
      return;
    }

    const protocolChip = target.closest<HTMLButtonElement>('[data-profile-chip-protocol]');
    if (protocolChip) {
      event.preventDefault();
      const protocol = protocolChip.dataset.profileChipProtocol as AllowedProfileProtocol | undefined;
      if (!protocol) return;
      setDraft('protocols', toggleSetMember(tabState.draft.protocols, protocol));
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'protocols');
      updateBody();
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.profileToggle === 'discoverable') {
      setDraft('discoverable', target.checked);
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'discoverable');
      updateBody();
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = target.dataset.profileField;
    if (field === 'displayName') {
      setDraft('displayName', target.value);
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'displayName');
    } else if (field === 'contactEmail') {
      setDraft('contactEmail', target.value);
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'contactEmail');
    }
  });
}

export function renderAgentCardPanel(): string {
  if (tabState.status === 'idle' && !kickoffScheduled) {
    kickoffScheduled = true;
    Promise.resolve().then(() => {
      kickoffScheduled = false;
      void fetchAgentProfile();
    });
  }
  return panelHtml();
}

export function __resetTabStateForTests(next?: Partial<TabState>): void {
  tabState.status = next?.status ?? 'idle';
  tabState.errorMessage = next?.errorMessage;
  tabState.fetchedAt = next?.fetchedAt;
  tabState.fetched = next?.fetched;
  tabState.draft = next?.draft ?? createBlankDraft();
  tabState.formBusy = next?.formBusy ?? false;
  tabState.formBanner = next?.formBanner;
  tabState.fieldErrors = next?.fieldErrors ?? [];
  kickoffScheduled = false;
}

export function __getTabStateForTests(): Readonly<TabState> {
  return {
    status: tabState.status,
    errorMessage: tabState.errorMessage,
    fetchedAt: tabState.fetchedAt,
    fetched: tabState.fetched,
    draft: tabState.draft,
    formBusy: tabState.formBusy,
    formBanner: tabState.formBanner,
    fieldErrors: tabState.fieldErrors,
  };
}
