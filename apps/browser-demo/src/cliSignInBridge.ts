export interface CliSignInBridgeHydrationInput {
  currentWallet?: string;
  desiredWallet?: string;
  bridgeCapabilities?: {
    address?: unknown;
  } | null;
}

export type CliSignInBridgeHydrationDecision =
  | { kind: 'skip'; reason: 'already-ready' | 'bridge-wallet-missing' }
  | { kind: 'display-paired'; address: string; mismatch: boolean };

export interface CliCloudSignInReadinessInput {
  requestReady: boolean;
  connectedWallet?: string;
  desiredWallet?: string;
  directSignerReady: boolean;
}

export interface CliCloudSignInReadiness {
  walletPaired: boolean;
  walletMismatch: boolean;
  canStart: boolean;
  heading: string;
  warning: string;
  buttonLabel: string;
}

export type WalletSigningRequestKind =
  | 'sign_message'
  | 'sign_transaction'
  | 'sign_and_send_transaction';

export interface WalletSigningRequestCopyInput {
  kind: WalletSigningRequestKind;
  display?: {
    summary?: string;
  } | null;
}

export interface WalletSigningRequestCopy {
  pendingTitle: string;
  openingStatusTitle: string;
  successStatusTitle: string;
  failureStatusTitle: string;
  successToastTitle: string;
  failureToastTitle: string;
}

function cliWalletPageClientLabel(surface?: string): string {
  return surface === 'desktop' ? 'desktop app' : 'CLI';
}

export function cliWalletPageConnectedMessage(_surface?: string): string {
  return 'Wallet connected.';
}

export function cliWalletPageConnectSubtitle(): string {
  return 'Choose Phantom, Backpack, Solflare, or another supported wallet.';
}

export function cliWalletPageReturnFooter(surface?: string): string {
  return `You can return to the ${surface === 'desktop' ? 'Desktop App' : 'terminal'}.`;
}

export function cliWalletPageConnectFooter(surface?: string): string {
  return `Return to the ${surface === 'desktop' ? 'Desktop App' : 'terminal'} once the wallet is connected.`;
}

export function cliWalletPageDisconnectedMessage(): string {
  return 'Wallet disconnected.';
}

export function cliWalletPageDisconnectPrompt(): string {
  return 'Click below to disconnect this wallet.';
}

export function cliWalletPageConnectInstruction(surface?: string): string {
  return `Choose a wallet and approve the connection. The ${cliWalletPageClientLabel(surface)} will update.`;
}

export function cliWalletPageCloudSignOutPairingNote(): string {
  return 'Signing out of Cloud Storage does not disconnect your wallet.';
}

export function cliWalletPageApprovalLoadingMessage(): string {
  return 'Loading the approval request...';
}

export function resolveCliSignInBridgeHydration(
  input: CliSignInBridgeHydrationInput,
): CliSignInBridgeHydrationDecision {
  const currentWallet = normalizeWallet(input.currentWallet);
  const desiredWallet = normalizeWallet(input.desiredWallet);
  if (currentWallet && (!desiredWallet || sameWalletText(currentWallet, desiredWallet))) {
    return { kind: 'skip', reason: 'already-ready' };
  }

  const bridgeWallet = normalizeWallet(
    typeof input.bridgeCapabilities?.address === 'string'
      ? input.bridgeCapabilities.address
      : undefined,
  );
  if (!bridgeWallet) {
    return { kind: 'skip', reason: 'bridge-wallet-missing' };
  }

  return {
    kind: 'display-paired',
    address: bridgeWallet,
    mismatch: Boolean(desiredWallet && !sameWalletText(bridgeWallet, desiredWallet)),
  };
}

export function resolveCliCloudSignInReadiness(
  input: CliCloudSignInReadinessInput,
): CliCloudSignInReadiness {
  const connected = normalizeWallet(input.connectedWallet);
  const desired = normalizeWallet(input.desiredWallet);
  const walletMismatch = Boolean(desired && connected && !sameWalletText(connected, desired));
  const walletPaired = Boolean(connected) && !walletMismatch;
  const directReady = walletPaired && input.directSignerReady;

  let warning = '';
  if (!input.requestReady) {
    warning = 'Missing Cloud Storage sign-in details. Return to the terminal and run /sign-in again.';
  } else if (!connected) {
    warning = 'Connect your wallet first. Return to the terminal, run /connect, then run /sign-in again.';
  } else if (walletMismatch) {
    warning = 'This sign-in is for a different wallet. Switch wallets and reload this page.';
  }

  return {
    walletPaired,
    walletMismatch,
    canStart: input.requestReady && walletPaired,
    heading: directReady ? 'Ready for wallet signature' : walletPaired ? 'Wallet connected - reconnect to sign' : 'Wallet required',
    warning,
    buttonLabel: directReady ? 'Sign in to Cloud Storage' : 'Connect wallet and sign in',
  };
}

export function cliIntentAllowsBridgeRequestClaim(intent?: string, surface?: string): boolean {
  if (intent === 'sign-in' || intent === 'sign-out') return false;
  if (surface === 'desktop' && (intent === 'connect' || intent === 'disconnect')) return false;
  return true;
}

export function resolveWalletSigningRequestCopy(
  request: WalletSigningRequestCopyInput,
): WalletSigningRequestCopy {
  if (isCloudStorageSignInRequest(request)) {
    return {
      pendingTitle: 'Signing in',
      openingStatusTitle: 'Opening wallet for sign-in',
      successStatusTitle: 'Signed in',
      failureStatusTitle: 'Sign-in failed',
      successToastTitle: 'Signed in',
      failureToastTitle: 'Sign-in failed',
    };
  }

  if (request.kind === 'sign_and_send_transaction') {
    return {
      pendingTitle: 'Signing and sending transaction',
      openingStatusTitle: 'Opening wallet for transaction',
      successStatusTitle: 'Transaction submitted',
      failureStatusTitle: 'Transaction failed',
      successToastTitle: 'Transaction submitted',
      failureToastTitle: 'Transaction failed',
    };
  }

  if (request.kind === 'sign_transaction') {
    return {
      pendingTitle: 'Signing transaction',
      openingStatusTitle: 'Opening wallet for transaction signature',
      successStatusTitle: 'Transaction signed',
      failureStatusTitle: 'Transaction signing failed',
      successToastTitle: 'Transaction signed',
      failureToastTitle: 'Transaction signing failed',
    };
  }

  return {
    pendingTitle: 'Signing message',
    openingStatusTitle: 'Opening wallet for message signature',
    successStatusTitle: 'Message signed',
    failureStatusTitle: 'Message signing failed',
    successToastTitle: 'Message signed',
    failureToastTitle: 'Message signing failed',
  };
}

export function isCloudStorageSignInRequest(request: WalletSigningRequestCopyInput): boolean {
  if (request.kind !== 'sign_message') return false;
  const summary = normalizeSignInSummary(request.display?.summary);
  return (
    summary.includes('agentic cloud sign in') ||
    summary.includes('agentic cli login') ||
    summary.includes('cloud storage sign in') ||
    summary.includes('cloud sign in')
  );
}

function normalizeWallet(value?: string): string {
  return value?.trim() ?? '';
}

function sameWalletText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function normalizeSignInSummary(value?: string): string {
  return value?.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ') ?? '';
}
