import { describe, expect, it } from 'vitest';

import {
  HOSTED_BYOK_CLOUD_SESSION_REQUIRED,
  hostedByokCloudSessionBlockReason,
  shouldClearNativeCloudSessionTokenAfterUnauthorized,
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

  it('auto signs out a matching cloud session when wallet disconnect is explicit', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-a',
      reason: 'wallet-disconnected',
    })).toBe(true);
  });

  it('auto signs out a cloud session when the wallet disconnects', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: '',
      reason: 'wallet-disconnected',
    })).toBe(true);
  });

  it('auto signs out a cloud session when wallet selection is cleared by the user', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: '',
      reason: 'wallet-changed',
    })).toBe(true);
  });

  it('keeps a signed-in cloud session during startup when no wallet restored yet', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: '',
      reason: 'startup',
    })).toBe(false);
  });

  it('does not let startup sign out a signed-in cloud session by itself', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-b',
      reason: 'startup',
    })).toBe(false);
  });

  it('auto signs out a stale cloud session when another wallet connects', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: 'wallet-b',
      reason: 'wallet-mismatch',
    })).toBe(true);
  });

  it('does not auto sign out a stale cloud session until a wallet is actually connected', () => {
    expect(shouldAutoSignOutCloudSession({
      cloudStatus: 'signed-in',
      cloudWalletAddress: 'wallet-a',
      connectedWalletAddress: '',
      reason: 'wallet-mismatch',
    })).toBe(false);
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

  it('clears native cloud tokens only after a token-bearing unauthorized response', () => {
    expect(shouldClearNativeCloudSessionTokenAfterUnauthorized({
      nativeCloudApiSurfaceActive: true,
      authorizationHeaderPresent: true,
    })).toBe(true);

    expect(shouldClearNativeCloudSessionTokenAfterUnauthorized({
      nativeCloudApiSurfaceActive: true,
      authorizationHeaderPresent: false,
    })).toBe(false);

    expect(shouldClearNativeCloudSessionTokenAfterUnauthorized({
      nativeCloudApiSurfaceActive: false,
      authorizationHeaderPresent: true,
    })).toBe(false);
  });
});
