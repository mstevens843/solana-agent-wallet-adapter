import { describe, expect, it } from 'vitest';

import {
  HOSTED_BYOK_CLOUD_SESSION_REQUIRED,
  hostedByokCloudSessionBlockReason,
  shouldAutoSignOutCloudSession,
} from '../cloudSessionPolicy.js';

describe('cloud session policy helpers', () => {
  it('keeps a matching cloud session active', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-a',
    })).toBe(false);
  });

  it('auto signs out a cloud session when the wallet disconnects', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: '',
    })).toBe(true);
  });

  it('auto signs out a stale cloud session when another wallet connects', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-b',
    })).toBe(true);
  });

  it('does not sign out non-active cloud states', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-out',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-b',
    })).toBe(false);
  });

  it('blocks Hosted BYOK without a matching cloud wallet session', () => {
    expect(hostedByokCloudSessionBlockReason({
      aiMode: 'hosted',
      cloudSessionMatchesWallet: false,
    })).toBe(HOSTED_BYOK_CLOUD_SESSION_REQUIRED);
  });

  it('does not block non-hosted AI paths on cloud session state', () => {
    expect(hostedByokCloudSessionBlockReason({
      aiMode: 'session',
      cloudSessionMatchesWallet: false,
    })).toBe('');
  });
});
