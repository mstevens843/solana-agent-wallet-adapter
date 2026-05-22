// Pure controller for the embedded Agentic Wallet overlay.
//
// This module owns:
//   - the overlay state shape
//   - all form-input validation (no `<input>` access; just string args)
//   - the state reducer (open / setField / setTab / submitStart / submitSuccess
//     / submitError / close / togglePhraseRevealed / acknowledgePhraseSaved)
//   - the HTML factory that renders the overlay markup for a given state
//
// No DOM, no Tauri, no side effects. Everything is testable via vitest.
// `main.ts` owns the state object and the IPC calls — this module just maps
// (state, action) → state and (state) → string HTML.

export type EmbeddedWalletOverlayMode =
  | 'closed'
  | 'create'
  | 'import'
  | 'show-phrase'
  | 'unlock'
  | 'reset-confirm';

export interface EmbeddedWalletOverlayDraft {
  password: string;
  confirm: string;
  mnemonic: string;
}

export interface EmbeddedWalletOverlayState {
  mode: EmbeddedWalletOverlayMode;
  /** True while an IPC call is in flight; disables submit. */
  busy: boolean;
  /** Inline error rendered under the form ("" when none). */
  error: string;
  /** Live form values, persisted across reducer actions. */
  draft: EmbeddedWalletOverlayDraft;
  /**
   * Only set in `show-phrase` mode — the 24-word phrase returned by
   * `wallet_create`. Cleared on close so it never persists past that view.
   */
  createdMnemonic: string;
  /** Whether the user has clicked "reveal" to see the phrase. */
  phraseRevealed: boolean;
  /** Whether the user has ticked the "I've saved these words" checkbox. */
  phraseSavedAcknowledged: boolean;
}

export const MIN_PASSWORD_LENGTH = 8;
export const ALLOWED_MNEMONIC_WORD_COUNTS = [12, 24] as const;

export function initialEmbeddedWalletOverlayState(): EmbeddedWalletOverlayState {
  return {
    mode: 'closed',
    busy: false,
    error: '',
    draft: { password: '', confirm: '', mnemonic: '' },
    createdMnemonic: '',
    phraseRevealed: false,
    phraseSavedAcknowledged: false,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Validators (pure)
// ────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  error: string;
}

export function validateCreate(input: {
  password: string;
  confirm: string;
}): ValidationResult {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (input.password !== input.confirm) {
    return { ok: false, error: 'Passwords do not match.' };
  }
  return { ok: true, error: '' };
}

export function validateImport(input: {
  mnemonic: string;
  password: string;
  confirm: string;
}): ValidationResult {
  const words = input.mnemonic.trim().split(/\s+/).filter(Boolean);
  if (!ALLOWED_MNEMONIC_WORD_COUNTS.includes(words.length as 12 | 24)) {
    return {
      ok: false,
      error: 'Recovery phrase must be 12 or 24 words.',
    };
  }
  const passwordCheck = validateCreate({
    password: input.password,
    confirm: input.confirm,
  });
  if (!passwordCheck.ok) return passwordCheck;
  return { ok: true, error: '' };
}

export function validateUnlock(input: { password: string }): ValidationResult {
  if (input.password.length === 0) {
    return { ok: false, error: 'Enter your password to unlock.' };
  }
  return { ok: true, error: '' };
}

export function validateResetConfirm(input: { password: string }): ValidationResult {
  return validateUnlock(input);
}

// ────────────────────────────────────────────────────────────────────────
// Reducer
// ────────────────────────────────────────────────────────────────────────

export type EmbeddedWalletOverlayAction =
  | { type: 'open'; mode: Exclude<EmbeddedWalletOverlayMode, 'closed' | 'show-phrase'> }
  | { type: 'setTab'; mode: 'create' | 'import' }
  | { type: 'setField'; name: keyof EmbeddedWalletOverlayDraft; value: string }
  | { type: 'submitStart' }
  | { type: 'submitSuccessCreated'; mnemonic: string }
  | { type: 'submitSuccessClose' }
  | { type: 'submitError'; error: string }
  | { type: 'togglePhraseRevealed' }
  | { type: 'acknowledgePhraseSaved'; checked: boolean }
  | { type: 'close' };

export function reduceEmbeddedWalletOverlay(
  state: EmbeddedWalletOverlayState,
  action: EmbeddedWalletOverlayAction,
): EmbeddedWalletOverlayState {
  switch (action.type) {
    case 'open':
      // Opening any mode resets transient fields; preserve draft only when
      // re-opening the same mode (e.g., after a transient error caller fixed).
      return {
        ...initialEmbeddedWalletOverlayState(),
        mode: action.mode,
      };

    case 'setTab':
      // Toggling create⟷import keeps the password drafts but clears mnemonic
      // when leaving import (so we don't carry a partial phrase forward).
      return {
        ...state,
        mode: action.mode,
        error: '',
        draft:
          action.mode === 'create'
            ? { ...state.draft, mnemonic: '' }
            : state.draft,
      };

    case 'setField':
      return {
        ...state,
        error: '',
        draft: { ...state.draft, [action.name]: action.value },
      };

    case 'submitStart':
      return { ...state, busy: true, error: '' };

    case 'submitSuccessCreated':
      return {
        ...state,
        busy: false,
        error: '',
        mode: 'show-phrase',
        createdMnemonic: action.mnemonic,
        phraseRevealed: false,
        phraseSavedAcknowledged: false,
        // password drafts cleared for safety
        draft: { password: '', confirm: '', mnemonic: '' },
      };

    case 'submitSuccessClose':
      return initialEmbeddedWalletOverlayState();

    case 'submitError':
      return { ...state, busy: false, error: action.error };

    case 'togglePhraseRevealed':
      if (state.mode !== 'show-phrase') return state;
      return { ...state, phraseRevealed: !state.phraseRevealed };

    case 'acknowledgePhraseSaved':
      if (state.mode !== 'show-phrase') return state;
      return { ...state, phraseSavedAcknowledged: action.checked };

    case 'close':
      return initialEmbeddedWalletOverlayState();
  }
}

// ────────────────────────────────────────────────────────────────────────
// HTML factory
// ────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function tabHeader(activeMode: 'create' | 'import'): string {
  return `
    <div class="embedded-wallet-overlay-tabs" role="tablist" aria-label="Set up Agentic Wallet">
      <button
        type="button"
        role="tab"
        class="embedded-wallet-overlay-tab ${activeMode === 'create' ? 'active' : ''}"
        aria-selected="${activeMode === 'create' ? 'true' : 'false'}"
        data-embedded-wallet-tab="create"
      >Create new</button>
      <button
        type="button"
        role="tab"
        class="embedded-wallet-overlay-tab ${activeMode === 'import' ? 'active' : ''}"
        aria-selected="${activeMode === 'import' ? 'true' : 'false'}"
        data-embedded-wallet-tab="import"
      >Import phrase</button>
    </div>
  `;
}

