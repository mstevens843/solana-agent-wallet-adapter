export const HOSTED_BYOK_CLOUD_SESSION_REQUIRED =
  'Sign in to Agentic Cloud with the connected wallet before using Hosted BYOK.';

export interface CloudSessionBoundaryInput {
  cloudStatus: string;
  cloudWalletAddress: string;
  connectedWalletAddress: string;
  reason?: 'startup' | 'wallet-disconnected' | 'wallet-changed' | 'wallet-mismatch';
}

export function shouldAutoSignOutCloudSession(input: CloudSessionBoundaryInput): boolean {
  if (input.cloudStatus !== 'signed-in' || !input.cloudWalletAddress) return false;
  if (input.cloudWalletAddress === input.connectedWalletAddress) return false;
  if (!input.connectedWalletAddress && input.reason === 'startup') return false;
  return true;
}

export function hostedByokCloudSessionBlockReason(input: {
  aiMode: string;
  cloudSessionMatchesWallet: boolean;
}): string {
  return input.aiMode === 'hosted' && !input.cloudSessionMatchesWallet
    ? HOSTED_BYOK_CLOUD_SESSION_REQUIRED
    : '';
}
