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
import { getMppConfig, putMppConfig, type MppConfigPreferencePayload, type MppConfigResponse } from '../mppClient.js';
import { t, tf } from '../demo-i18n/uiLang.js';
import { renderUseCaseDisclosure } from './useCases.js';

const PROFILE_PATH = '/api/preferences/agent-payment-profile';
const PROFILE_INTENT_PATH = '/api/agents/profile-intent';
const PROFILE_WRITE_PATH = '/api/agents/profile';
const BODY_ELEMENT_ID = 'dev-agent-card-body';

type FetchStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'error';
type FormBusy = false | 'publish' | 'takedown';
type MppConfigBusy = false | 'save';

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

interface MppConfigDraft {
  acceptedRails: string;
  maxChallengeAmount: string;
  allowedMints: string;
  allowedOrigins: string;
  allowedMerchantIds: string;
  allowedMerchantOrigins: string;
  allowedMerchantUrls: string;
  allowedResourceOrigins: string;
  allowedResourceUrls: string;
  allowedRecipients: string;
  requireSettlementConfirmed: boolean;
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
  mppConfig?: MppConfigResponse;
  mppConfigDraft: MppConfigDraft;
  mppConfigBusy: MppConfigBusy;
  mppConfigBanner?: FormBanner;
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
  mppConfigDraft: createBlankMppConfigDraft(),
  mppConfigBusy: false,
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

function createBlankMppConfigDraft(): MppConfigDraft {
  return {
    acceptedRails: 'usdc',
    maxChallengeAmount: '10',
    allowedMints: '',
    allowedOrigins: '',
    allowedMerchantIds: '',
    allowedMerchantOrigins: '',
    allowedMerchantUrls: '',
    allowedResourceOrigins: '',
    allowedResourceUrls: '',
    allowedRecipients: '',
    requireSettlementConfirmed: false,
  };
}

function defaultDisplayNameFor(address: string | null): string {
  if (!address) return t('My Agentic Wallet');
  return tf('Wallet {address}', { address: shortAddress(address) });
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

function mppDraftFromConfig(config: MppConfigResponse | undefined): MppConfigDraft {
  const blank = createBlankMppConfigDraft();
  if (!config) return blank;
  return {
    acceptedRails: (config.acceptedRails?.length ? config.acceptedRails : ['usdc']).join(', '),
    maxChallengeAmount: config.maxChallengeAmount ?? blank.maxChallengeAmount,
    allowedMints: (config.allowedMints ?? []).join('\n'),
    allowedOrigins: (config.sessionPolicy?.allowedOrigins ?? []).join('\n'),
    allowedMerchantIds: (config.sessionPolicy?.allowedMerchantIds ?? []).join('\n'),
    allowedMerchantOrigins: (config.sessionPolicy?.allowedMerchantOrigins ?? []).join('\n'),
    allowedMerchantUrls: (config.sessionPolicy?.allowedMerchantUrls ?? []).join('\n'),
    allowedResourceOrigins: (config.sessionPolicy?.allowedResourceOrigins ?? []).join('\n'),
    allowedResourceUrls: (config.sessionPolicy?.allowedResourceUrls ?? []).join('\n'),
    allowedRecipients: (config.sessionPolicy?.allowedRecipients ?? []).join('\n'),
    requireSettlementConfirmed: config.sessionPolicy?.requireSettlementConfirmed === true,
  };
}

function mppConfigPayloadFromDraft(draft: MppConfigDraft): MppConfigPreferencePayload {
  const acceptedRails = commaList(draft.acceptedRails);
  const allowedMints = lineList(draft.allowedMints);
  const allowedOrigins = lineList(draft.allowedOrigins);
  const allowedMerchantIds = lineList(draft.allowedMerchantIds);
  const allowedMerchantOrigins = lineList(draft.allowedMerchantOrigins);
  const allowedMerchantUrls = lineList(draft.allowedMerchantUrls);
  const allowedResourceOrigins = lineList(draft.allowedResourceOrigins);
  const allowedResourceUrls = lineList(draft.allowedResourceUrls);
  const allowedRecipients = lineList(draft.allowedRecipients);
  return {
    acceptedRails: acceptedRails.length ? acceptedRails : ['usdc'],
    ...(draft.maxChallengeAmount.trim() ? { maxChallengeAmount: draft.maxChallengeAmount.trim() } : {}),
    ...(allowedMints.length ? { allowedMints } : {}),
    sessionPolicy: {
      ...(allowedOrigins.length ? { allowedOrigins } : {}),
      ...(allowedMerchantIds.length ? { allowedMerchantIds } : {}),
      ...(allowedMerchantOrigins.length ? { allowedMerchantOrigins } : {}),
      ...(allowedMerchantUrls.length ? { allowedMerchantUrls } : {}),
      ...(allowedResourceOrigins.length ? { allowedResourceOrigins } : {}),
      ...(allowedResourceUrls.length ? { allowedResourceUrls } : {}),
      ...(allowedRecipients.length ? { allowedRecipients } : {}),
      ...(draft.requireSettlementConfirmed ? { requireSettlementConfirmed: true } : {}),
    },
  };
}

function commaList(value: string): string[] {
  return value.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function lineList(value: string): string[] {
  return value.split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
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
      return t('Discoverable');
    case 'hidden':
      return t('Hidden');
    case 'unpublished':
    default:
      return t('Not published');
  }
}

function statusBadgeHtml(): string {
  switch (tabState.status) {
    case 'loading':
      return `<span class="dev-agent-card-status">${t('Checking…')}</span>`;
    case 'loaded': {
      const status = profileSummaryStatus();
      if (status === 'discoverable') {
        return `<span class="dev-agent-card-status dev-agent-card-status--ok">${tf('Live · {time}', { time: escapeHtml(formatTime(tabState.fetchedAt)) })}</span>`;
      }
      if (status === 'hidden') {
        return `<span class="dev-agent-card-status dev-agent-card-status--pending">${t('Hidden')}</span>`;
      }
      return `<span class="dev-agent-card-status dev-agent-card-status--pending">${t('Not published')}</span>`;
    }
    case 'unavailable':
      return `<span class="dev-agent-card-status dev-agent-card-status--pending">${t('Unavailable')}</span>`;
    case 'error':
      return `<span class="dev-agent-card-status dev-agent-card-status--error">${t('Check failed')}</span>`;
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
    <label class="dev-agent-card-discoverable-row dev-agent-card-form-toggle">
      <input
        type="checkbox"
        class="dev-agent-card-switch-input"
        data-profile-toggle="discoverable"
        ${checked}
      />
      <span class="dev-agent-card-discoverable-copy">
        <strong>${t('Discoverable')}</strong>
        <em>${t('Let compatible apps fetch this wallet\'s payment profile URL.')}</em>
      </span>
      <span class="dev-agent-card-switch-control" aria-hidden="true"><span></span></span>
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
    <div class="dev-agent-card-form-field dev-agent-card-form-field--tokens">
      <label class="dev-agent-card-form-label" for="dev-agent-card-tokens">${t('Accepted tokens')}</label>
      <p class="dev-agent-card-form-help">${t('Pick what you\'ll take when an agent or merchant pays you.')}</p>
      <div class="dev-agent-card-chip-row" id="dev-agent-card-tokens">${chips}</div>
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderProtocolChips(): string {
  const error = fieldErrorFor('protocols');
  const labels: Record<AllowedProfileProtocol, string> = {
    ap2: t('AP2 Inbound'),
    acp: t('ACP Checkout'),
    a2a: t('A2A Discovery'),
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
    <div class="dev-agent-card-form-field dev-agent-card-form-field--protocols">
      <label class="dev-agent-card-form-label" for="dev-agent-card-protocols">${t('Protocols')}</label>
      <p class="dev-agent-card-form-help">${t('Which agent standards you speak. Most users keep all three on.')}</p>
      <div class="dev-agent-card-chip-row" id="dev-agent-card-protocols">${chips}</div>
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderDisplayNameField(): string {
  const error = fieldErrorFor('displayName');
  return `
    <div class="dev-agent-card-form-field dev-agent-card-form-field--display-name">
      <label class="dev-agent-card-form-label" for="dev-agent-card-display-name">${t('Display name')}</label>
      <input
        type="text"
        id="dev-agent-card-display-name"
        class="dev-agent-card-form-input"
        data-profile-field="displayName"
        value="${escapeHtml(tabState.draft.displayName)}"
        maxlength="64"
        placeholder="${escapeHtml(t('Mathew\'s Wallet'))}"
        autocomplete="off"
      />
      ${error ? `<p class="dev-agent-card-form-error">${escapeHtml(error)}</p>` : ''}
    </div>
  `;
}

function renderContactEmailField(): string {
  const error = fieldErrorFor('contactEmail');
  return `
    <div class="dev-agent-card-form-field dev-agent-card-form-field--contact">
      <label class="dev-agent-card-form-label" for="dev-agent-card-contact-email">${t('Contact email')} <em>${t('(optional)')}</em></label>
      <input
        type="email"
        id="dev-agent-card-contact-email"
        class="dev-agent-card-form-input"
        data-profile-field="contactEmail"
        value="${escapeHtml(tabState.draft.contactEmail)}"
        maxlength="254"
        placeholder="${escapeHtml(t('you@example.com'))}"
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
  const saveLabel = busy === 'publish' ? t('Saving…') : t('Save profile');
  const takedownLabel = busy === 'takedown' ? t('Taking down…') : t('Take profile down');
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
      <span class="dev-agent-card-form-hint">${t('Validation runs before any wallet signature is requested.')}</span>
    </div>
  `;
}

function renderFormSection(): string {
  const onboarding = profileSummaryStatus() === 'unpublished'
    ? `<p class="dev-agent-card-form-onboard">${t('Your wallet isn\'t discoverable yet. Edit below, then toggle Discoverable on and Save to publish.')}</p>`
    : '';
  return `
    <section class="dev-agent-card-section dev-agent-card-form-section" aria-label="${escapeHtml(t('Edit your payment profile'))}">
      <div class="dev-agent-card-section-head">
        <span>${t('Edit your payment profile')}</span>
        <h3>${t('Control what agents see when they pay you')}</h3>
      </div>
      ${onboarding}
      ${renderFormBanner()}
      <div class="dev-agent-card-form-grid">
        ${renderToggleRow()}
        ${renderDisplayNameField()}
        ${renderContactEmailField()}
        ${renderTokenChips()}
        ${renderProtocolChips()}
      </div>
      ${renderFormActions()}
    </section>
  `;
}

function renderMppConfigBanner(): string {
  if (!tabState.mppConfigBanner) return '';
  const cls = tabState.mppConfigBanner.tone === 'success'
    ? 'dev-agent-card-form-banner dev-agent-card-form-banner--ok'
    : 'dev-agent-card-form-banner dev-agent-card-form-banner--err';
  return `<p class="${cls}">${escapeHtml(tabState.mppConfigBanner.message)}</p>`;
}

function renderMppPolicySection(): string {
  const draft = tabState.mppConfigDraft;
  const busy = tabState.mppConfigBusy === 'save';
  return `
    <section class="dev-agent-card-section dev-agent-card-mpp-policy" aria-label="${escapeHtml(t('MPP session payment policy'))}">
      <div class="dev-agent-card-section-head">
        <span>${t('MPP session rail')}</span>
        <h3>${t('Bounded spend for incoming MPP challenges')}</h3>
      </div>
      ${renderMppConfigBanner()}
      <div class="dev-agent-card-form-grid dev-agent-card-mpp-grid">
        <div class="dev-agent-card-form-field">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-rails">${t('Accepted rails')}</label>
          <input
            type="text"
            id="dev-agent-card-mpp-rails"
            class="dev-agent-card-form-input"
            data-mpp-policy-field="acceptedRails"
            value="${escapeHtml(draft.acceptedRails)}"
            autocomplete="off"
          />
        </div>
        <div class="dev-agent-card-form-field">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-max">${t('Max challenge amount')}</label>
          <input
            type="text"
            id="dev-agent-card-mpp-max"
            class="dev-agent-card-form-input"
            data-mpp-policy-field="maxChallengeAmount"
            value="${escapeHtml(draft.maxChallengeAmount)}"
            inputmode="decimal"
            autocomplete="off"
          />
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-origins">${t('Shared origins')}</label>
          <textarea
            id="dev-agent-card-mpp-origins"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedOrigins"
            rows="3"
          >${escapeHtml(draft.allowedOrigins)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-merchant-ids">${t('Allowed merchant ids')}</label>
          <textarea
            id="dev-agent-card-mpp-merchant-ids"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedMerchantIds"
            rows="2"
          >${escapeHtml(draft.allowedMerchantIds)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-merchant-origins">${t('Merchant origins')}</label>
          <textarea
            id="dev-agent-card-mpp-merchant-origins"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedMerchantOrigins"
            rows="2"
          >${escapeHtml(draft.allowedMerchantOrigins)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-resource-origins">${t('Resource origins')}</label>
          <textarea
            id="dev-agent-card-mpp-resource-origins"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedResourceOrigins"
            rows="2"
          >${escapeHtml(draft.allowedResourceOrigins)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-merchant-urls">${t('Merchant URLs')}</label>
          <textarea
            id="dev-agent-card-mpp-merchant-urls"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedMerchantUrls"
            rows="2"
          >${escapeHtml(draft.allowedMerchantUrls)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-resource-urls">${t('Resource URLs')}</label>
          <textarea
            id="dev-agent-card-mpp-resource-urls"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedResourceUrls"
            rows="2"
          >${escapeHtml(draft.allowedResourceUrls)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-recipients">${t('Allowed recipients')}</label>
          <textarea
            id="dev-agent-card-mpp-recipients"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedRecipients"
            rows="3"
          >${escapeHtml(draft.allowedRecipients)}</textarea>
        </div>
        <div class="dev-agent-card-form-field dev-agent-card-form-field--wide">
          <label class="dev-agent-card-form-label" for="dev-agent-card-mpp-mints">${t('Allowed SPL mints')}</label>
          <textarea
            id="dev-agent-card-mpp-mints"
            class="dev-agent-card-form-input dev-agent-card-form-textarea"
            data-mpp-policy-field="allowedMints"
            rows="2"
          >${escapeHtml(draft.allowedMints)}</textarea>
        </div>
        <label class="dev-agent-card-discoverable-row dev-agent-card-form-toggle">
          <input
            type="checkbox"
            class="dev-agent-card-switch-input"
            data-mpp-policy-toggle="requireSettlementConfirmed"
            ${draft.requireSettlementConfirmed ? 'checked' : ''}
          />
          <span class="dev-agent-card-discoverable-copy">
            <strong>${t('Require settlement confirmation')}</strong>
            <em>${t('MPP receipts stay pending until streaming voucher settlement confirms on chain.')}</em>
          </span>
          <span class="dev-agent-card-switch-control" aria-hidden="true"><span></span></span>
        </label>
      </div>
      <div class="dev-agent-card-form-actions">
        <button type="button" class="button primary" data-profile-action="save-mpp-policy" ${busy ? 'disabled' : ''}>${busy ? t('Saving…') : t('Save MPP policy')}</button>
        <span class="dev-agent-card-form-hint">${t('Incoming Requests uses this policy before showing Pay with Session.')}</span>
      </div>
    </section>
  `;
}

function renderProfileLinkSection(address: string | null): string {
  const url = perWalletUrl(address);
  const status = profileSummaryStatus();
  if (!url) return '';
  if (status !== 'discoverable') {
    return `
      <section class="dev-agent-card-section dev-agent-card-link-section dev-agent-card-link-section--disabled" aria-label="${escapeHtml(t('Profile link'))}">
        <div class="dev-agent-card-section-head">
          <span>${t('Profile link')}</span>
          <h3>${t('Where compatible apps will discover this wallet')}</h3>
        </div>
        <code class="dev-agent-card-url dev-agent-card-url--disabled">${escapeHtml(url)}</code>
        <p class="dev-agent-card-form-help">${t('Toggle Discoverable on and Save to publish this link.')}</p>
      </section>
    `;
  }
  return `
    <section class="dev-agent-card-section dev-agent-card-link-section" aria-label="${escapeHtml(t('Profile link'))}">
      <div class="dev-agent-card-section-head">
        <span>${t('Profile link')}</span>
        <h3>${t('Where compatible apps discover this wallet')}</h3>
      </div>
      <code class="dev-agent-card-url">${escapeHtml(url)}</code>
      <div class="dev-agent-card-link-actions">
        <button
          type="button"
          class="button utility"
          data-copy="${escapeHtml(url)}"
          data-copy-id="dev-agent-card-profile-link"
          data-copy-name="${escapeHtml(t('Payment profile link'))}"
        >${t('Copy profile link')}</button>
        <a class="button-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${t('Open profile')}</a>
      </div>
    </section>
  `;
}

function renderDemoLink(): string {
  return `
    <section class="dev-agent-card-section dev-agent-card-demo-link" aria-label="${escapeHtml(t('Try a sample agent payment'))}">
      <div>
        <h3>${t('Want to see this in action?')}</h3>
        <p>${t('Switch to Incoming Requests and queue a demo agent payment against this profile.')}</p>
      </div>
      <button type="button" class="button primary" data-profile-action="try-demo">
        ${t('Try a sample agent payment →')}
      </button>
    </section>
  `;
}

function renderExplainer(): string {
  return `
    <details class="panel public-request-context dev-agent-card-explainer">
      <summary>${t('What\'s a payment profile?')}</summary>
      <p class="dev-agent-card-explainer-lede">
        ${t('A wallet address says')} <em>${t('where')}</em> ${t('to send money. A payment profile says')} <em>${t('how')}</em>.
      </p>
      <p>
        ${t('Address = phone number (44 chars, opaque). Profile = contact card with display name, accepted tokens, supported protocols, and an "always review" rule. It\'s the same idea as PayPal.me or a Stripe payment link, published at')} <code>/agents/&lt;wallet&gt;/card.json</code> ${t('so AI agents and merchant checkouts can fetch it automatically.')}
      </p>
      <div class="dev-agent-card-explainer-grid">
        <article>
          <h4>${t('Without a profile')}</h4>
          <p>${t('The external agent has to be hand-told your address, the token you accept, and the protocol you speak. Friction every time.')}</p>
        </article>
        <article>
          <h4>${t('With a profile')}</h4>
          <p>${t('The agent fetches your URL, gets address + tokens + protocols in one round-trip, builds the right mandate, drops it in your inbox.')}</p>
        </article>
      </div>
      <h4>${t('When it matters')}</h4>
      <ul>
        <li>${t('An AI agent (OpenAI Operator, Vercel AI, Google Agent Builder) is paying you autonomously.')} <strong>${t('AP2')}</strong>.</li>
        <li>${t('A merchant checkout (Stripe ACP) is routing payment to a non-custodial wallet.')} <strong>${t('ACP')}</strong>.</li>
        <li>${t('Another agent\'s wallet wants to discover yours programmatically.')} <strong>${t('A2A')}</strong>.</li>
        <li>${t('You want a stable, shareable URL that\'s friendlier than')} <code>4fTq…MoHd</code>.</li>
      </ul>
      <h4>${t('When it doesn\'t')}</h4>
      <ul>
        <li>${t('Human paying human → just paste the address.')}</li>
        <li>${t('One-off transfer from someone who already has your address.')}</li>
      </ul>
      <p class="dev-agent-card-explainer-foot">
        ${t('The profile is an opt-in layer on top of your wallet. Toggle "Discoverable" off any time to take it down.')}
      </p>
    </details>
  `;
}

function routeCardHtml(): string {
  const status = statusBadgeHtml() || `<span class="dev-agent-card-status dev-agent-card-status--idle">${t('Ready')}</span>`;
  const address = currentAddress();
  const summary = profileSummaryStatus();
  const protocolText = summary === 'discoverable' && tabState.fetched?.payload
    ? tabState.fetched.payload.protocols.map((p) => p.toUpperCase()).join(' · ')
    : tabState.draft.protocols.size > 0
      ? Array.from(tabState.draft.protocols).map((p) => p.toUpperCase()).join(' · ')
      : '-';
  return `
    <aside class="dev-agent-card-route-card" aria-label="${escapeHtml(t('Agent profile status'))}">
      <div class="dev-agent-card-status-head">
        <span>${t('Profile status')}</span>
        <strong>${escapeHtml(statusHeadline())}</strong>
      </div>
      <div class="dev-agent-card-route-body">
        <div>
          <span>${t('Wallet')}</span>
          <strong>${address ? escapeHtml(shortAddress(address)) : t('Not connected')}</strong>
        </div>
        <div>
          <span>${t('Requests')}</span>
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
    return `<p class="dev-agent-card-empty dev-tab-loading-state">${t('Loading your payment profile…')}</p>`;
  }
  if (tabState.status === 'unavailable') {
    return `
      <div class="dev-agent-card-empty-state">
        <p class="dev-agent-card-empty dev-tab-empty-state">
          ${t('Sign in to Agentic Cloud to manage this wallet\'s payment profile. Connect your wallet and complete the cloud sign-in challenge, then return here.')}
        </p>
        <button type="button" class="button utility" data-profile-action="refresh">${t('Retry')}</button>
      </div>
    `;
  }
  if (tabState.status === 'error') {
    return `
      <div class="dev-agent-card-empty-state">
        <p class="dev-agent-card-empty dev-tab-empty-state">${tf('Could not load profile: {error}', { error: escapeHtml(tabState.errorMessage ?? t('Unknown error')) })}</p>
        <button type="button" class="button utility" data-profile-action="refresh">${t('Retry')}</button>
      </div>
    `;
  }
  const address = currentAddress();
  return `
    ${renderFormSection()}
    ${renderMppPolicySection()}
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
          <p class="dev-agent-card-eyebrow dev-tab-kicker">${t('Agent payments profile')}</p>
          <div class="dev-tab-title-row">
            <h2>${t('Payment Profile')}</h2>
            <span class="dev-agent-card-identity-pill">${t('Approval required')}</span>
          </div>
          <p>
            ${t('Let compatible apps find this wallet and send payment requests. Every request still needs wallet approval.')}
          </p>
          <div class="dev-agent-card-actions dev-tab-actions">
            <button type="button" class="button utility" data-profile-action="refresh">${t('Refresh')}</button>
          </div>
        </div>
        ${routeCardHtml()}
      </header>
      ${renderUseCaseDisclosure({
        id: 'agent-payments-profile',
        summary: t('When another app or agent needs to know where payment requests should go.'),
        useCases: [
          {
            title: t('Receive an invoice from an agent'),
            body: t('A booking or research agent can find this wallet profile and send the payment request to the right address instead of asking you to paste it.'),
          },
          {
            title: t('Let checkout apps route carts here'),
            body: t('A compatible merchant app can use your profile to create a readable checkout request that lands in your wallet for review.'),
          },
          {
            title: t('Stay in control before anything signs'),
            body: t('Publishing the profile only makes the wallet discoverable. Every payment request still waits for your wallet approval.'),
          },
        ],
      })}
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
    const mppConfig = await getMppConfig().catch(() => undefined);
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
    if (mppConfig) {
      tabState.mppConfig = mppConfig;
      tabState.mppConfigDraft = mppDraftFromConfig(mppConfig);
      tabState.mppConfigBanner = undefined;
    }
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
    statusSlot.innerHTML = statusBadgeHtml() || `<span class="dev-agent-card-status dev-agent-card-status--idle">${t('Ready')}</span>`;
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
    tabState.formBanner = { tone: 'error', message: t('Connect your wallet first.') };
    updateBody();
    return;
  }
  const payload = payloadFromDraft(tabState.draft);
  const validation = validateProfilePayload(payload);
  if (!validation.ok) {
    tabState.fieldErrors = validation.errors;
    tabState.formBanner = { tone: 'error', message: t('Fix the highlighted fields and try again.') };
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
    const signed = await cloudWalletSignMessage(intent.message, t('Publish payment profile'));
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
        proofEncoding: signed.proofEncoding,
        proofTxBase64: signed.proofTxBase64,
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
      ? t('Profile published. Your per-wallet URL is now live.')
      : t('Profile saved as hidden. Toggle Discoverable on to publish.') };
  } catch (error) {
    tabState.formBanner = { tone: 'error', message: humanizeError(error) };
  }
  tabState.formBusy = false;
  updateBody();
}

async function takedownProfile(): Promise<void> {
  if (tabState.formBusy) return;
  if (!cloudWalletAvailable()) {
    tabState.formBanner = { tone: 'error', message: t('Connect your wallet first.') };
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
    const signed = await cloudWalletSignMessage(intent.message, t('Take down payment profile'));
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
        proofEncoding: signed.proofEncoding,
        proofTxBase64: signed.proofTxBase64,
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
    tabState.formBanner = { tone: 'success', message: t('Profile taken down. Your per-wallet URL now returns 404.') };
  } catch (error) {
    tabState.formBanner = { tone: 'error', message: humanizeError(error) };
  }
  tabState.formBusy = false;
  updateBody();
}

async function saveMppPolicy(): Promise<void> {
  if (tabState.mppConfigBusy) return;
  tabState.mppConfigBusy = 'save';
  tabState.mppConfigBanner = undefined;
  updateBody();
  const payload = mppConfigPayloadFromDraft(tabState.mppConfigDraft);
  try {
    const saved = await putMppConfig(payload);
    tabState.mppConfig = saved.payload ?? payload;
    tabState.mppConfigDraft = mppDraftFromConfig(tabState.mppConfig);
    tabState.mppConfigBanner = { tone: 'success', message: t('MPP policy saved.') };
  } catch (error) {
    tabState.mppConfigBanner = { tone: 'error', message: humanizeError(error) };
  }
  tabState.mppConfigBusy = false;
  updateBody();
}

function humanizeError(error: unknown): string {
  if (!error) return t('Profile update failed.');
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
        case 'save-mpp-policy':
          event.preventDefault();
          void saveMppPolicy();
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
    } else if (target instanceof HTMLInputElement && target.dataset.mppPolicyToggle === 'requireSettlementConfirmed') {
      tabState.mppConfigDraft = {
        ...tabState.mppConfigDraft,
        requireSettlementConfirmed: target.checked,
      };
      tabState.mppConfigBanner = undefined;
      updateBody();
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    const field = target instanceof HTMLInputElement ? target.dataset.profileField : undefined;
    if (field === 'displayName') {
      setDraft('displayName', target.value);
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'displayName');
    } else if (field === 'contactEmail') {
      setDraft('contactEmail', target.value);
      tabState.fieldErrors = tabState.fieldErrors.filter((entry) => entry.field !== 'contactEmail');
    }
    const mppField = target.dataset.mppPolicyField as keyof MppConfigDraft | undefined;
    if (mppField && mppField !== 'requireSettlementConfirmed') {
      tabState.mppConfigDraft = {
        ...tabState.mppConfigDraft,
        [mppField]: target.value,
      };
      tabState.mppConfigBanner = undefined;
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
  tabState.mppConfig = next?.mppConfig;
  tabState.mppConfigDraft = next?.mppConfigDraft ?? createBlankMppConfigDraft();
  tabState.mppConfigBusy = next?.mppConfigBusy ?? false;
  tabState.mppConfigBanner = next?.mppConfigBanner;
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
    mppConfig: tabState.mppConfig,
    mppConfigDraft: tabState.mppConfigDraft,
    mppConfigBusy: tabState.mppConfigBusy,
    mppConfigBanner: tabState.mppConfigBanner,
  };
}