function errorRow(error: string): string {
  if (!error) return '';
  return `<p class="embedded-wallet-overlay-error" role="alert">${escapeHtml(error)}</p>`;
}

function passwordFields(draft: EmbeddedWalletOverlayDraft, busy: boolean): string {
  return `
    <label class="embedded-wallet-overlay-field">
      <span>New password</span>
      <input
        type="password"
        autocomplete="new-password"
        data-embedded-wallet-field="password"
        value="${escapeHtml(draft.password)}"
        ${busy ? 'disabled' : ''}
        placeholder="At least ${MIN_PASSWORD_LENGTH} characters"
      />
    </label>
    <label class="embedded-wallet-overlay-field">
      <span>Confirm password</span>
      <input
        type="password"
        autocomplete="new-password"
        data-embedded-wallet-field="confirm"
        value="${escapeHtml(draft.confirm)}"
        ${busy ? 'disabled' : ''}
        placeholder="Type it again"
      />
    </label>
  `;
}

function createBody(state: EmbeddedWalletOverlayState): string {
  return `
    ${tabHeader('create')}
    <p class="embedded-wallet-overlay-lede">
      A new 24-word recovery phrase will be generated. Encrypted on this Mac with a password you set, and never leaves the device.
    </p>
    <form data-embedded-wallet-form="create">
      ${passwordFields(state.draft, state.busy)}
      ${errorRow(state.error)}
      <div class="embedded-wallet-overlay-actions">
        <button type="button" class="utility" data-embedded-wallet-action="close" ${state.busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Creating…' : 'Create wallet'}</button>
      </div>
    </form>
  `;
}

function importBody(state: EmbeddedWalletOverlayState): string {
  return `
    ${tabHeader('import')}
    <p class="embedded-wallet-overlay-lede">
      Paste your 12 or 24 word recovery phrase. Encrypted on this Mac under a password you set.
    </p>
    <form data-embedded-wallet-form="import">
      <label class="embedded-wallet-overlay-field">
        <span>Recovery phrase</span>
        <textarea
          rows="3"
          autocomplete="off"
          spellcheck="false"
          data-embedded-wallet-field="mnemonic"
          ${state.busy ? 'disabled' : ''}
          placeholder="word1 word2 word3 …"
        >${escapeHtml(state.draft.mnemonic)}</textarea>
      </label>
      ${passwordFields(state.draft, state.busy)}
      ${errorRow(state.error)}
      <div class="embedded-wallet-overlay-actions">
        <button type="button" class="utility" data-embedded-wallet-action="close" ${state.busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Importing…' : 'Import wallet'}</button>
      </div>
    </form>
  `;
}

function phraseGrid(mnemonic: string, revealed: boolean): string {
  const words = mnemonic.split(/\s+/).filter(Boolean);
  const cells = words.map((word, idx) => `
    <div class="embedded-wallet-overlay-phrase-cell">
      <span class="embedded-wallet-overlay-phrase-index">${idx + 1}</span>
      <span class="embedded-wallet-overlay-phrase-word">${
        revealed ? escapeHtml(word) : '•••••••'
      }</span>
    </div>
  `).join('');
  return `<div class="embedded-wallet-overlay-phrase-grid" aria-hidden="${revealed ? 'false' : 'true'}">${cells}</div>`;
}

