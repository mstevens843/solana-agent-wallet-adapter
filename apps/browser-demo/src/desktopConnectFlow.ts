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

/** Which wallet the user picked inside the QR step. `null` means the
 *  picker is showing (no wallet chosen yet, no QR generated). Backpack
 *  and Jupiter both render the wallet-agnostic WalletConnect QR — they
 *  share the same protocol, only the rendered brand banner differs.
 *  Phantom and Solflare render their respective universal-link QRs. */
export type DesktopQrWallet = 'backpack' | 'jupiter' | 'phantom' | 'solflare';

export interface DesktopConnectFlowState {
  step: DesktopConnectStep;
  /** Set when the user has picked a brand inside extension/qr/awaiting-browser. */
  selectedBrandId: string | null;
  /** Epoch ms when 'awaiting-browser' was entered; used to time out the poll. */
  awaitingBrowserStartedAt: number | null;
  /** Wallet picked on the QR step. `null` while the wallet picker is showing
   *  (the default whenever the user enters the QR step). */
  qrWallet: DesktopQrWallet | null;
}

export type DesktopConnectFlowAction =
  | { type: 'startMethod' }
  | { type: 'pickMethod'; method: DesktopConnectMethod }
  | { type: 'pickBrand'; brandId: string }
  | { type: 'pickQrWallet'; wallet: DesktopQrWallet | null }
  | { type: 'beginAwaitingBrowser'; brandId: string; startedAt: number }
  | { type: 'back' }
  | { type: 'reset' };

export function initialDesktopConnectFlowState(): DesktopConnectFlowState {
  return {
    step: 'idle',
    selectedBrandId: null,
    awaitingBrowserStartedAt: null,
    qrWallet: null,
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
    qrWallet: null,
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
      // From QR with a wallet picked, peel back to the picker (sub-step inside
      // the QR screen). From the picker itself, pop out to the method picker.
      if (state.qrWallet !== null) {
        return { ...state, qrWallet: null, selectedBrandId: null };
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
      return emptyAt('method');
    case 'pickMethod':
      if (state.step !== 'method') return state;
      return emptyAt(methodToStep(action.method));
    case 'pickBrand':
      if (state.step !== 'qr' && state.step !== 'extension-brands') return state;
      return { ...state, selectedBrandId: action.brandId };
    case 'pickQrWallet':
      // QR wallet picks only make sense while on the QR step.
      if (state.step !== 'qr') return state;
      if (state.qrWallet === action.wallet) return state;
      return { ...state, qrWallet: action.wallet, selectedBrandId: null };
    case 'beginAwaitingBrowser':
      return {
        step: 'awaiting-browser',
        selectedBrandId: action.brandId,
        awaitingBrowserStartedAt: action.startedAt,
        qrWallet: null,
      };
    case 'back':
      return previousStep(state);
    case 'reset':
      if (state.step === 'idle') return state;
      return initialDesktopConnectFlowState();
  }
}
