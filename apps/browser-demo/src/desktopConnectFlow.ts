// Pure controller for the inline "Discover wallet" flow on the Tauri desktop.
//
// The Tauri webview can't host browser-extension wallets directly, so the
// desktop rail offers three connection methods after the user clicks Discover:
// open the user's system browser to the dedicated wallet-host connect page,
// pair a mobile wallet over WalletConnect QR, or pair a Ledger over USB-HID.
// This module owns the small step machine that drives the inline UI.
//
// DOM-free + Tauri-free — `main.ts` renders, binds events, and dispatches.
// Tests live in `__tests__/desktopConnectFlow.test.ts`.

export type DesktopConnectStep =
  | 'idle'
  | 'method'
  | 'qr'
  | 'ledger'
  | 'awaiting-browser';

export type DesktopConnectMethod = 'extension' | 'qr' | 'ledger';
type DesktopConnectInlineMethod = Exclude<DesktopConnectMethod, 'extension'>;

/** Which wallet the user picked inside the QR step. `null` means the
 *  picker is showing (no wallet chosen yet, no QR generated). Backpack and
 *  Jupiter render the raw WalletConnect QR; Phantom and Solflare render
 *  wallet-specific encrypted deeplink QRs. */
export type DesktopQrWallet = 'backpack' | 'jupiter' | 'phantom' | 'solflare';

export interface DesktopBrowserConnectUrlInput {
  walletHostUrl: string;
  bridgeUrl?: string;
  bridgeToken?: string;
}

export type DesktopBrowserIntent = 'connect' | 'approve' | 'sign';

export interface DesktopBrowserIntentUrlInput extends DesktopBrowserConnectUrlInput {
  intent: DesktopBrowserIntent;
  requestId?: string;
  actionId?: string;
}

export interface DesktopBridgeReadinessStatus {
  running: boolean;
  bridgeReachable: boolean;
  lastError?: string | null;
  diagnostics?: ReadonlyArray<{ level: string; label: string; message: string }>;
}

export function buildDesktopBrowserConnectUrl(input: DesktopBrowserConnectUrlInput): string {
  return buildDesktopBrowserIntentUrl({ ...input, intent: 'connect' });
}

export function buildDesktopBrowserIntentUrl(input: DesktopBrowserIntentUrlInput): string {
  const url = new URL(input.walletHostUrl);
  url.pathname = desktopBrowserIntentPath(input.intent);
  url.searchParams.delete('wallet');
  const bridgeUrl = input.bridgeUrl?.trim();
  const bridgeToken = input.bridgeToken?.trim();
  const requestId = input.requestId?.trim();
  const actionId = input.actionId?.trim();
  if (bridgeUrl) url.searchParams.set('bridgeUrl', bridgeUrl);
  if (bridgeToken) url.searchParams.set('token', bridgeToken);
  if (requestId) url.searchParams.set('requestId', requestId);
  if (actionId) url.searchParams.set('actionId', actionId);
  url.searchParams.set('mode', 'cli');
  url.searchParams.set('intent', input.intent);
  url.searchParams.set('surface', 'desktop');
  return url.toString();
}

function desktopBrowserIntentPath(intent: DesktopBrowserIntent): string {
  switch (intent) {
    case 'approve':
      return '/approve';
    case 'sign':
      return '/sign';
    case 'connect':
      return '/connect';
  }
}

export function isDesktopBridgeReady(status: DesktopBridgeReadinessStatus | null | undefined): boolean {
  return Boolean(status?.running && status.bridgeReachable);
}

export function desktopBridgeNotReadyMessage(
  status: DesktopBridgeReadinessStatus | null | undefined,
  fallback?: string | null,
): string {
  const fallbackMessage = fallback?.trim();
  if (fallbackMessage) return fallbackMessage;

  const lastError = status?.lastError?.trim();
  if (lastError) return lastError;

  const diagnostic = status?.diagnostics?.find((entry) => {
    const level = entry.level.trim().toLowerCase();
    return (level === 'error' || level === 'warn') && entry.message.trim();
  });
  if (diagnostic) return diagnostic.message.trim();

  return 'Local wallet service did not start. Restart the local runtime and try again.';
}

export interface DesktopConnectFlowState {
  step: DesktopConnectStep;
  /** Optional brand context while waiting for the external browser page. */
  selectedBrandId: string | null;
  /** Epoch ms when 'awaiting-browser' was entered; used to time out the poll. */
  awaitingBrowserStartedAt: number | null;
  /** Wallet picked on the QR step. `null` while the wallet picker is showing
   *  (the default whenever the user enters the QR step). */
  qrWallet: DesktopQrWallet | null;
}

export interface MultiPathWalletSurface {
  isAndroidNative: boolean;
  isIosNative: boolean;
  isCliMode?: boolean;
  isTauriNative: boolean;
}

export function canUseMultiPathWalletFlow(surface: MultiPathWalletSurface): boolean {
  if (surface.isCliMode) return false;
  return surface.isTauriNative || (!surface.isAndroidNative && !surface.isIosNative);
}

export function shouldRenderDetachedWalletConnectOverlay(input: {
  isTauriNative: boolean;
  flowStep: DesktopConnectStep;
}): boolean {
  return !input.isTauriNative && input.flowStep !== 'qr';
}

export function shouldRenderDetachedLedgerOverlay(input: {
  isTauriNative: boolean;
  flowStep: DesktopConnectStep;
}): boolean {
  return !input.isTauriNative && input.flowStep !== 'ledger';
}

export type DesktopConnectFlowAction =
  | { type: 'startMethod' }
  | { type: 'pickMethod'; method: DesktopConnectInlineMethod }
  | { type: 'pickQrWallet'; wallet: DesktopQrWallet | null }
  | { type: 'beginAwaitingBrowser'; brandId?: string | null; startedAt: number }
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

function methodToStep(method: DesktopConnectInlineMethod): DesktopConnectStep {
  switch (method) {
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
    case 'pickQrWallet':
      // QR wallet picks only make sense while on the QR step.
      if (state.step !== 'qr') return state;
      if (state.qrWallet === action.wallet) return state;
      return { ...state, qrWallet: action.wallet, selectedBrandId: null };
    case 'beginAwaitingBrowser':
      return {
        step: 'awaiting-browser',
        selectedBrandId: action.brandId ?? null,
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
