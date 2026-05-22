// Pure controller for the "Connect Ledger" overlay (Slice G).
//
// State machine:
//   closed → searching → app-check → confirm-address → closed (after auto-connect)
//   any → error → searching (Retry) | closed (Cancel)
//
// `main.ts` drives the IPC promises and dispatches reducer actions. This
// module is DOM-free + Tauri-free so it can be exercised with vitest.

export type LedgerOverlayMode =
  | 'closed'
  | 'searching'
  | 'app-check'
  | 'confirm-address'
  | 'error';

export interface LedgerOverlayDevice {
  productName: string | null;
  vendorId: number;
  productId: number;
}

export interface LedgerOverlayState {
  mode: LedgerOverlayMode;
  device: LedgerOverlayDevice | null;
  /** Derived address shown in `confirm-address` mode. */
  address: string | null;
  /** Default derivation path (visible in the overlay so user knows which account they're connecting). */
  derivationPath: string;
  error: string;
}

export const DEFAULT_LEDGER_DERIVATION_PATH = "m/44'/501'/0'/0'";

export function initialLedgerOverlayState(): LedgerOverlayState {
  return {
    mode: 'closed',
    device: null,
    address: null,
    derivationPath: DEFAULT_LEDGER_DERIVATION_PATH,
    error: '',
  };
}

export type LedgerOverlayAction =
  | { type: 'open' }
  | { type: 'deviceFound'; device: LedgerOverlayDevice }
  | { type: 'addressReady'; address: string }
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
    case 'addressReady':
      if (state.mode === 'closed') return state;
      return { ...state, mode: 'confirm-address', address: action.address, error: '' };
    case 'setError':
      return { ...state, mode: 'error', error: action.error };
    case 'close':
      return initialLedgerOverlayState();
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
    <p class="ledger-overlay-lede">Found <strong>${escapeHtml(name)}</strong>. Checking the Solana app and deriving your address…</p>
    <div class="ledger-overlay-status" role="status">Talking to the device…</div>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
    </div>
  `;
}

function confirmAddressBody(state: LedgerOverlayState): string {
  const address = state.address ?? '';
  const short = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
  return `
    <p class="ledger-overlay-lede">Connect this Ledger account?</p>
    <dl class="ledger-overlay-detail-grid">
      <dt>Derivation path</dt>
      <dd><code>${escapeHtml(state.derivationPath)}</code></dd>
      <dt>Address</dt>
      <dd><code title="${escapeHtml(address)}">${escapeHtml(short)}</code></dd>
    </dl>
    <div class="ledger-overlay-actions">
      <button type="button" class="utility" data-ledger-action="cancel">Cancel</button>
      <button type="button" class="primary" data-ledger-action="confirm-address">Connect this Ledger</button>
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

export function ledgerOverlayHtml(state: LedgerOverlayState): string {
  if (state.mode === 'closed') return '';
  let title = 'Connect Ledger';
  let body = '';
  switch (state.mode) {
    case 'searching':
      body = searchingBody();
      break;
    case 'app-check':
      body = appCheckBody(state);
      break;
    case 'confirm-address':
      body = confirmAddressBody(state);
      break;
    case 'error':
      title = 'Couldn\'t connect Ledger';
      body = errorBody(state);
      break;
  }
  return `
    <div class="ledger-overlay-scrim" data-ledger-action="cancel" aria-hidden="true"></div>
    <aside class="ledger-overlay" role="dialog" aria-modal="true" aria-labelledby="ledger-overlay-title">
      <header class="ledger-overlay-head">
        <h2 id="ledger-overlay-title">${escapeHtml(title)}</h2>
        <button type="button" class="ledger-overlay-close" data-ledger-action="cancel" aria-label="Close">&times;</button>
      </header>
      <div class="ledger-overlay-body">
        ${body}
      </div>
    </aside>
  `;
}
