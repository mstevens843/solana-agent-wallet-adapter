// Pure controller for the inline "Discover wallet" flow on the Tauri desktop.
//
// The Tauri webview can't host browser-extension wallets directly, so the
// desktop rail offers three connection methods after the user clicks Discover:
// open the user's system browser to the wallet host (with a pre-selected
// brand), pair a mobile wallet over WalletConnect QR, or pair a Ledger over
// USB-HID. This module owns the small step machine that drives that UI.
//
// DOM-free + Tauri-free — `main.ts` renders, binds events, and dispatches.
// Tests live in `__tests__/desktopConnectFlow.test.ts`.

export type DesktopConnectStep =
  | 'idle'
  | 'method'
  | 'extension-brands'
  | 'qr'
  | 'ledger'
  | 'awaiting-browser';

export type DesktopConnectMethod = 'extension' | 'qr' | 'ledger';

/** When the user is on the QR step, `qrVariant` selects which URI the QR
 *  encodes: the wallet-agnostic WalletConnect URI (default, used by
 *  Backpack/Jupiter/Magic Eden mobile) or a wallet-specific universal link
 *  for Phantom or Solflare (which don't speak generic WC QR). */
export type DesktopQrVariant = 'wc' | 'phantom' | 'solflare';

export interface DesktopConnectFlowState {
  step: DesktopConnectStep;
  /** Set when the user has picked a brand inside extension/qr/awaiting-browser. */
  selectedBrandId: string | null;
  /** Epoch ms when 'awaiting-browser' was entered; used to time out the poll. */
  awaitingBrowserStartedAt: number | null;
  /** Active QR variant while step === 'qr'. Reset to 'wc' on every entry
   *  into the qr step so the user always sees the default WC QR first. */
  qrVariant: DesktopQrVariant;
}

export type DesktopConnectFlowAction =
  | { type: 'startMethod' }
  | { type: 'pickMethod'; method: DesktopConnectMethod }
  | { type: 'pickBrand'; brandId: string }
  | { type: 'pickQrVariant'; variant: DesktopQrVariant }
  | { type: 'beginAwaitingBrowser'; brandId: string; startedAt: number }
  | { type: 'back' }
  | { type: 'reset' };

export function initialDesktopConnectFlowState(): DesktopConnectFlowState {
  return {
    step: 'idle',
    selectedBrandId: null,
    awaitingBrowserStartedAt: null,
    qrVariant: 'wc',
  };
}

function methodToStep(method: DesktopConnectMethod): DesktopConnectStep {
  switch (method) {
    case 'extension':
      return 'extension-brands';
    case 'qr':
      return 'qr';
    case 'ledger':
      return 'ledger';
  }
}

function emptyAt(step: DesktopConnectStep): DesktopConnectFlowState {
  return {
    step,
    selectedBrandId: null,
    awaitingBrowserStartedAt: null,
    qrVariant: 'wc',
  };
}

function previousStep(state: DesktopConnectFlowState): DesktopConnectFlowState {
  switch (state.step) {
    case 'idle':
      return state;
    case 'method':
      return initialDesktopConnectFlowState();
    case 'extension-brands':
    case 'ledger':
    case 'awaiting-browser':
      return emptyAt('method');
    case 'qr':
      // From QR with a Phantom/Solflare variant active → go back to the
      // wallet-agnostic WC variant first (sub-step inside the QR screen).
      if (state.qrVariant !== 'wc') {
        return { ...state, qrVariant: 'wc', selectedBrandId: null };
      }
      // QR + selected brand (legacy state) → drop the brand selection.
      if (state.selectedBrandId) {
        return { ...emptyAt('qr') };
      }
      return emptyAt('method');
  }
}

export function reduceDesktopConnectFlow(
  state: DesktopConnectFlowState,
  action: DesktopConnectFlowAction,
): DesktopConnectFlowState {
  switch (action.type) {
    case 'startMethod':
      // Re-entering Discover from idle resets selection; ignored from any
      // non-idle step so users can't accidentally drop their mid-flight state.
      if (state.step !== 'idle') return state;
      return { step: 'method', selectedBrandId: null, awaitingBrowserStartedAt: null };
    case 'pickMethod':
      if (state.step !== 'method') return state;
      return {
        step: methodToStep(action.method),
        selectedBrandId: null,
        awaitingBrowserStartedAt: null,
      };
    case 'pickBrand':
      if (state.step !== 'qr' && state.step !== 'extension-brands') return state;
      return { ...state, selectedBrandId: action.brandId };
    case 'beginAwaitingBrowser':
      return {
        step: 'awaiting-browser',
        selectedBrandId: action.brandId,
        awaitingBrowserStartedAt: action.startedAt,
      };
    case 'back':
      return previousStep(state);
    case 'reset':
      if (state.step === 'idle') return state;
      return initialDesktopConnectFlowState();
  }
}
