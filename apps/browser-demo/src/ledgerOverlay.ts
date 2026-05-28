// Pure controller for the "Connect Ledger" overlay (Slice G).
//
// State machine:
//   closed → searching → app-check → scanning-addresses → choose-address
//     → confirming-address → closed (after auto-connect)
//   any → error → searching (Retry) | closed (Cancel)
//
// `main.ts` drives the IPC promises and dispatches reducer actions. This
// module is DOM-free + Tauri-free so it can be exercised with vitest.

import {
  ledgerAccountLabel,
  type LedgerAccountCandidate,
} from './ledgerAccounts.js';

export type LedgerOverlayMode =
  | 'closed'
  | 'searching'
  | 'app-check'
  | 'scanning-addresses'
  | 'choose-address'
  | 'confirming-address'
  | 'error';

export interface LedgerOverlayDevice {
  productName: string | null;
  vendorId: number;
  productId: number;
}

export interface LedgerOverlayState {
  mode: LedgerOverlayMode;
  device: LedgerOverlayDevice | null;
  /** Selected derived address shown in `choose-address` and `confirming-address` mode. */
  address: string | null;
  /** Selected derivation path (visible so user knows which account they're connecting). */
  derivationPath: string;
  accounts: LedgerAccountCandidate[];
  accountsExpanded: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  scanProgress: number;
  scanStatus: string;
  error: string;
}

export const DEFAULT_LEDGER_DERIVATION_PATH = "m/44'/501'/0'/0'";

export function initialLedgerOverlayState(): LedgerOverlayState {
  return {
    mode: 'closed',
    device: null,
    address: null,
    derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
    accounts: [],
    accountsExpanded: false,
    canLoadMore: false,
    loadingMore: false,
    scanProgress: 0,
    scanStatus: '',
    error: '',
  };
}

export type LedgerOverlayAction =
  | { type: 'open' }
  | { type: 'deviceFound'; device: LedgerOverlayDevice }
  | { type: 'scanStarted'; status: string; progress?: number }
  | { type: 'scanProgress'; status: string; progress: number }
  | {
      type: 'accountsReady';
      accounts: LedgerAccountCandidate[];
      selectedAddress?: string | null;
      canLoadMore: boolean;
    }
  | { type: 'selectAccount'; address: string }
  | { type: 'toggleAccountsExpanded' }
  | { type: 'loadMoreStarted'; status: string; progress?: number }
  | { type: 'confirmingAddress' }
  | { type: 'setError'; error: string }
  | { type: 'close' };

export function reduceLedgerOverlay(
  state: LedgerOverlayState,
  action: LedgerOverlayAction,
): LedgerOverlayState {
  switch (action.type) {
    case 'open':
      return {
        ...initialLedgerOverlayState(),
        mode: 'searching',
      };
    case 'deviceFound':
      // Allow updating device info while already in any non-closed mode
      // (e.g., user unplugged + re-plugged a different Ledger).
      if (state.mode === 'closed') return state;
      return { ...state, mode: 'app-check', device: action.device, error: '' };
    case 'scanStarted':
      if (state.mode === 'closed') return state;
      return {
        ...state,
        mode: 'scanning-addresses',
        accounts: [],
        address: null,
        derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
        accountsExpanded: false,
        loadingMore: false,
        scanProgress: action.progress ?? 0,
        scanStatus: action.status,
        error: '',
      };
    case 'scanProgress':
      if (state.mode === 'closed') return state;
      return {
        ...state,
        scanProgress: Math.max(0, Math.min(100, action.progress)),
        scanStatus: action.status,
      };
    case 'accountsReady': {
      if (state.mode === 'closed') return state;
      const selected = selectLedgerAccount(action.accounts, action.selectedAddress);
      return {
        ...state,
        mode: 'choose-address',
        accounts: action.accounts,
        address: selected?.address ?? null,
        derivationPath: selected?.derivationPath ?? DEFAULT_LEDGER_DERIVATION_PATH,
        loadingMore: false,
        canLoadMore: action.canLoadMore,
        scanProgress: 100,
        scanStatus: action.accounts.length > 0
          ? `${action.accounts.length} Ledger account${action.accounts.length === 1 ? '' : 's'} found.`
          : 'No Ledger accounts were found.',
        error: '',
      };
    }
    case 'selectAccount': {
      if (state.mode !== 'choose-address') return state;
      const selected = state.accounts.find((account) => account.address === action.address);
      if (!selected) return state;
      return {
        ...state,
        address: selected.address,
        derivationPath: selected.derivationPath,
        error: '',
      };
    }
    case 'toggleAccountsExpanded':
      if (state.mode !== 'choose-address') return state;
      return { ...state, accountsExpanded: !state.accountsExpanded };
    case 'loadMoreStarted':
      if (state.mode !== 'choose-address') return state;
      return {
        ...state,
        loadingMore: true,
        scanProgress: action.progress ?? state.scanProgress,
        scanStatus: action.status,
      };
    case 'confirmingAddress':
      if (state.mode !== 'choose-address' || !state.address) return state;
      return { ...state, mode: 'confirming-address', error: '' };
    case 'setError':
      return { ...state, mode: 'error', error: action.error };
    case 'close':
      return initialLedgerOverlayState();
  }
}

