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
    warning = 'Pair your wallet first. Return to the terminal, run /connect, then run /sign-in again.';
  } else if (walletMismatch) {
    warning = 'This sign-in is for a different wallet. Switch wallets and reload this page.';
  }

  return {
    walletPaired,
    walletMismatch,
    canStart: input.requestReady && walletPaired,
    heading: directReady ? 'Ready for wallet signature' : walletPaired ? 'Wallet paired - reconnect to sign' : 'Wallet required',
    warning,
    buttonLabel: directReady ? 'Sign in to Cloud Storage' : 'Connect wallet and sign in',
  };
}

export function cliIntentAllowsBridgeRequestClaim(intent?: string): boolean {
  return intent !== 'sign-in' && intent !== 'sign-out';
}

function normalizeWallet(value?: string): string {
  return value?.trim() ?? '';
}

function sameWalletText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
