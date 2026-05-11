export const HOSTED_BYOK_CLOUD_SESSION_REQUIRED =
  'Sign in to Agentic Cloud with the connected wallet before using Hosted BYOK.';

export interface CloudSessionBoundaryInput {
  cloudStatus: string;
  cloudWalletAddress: string;
  connectedWalletAddress: string;
}

export function shouldAutoSignOutCloudSession(input: CloudSessionBoundaryInput): boolean {
  return input.cloudStatus === 'signed-in'
    && Boolean(input.cloudWalletAddress)
    && input.cloudWalletAddress !== input.connectedWalletAddress;
}

export function hostedByokCloudSessionBlockReason(input: {
  aiMode: string;
  cloudSessionMatchesWallet: boolean;
}): string {
  return input.aiMode === 'hosted' && !input.cloudSessionMatchesWallet
    ? HOSTED_BYOK_CLOUD_SESSION_REQUIRED
    : '';
}