function selectLedgerAccount(
  accounts: readonly LedgerAccountCandidate[],
  preferredAddress?: string | null,
): LedgerAccountCandidate | undefined {
  const preferred = preferredAddress?.trim();
  if (preferred) {
    const match = accounts.find((account) => account.address === preferred);
    if (match) return match;
  }
  return accounts[0];
}

export function ledgerConfirmationRetryState(
  state: LedgerOverlayState,
): LedgerOverlayState | null {
  if (state.mode !== 'error' || !state.address) return null;
  const selected = selectLedgerAccount(state.accounts, state.address);
  if (!selected) return null;
  return {
    ...state,
    mode: 'choose-address',
    address: selected.address,
    derivationPath: selected.derivationPath,
    loadingMore: false,
    error: '',
  };
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

function searchingBody(): string {
  return `
    <p class="ledger-overlay-lede">Plug in your Ledger over USB and unlock it. Open the <strong>Solana</strong> app on the device.</p>
    <div class="ledger-overlay-status" role="status">Looking for a Ledger device…</div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
    </div>
  `;
}

function appCheckBody(state: LedgerOverlayState): string {
  const name = state.device?.productName ?? 'Ledger';
  return `
    <p class="ledger-overlay-lede">Found <strong>${escapeHtml(name)}</strong>. Checking the Solana app and preparing account discovery…</p>
    <div class="ledger-overlay-status" role="status">Talking to the device…</div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
    </div>
  `;
}

function scanningAddressesBody(state: LedgerOverlayState): string {
  const progress = Math.max(0, Math.min(100, Math.round(state.scanProgress)));
  return `
    <ol class="ledger-overlay-steps">
      <li>Connect and unlock your Ledger device</li>
      <li>Open the Solana app on your Ledger device</li>
      <li>Keep the device connected while addresses are retrieved</li>
      <li>Choose the Ledger account you want to use</li>
    </ol>
    <div class="ledger-overlay-progress-row">
      <span>Progress</span>
      <strong>${progress}%</strong>
    </div>
    <div class="ledger-overlay-progress" aria-hidden="true">
      <span style="width: ${progress}%"></span>
    </div>
    <div class="ledger-overlay-status" role="status">
      <span class="toast-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(state.scanStatus || 'Retrieving addresses…')}</span>
    </div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
    </div>
  `;
}

type LedgerOverlaySurface = 'desktop' | 'website';

function chooseAddressBody(state: LedgerOverlayState, surface: LedgerOverlaySurface): string {
  const visibleAccounts = state.accountsExpanded ? state.accounts : state.accounts.slice(0, 2);
  const hiddenCount = Math.max(0, state.accounts.length - visibleAccounts.length);
  const selectedAddress = state.address ?? '';
  const rows = visibleAccounts.map((account) => accountRow(account, account.address === selectedAddress)).join('');
  const expandLabel = state.accountsExpanded
    ? 'Show fewer'
    : `View ${hiddenCount} More`;
  const targetLabel = surface === 'website' ? 'this browser session' : 'this desktop app';
  return `
    <p class="ledger-overlay-lede">Select the Ledger address you want ${escapeHtml(targetLabel)} to use.</p>
    <div class="ledger-account-list" role="listbox" aria-label="Ledger accounts">
      ${rows || '<p class="ledger-overlay-muted">No Ledger accounts loaded.</p>'}
    </div>
    <div class="ledger-account-list-actions">
      ${hiddenCount > 0 || state.accountsExpanded ? `<button type="button" class="utility" data-ledger-action="toggle-expanded">${escapeHtml(expandLabel)}</button>` : ''}
      ${state.canLoadMore ? `<button type="button" class="utility" data-ledger-action="load-more" ${state.loadingMore ? 'disabled' : ''}>${state.loadingMore ? 'Loading…' : 'Load 20 more'}</button>` : ''}
    </div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
      <button type="button" class="primary" data-ledger-action="confirm-address" ${selectedAddress ? '' : 'disabled'}>Confirm</button>
    </div>
  `;
}

function accountRow(account: LedgerAccountCandidate, selected: boolean): string {
  const short = compactMiddle(account.address, 6, 6);
  const label = ledgerAccountLabel(account);
  const path = account.derivationPath;
  const status = account.lastSelected
    ? 'Last used'
    : account.solBalanceLamports && account.solBalanceLamports > 0
      ? 'Has SOL'
      : account.hasActivity
        ? 'Used before'
        : '';
  const selectLabel = `Use ${label} ${short}`;
  const copyLabel = `Copy Ledger address ${short}`;
  return `
    <div
      class="ledger-account-row ${selected ? 'selected' : ''}"
      role="option"
      aria-selected="${selected ? 'true' : 'false'}"
    >
      <button
        type="button"
        class="ledger-account-select"
        data-ledger-action="select-account"
        data-ledger-address="${escapeHtml(account.address)}"
        aria-label="${escapeHtml(selectLabel)}"
      >
        <span class="ledger-account-avatar" aria-hidden="true">${selected ? '✓' : ''}</span>
        <span class="ledger-account-content">
          <span class="ledger-account-topline">
            <strong title="${escapeHtml(account.address)}">${escapeHtml(short)}</strong>
            ${status ? `<em>${escapeHtml(status)}</em>` : ''}
          </span>
          <span class="ledger-account-subline">
            <span>${escapeHtml(label)}</span>
            <code title="${escapeHtml(path)}">${escapeHtml(path)}</code>
          </span>
          <span class="ledger-account-balance">${escapeHtml(account.solBalanceLabel)}</span>
        </span>
      </button>
      <button
        type="button"
        class="ledger-account-copy"
        data-ledger-action="copy-address"
        data-ledger-address="${escapeHtml(account.address)}"
        aria-label="${escapeHtml(copyLabel)}"
      >Copy</button>
    </div>
  `;
}

function compactMiddle(value: string, prefix: number, suffix: number): string {
  if (value.length <= prefix + suffix + 1) return value;
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

function confirmingAddressBody(state: LedgerOverlayState): string {
  const address = state.address ?? '';
  const short = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
  return `
    <p class="ledger-overlay-lede">Approve this selected address on your Ledger.</p>
    <dl class="ledger-overlay-detail-grid">
      <dt>Derivation path</dt>
      <dd><code class="ledger-overlay-code">${escapeHtml(state.derivationPath)}</code></dd>
      <dt>Address</dt>
      <dd><code class="ledger-overlay-code" title="${escapeHtml(address)}">${escapeHtml(short)}</code></dd>
    </dl>
    <div class="ledger-overlay-status" role="status"><span class="toast-spinner" aria-hidden="true"></span><span>Waiting for Ledger approval…</span></div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" disabled>Cancel</button>
      <button type="button" class="primary" disabled>Confirm</button>
    </div>
  `;
}

function errorBody(state: LedgerOverlayState): string {
  return `
    <p class="ledger-overlay-error" role="alert">${escapeHtml(state.error || 'Couldn\'t pair Ledger.')}</p>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
      <button type="button" class="primary" data-ledger-action="retry">Retry</button>
    </div>
  `;
}

function bodyForMode(state: LedgerOverlayState, surface: LedgerOverlaySurface = 'desktop'): string {
  switch (state.mode) {
    case 'closed':
      return '';
    case 'searching':
      return searchingBody();
    case 'app-check':
      return appCheckBody(state);
    case 'scanning-addresses':
      return scanningAddressesBody(state);
    case 'choose-address':
      return chooseAddressBody(state, surface);
    case 'confirming-address':
      return confirmingAddressBody(state);
    case 'error':
      return errorBody(state);
  }
}

export function ledgerOverlayHtml(
  state: LedgerOverlayState,
  surface: LedgerOverlaySurface = 'desktop',
): string {
  if (state.mode === 'closed') return '';
  const title = state.mode === 'error' ? "Couldn't connect Ledger" : 'Connect Ledger';
  return `
    <div class="ledger-overlay-scrim" data-ledger-action="cancel" aria-hidden="true"></div>
    <aside class="ledger-overlay" role="dialog" aria-modal="true" aria-labelledby="ledger-overlay-title">
      <header class="ledger-overlay-head">
        <h2 id="ledger-overlay-title">${escapeHtml(title)}</h2>
        <button type="button" class="ledger-overlay-close" data-ledger-action="cancel" aria-label="Close">&times;</button>
      </header>
      <div class="ledger-overlay-body">
        ${bodyForMode(state, surface)}
      </div>
    </aside>
  `;
}

/**
 * Returns the same step-specific markup as `ledgerOverlayHtml` but without
 * the modal scrim and dialog wrapper, for inline rendering in the desktop
 * discover-flow panel. Same `data-ledger-action` handlers still apply.
 */
export function ledgerOverlayBodyHtml(
  state: LedgerOverlayState,
  surface: LedgerOverlaySurface = 'desktop',
): string {
  return bodyForMode(state, surface);
}
