export interface CliSignInBridgeHydrationInput {
  currentWallet?: string;
  desiredWallet?: string;
  bridgeCapabilities?: {
    address?: unknown;
  } | null;
}

export type CliSignInBridgeHydrationDecision =
  | { kind: 'skip'; reason: 'already-ready' | 'bridge-wallet-missing' }
  | { kind: 'adopt'; address: string; mismatch: boolean };

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
    kind: 'adopt',
    address: bridgeWallet,
    mismatch: Boolean(desiredWallet && !sameWalletText(bridgeWallet, desiredWallet)),
  };
}

function normalizeWallet(value?: string): string {
  return value?.trim() ?? '';
}

function sameWalletText(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
