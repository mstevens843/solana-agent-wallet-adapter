import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  isRecoverableAndroidSiwsCloudAuthFailure,
  shouldFallbackToProofAfterAndroidSiwsError,
  shouldUseAndroidSiwsCloudSignIn,
} from '../cloudSignInPolicy.js';

describe('shouldUseAndroidSiwsCloudSignIn', () => {
  it('keeps the Android SIWS fast path disabled by default', () => {
    expect(
      shouldUseAndroidSiwsCloudSignIn({
        isAndroidNative: true,
        hasWalletAddress: false,
      }),
    ).toBe(false);
  });

  it('allows SIWS only when explicitly enabled for Android before wallet connect', () => {
    expect(
      shouldUseAndroidSiwsCloudSignIn({
        isAndroidNative: true,
        hasWalletAddress: false,
        siwsFastPathEnabled: true,
      }),
    ).toBe(true);
  });

  it('does not use SIWS when a wallet is already connected', () => {
    expect(
      shouldUseAndroidSiwsCloudSignIn({
        isAndroidNative: true,
        hasWalletAddress: true,
        siwsFastPathEnabled: true,
      }),
    ).toBe(false);
  });

  it('does not use SIWS on non-Android surfaces', () => {
    expect(
      shouldUseAndroidSiwsCloudSignIn({
        isAndroidNative: false,
        hasWalletAddress: false,
        siwsFastPathEnabled: true,
      }),
    ).toBe(false);
  });
});

describe('Android SIWS Cloud sign-in fallback policy', () => {
  it('falls back when native SIWS is unsupported', () => {
    expect(
      shouldFallbackToProofAfterAndroidSiwsError(
        new ProtocolError('unsupported_method', 'Sign In With Solana is unsupported by this wallet.'),
      ),
    ).toBe(true);
  });

  it('falls back when the cloud verifier rejects the signed SIWS message', () => {
    expect(
      shouldFallbackToProofAfterAndroidSiwsError(
        new Error('Signed SIWS message does not match auth nonce.'),
      ),
    ).toBe(true);
    expect(
      shouldFallbackToProofAfterAndroidSiwsError(
        new Error('Wallet signature could not be verified.'),
      ),
    ).toBe(true);
  });

  it('treats bare unauthorized cloud SIWS responses as recoverable', () => {
    expect(isRecoverableAndroidSiwsCloudAuthFailure(new Error('unauthorized'))).toBe(true);
  });

  it('does not fall back when the wallet action was rejected by the user', () => {
    expect(
      shouldFallbackToProofAfterAndroidSiwsError(
        new ProtocolError('user_rejected', 'User rejected Sign In With Solana.'),
      ),
    ).toBe(false);
    expect(
      shouldFallbackToProofAfterAndroidSiwsError(
        new Error('Wallet approval dismissed.'),
      ),
    ).toBe(false);
  });
});
