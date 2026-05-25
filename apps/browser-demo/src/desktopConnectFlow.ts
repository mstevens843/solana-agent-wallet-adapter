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

export interface DesktopConnectFlowState {
  step: DesktopConnectStep;
  /** Set when the user has picked a brand inside extension/qr/awaiting-browser. */
  selectedBrandId: string | null;
  /** Epoch ms when 'awaiting-browser' was entered; used to time out the poll. */
  awaitingBrowserStartedAt: number | null;
}

export type DesktopConnectFlowAction =
  | { type: 'startMethod' }
  | { type: 'pickMethod'; method: DesktopConnectMethod }
  | { type: 'pickBrand'; brandId: string }
  | { type: 'beginAwaitingBrowser'; brandId: string; startedAt: number }
  | { type: 'back' }
  | { type: 'reset' };

export function initialDesktopConnectFlowState(): DesktopConnectFlowState {
  return {
    step: 'idle',
    selectedBrandId: null,
    awaitingBrowserStartedAt: null,
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

function previousStep(state: DesktopConnectFlowState): DesktopConnectFlowState {
  switch (state.step) {
    case 'idle':
      return state;
    case 'method':
      return initialDesktopConnectFlowState();
    case 'extension-brands':
    case 'ledger':
    case 'awaiting-browser':
      return { step: 'method', selectedBrandId: null, awaitingBrowserStartedAt: null };
    case 'qr':
      // From QR, if a brand was already picked, go back to the brand picker
      // (clear the selection); otherwise go back to method.
      if (state.selectedBrandId) {
        return { step: 'qr', selectedBrandId: null, awaitingBrowserStartedAt: null };
      }
      return { step: 'method', selectedBrandId: null, awaitingBrowserStartedAt: null };
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