function showPhraseBody(state: EmbeddedWalletOverlayState): string {
  return `
    <div class="embedded-wallet-overlay-warning" role="note">
      <strong>Save this recovery phrase.</strong>
      Write down these 24 words in order and store them safely. They are the only way to recover this wallet if you lose your password or this machine.
    </div>
    ${phraseGrid(state.createdMnemonic, state.phraseRevealed)}
    <div class="embedded-wallet-overlay-phrase-tools">
      <button type="button" class="utility" data-embedded-wallet-action="toggle-phrase-revealed">
        ${state.phraseRevealed ? 'Hide phrase' : 'Reveal phrase'}
      </button>
      <button type="button" class="utility" data-embedded-wallet-action="copy-phrase" ${state.phraseRevealed ? '' : 'disabled'}>Copy phrase</button>
    </div>
    <label class="embedded-wallet-overlay-ack">
      <input
        type="checkbox"
        data-embedded-wallet-action="acknowledge-phrase"
        ${state.phraseSavedAcknowledged ? 'checked' : ''}
      />
      <span>I've written down or saved this recovery phrase somewhere safe.</span>
    </label>
    ${errorRow(state.error)}
    <div class="embedded-wallet-overlay-actions">
      <button type="button" class="primary" data-embedded-wallet-action="phrase-continue" ${state.phraseSavedAcknowledged ? '' : 'disabled'}>Continue</button>
    </div>
  `;
}

function unlockBody(state: EmbeddedWalletOverlayState): string {
  return `
    <p class="embedded-wallet-overlay-lede">
      Unlock the Agentic Wallet on this Mac. Auto-locks after idle for security.
    </p>
    <form data-embedded-wallet-form="unlock">
      <label class="embedded-wallet-overlay-field">
        <span>Password</span>
        <input
          type="password"
          autocomplete="current-password"
          data-embedded-wallet-field="password"
          value="${escapeHtml(state.draft.password)}"
          ${state.busy ? 'disabled' : ''}
          placeholder=""
          autofocus
        />
      </label>
      ${errorRow(state.error)}
      <div class="embedded-wallet-overlay-actions">
        <button type="button" class="utility" data-embedded-wallet-action="close" ${state.busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="primary" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Unlocking…' : 'Unlock'}</button>
      </div>
      <p class="embedded-wallet-overlay-footnote">
        Forgot your password?
        <button type="button" class="link" data-embedded-wallet-action="open-reset">Reset wallet</button>
      </p>
    </form>
  `;
}

function resetConfirmBody(state: EmbeddedWalletOverlayState): string {
  return `
    <div class="embedded-wallet-overlay-warning danger" role="note">
      <strong>This deletes your local wallet.</strong>
      Anyone without the 24-word recovery phrase will not be able to recover the funds. Make sure you have your phrase saved before continuing.
    </div>
    <form data-embedded-wallet-form="reset-confirm">
      <label class="embedded-wallet-overlay-field">
        <span>Confirm with current password</span>
        <input
          type="password"
          autocomplete="current-password"
          data-embedded-wallet-field="password"
          value="${escapeHtml(state.draft.password)}"
          ${state.busy ? 'disabled' : ''}
        />
      </label>
      ${errorRow(state.error)}
      <div class="embedded-wallet-overlay-actions">
        <button type="button" class="utility" data-embedded-wallet-action="close" ${state.busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="destructive" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Deleting…' : 'Delete this wallet'}</button>
      </div>
    </form>
  `;
}

/**
 * Returns the overlay markup. Returns the empty string when `mode === 'closed'`
 * so callers can unconditionally concatenate it into the page shell.
 */
export function embeddedWalletOverlayHtml(state: EmbeddedWalletOverlayState): string {
  if (state.mode === 'closed') return '';
  let title = '';
  let body = '';
  switch (state.mode) {
    case 'create':
      title = 'Set up Agentic Wallet';
      body = createBody(state);
      break;
    case 'import':
      title = 'Set up Agentic Wallet';
      body = importBody(state);
      break;
    case 'show-phrase':
      title = 'Recovery phrase';
      body = showPhraseBody(state);
      break;
    case 'unlock':
      title = 'Unlock Agentic Wallet';
      body = unlockBody(state);
      break;
    case 'reset-confirm':
      title = 'Reset wallet';
      body = resetConfirmBody(state);
      break;
  }
  return `
    <div class="embedded-wallet-overlay-scrim" data-embedded-wallet-action="close" aria-hidden="true"></div>
    <aside class="embedded-wallet-overlay" role="dialog" aria-modal="true" aria-labelledby="embedded-wallet-overlay-title">
      <header class="embedded-wallet-overlay-head">
        <h2 id="embedded-wallet-overlay-title">${escapeHtml(title)}</h2>
        <button type="button" class="embedded-wallet-overlay-close" data-embedded-wallet-action="close" aria-label="Close">&times;</button>
      </header>
      <div class="embedded-wallet-overlay-body">
        ${body}
      </div>
    </aside>
  `;
}
