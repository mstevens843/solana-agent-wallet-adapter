export const HOSTED_BYOK_CLOUD_SESSION_REQUIRED =
  'Cloud sign-in required for Hosted BYOK relay. Your AI key is not stored.';

export interface CloudSessionBoundaryInput {
  cloudStatus: string;
  cloudWalletAddress: string;
  connectedWalletAddress: string;
  reason?: 'startup' | 'wallet-disconnected' | 'wallet-changed' | 'wallet-mismatch';
}

export function shouldAutoSignOutCloudSession(input: CloudSessionBoundaryInput): boolean {
  if (input.cloudStatus !== 'signed-in' || !input.cloudWalletAddress) return false;
  if (input.reason === 'wallet-disconnected') return true;
  if (input.cloudWalletAddress === input.connectedWalletAddress) return false;
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
