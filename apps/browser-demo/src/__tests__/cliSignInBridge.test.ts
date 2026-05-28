import { describe, expect, it } from 'vitest';

import {
  cliIntentAllowsBridgeRequestClaim,
  resolveWalletSigningRequestCopy,
  resolveCliCloudSignInReadiness,
  resolveCliSignInBridgeHydration,
} from '../cliSignInBridge.js';

describe('resolveCliSignInBridgeHydration', () => {
  it('does nothing when the current page already has the requested wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      currentWallet: 'WalletABC',
      desiredWallet: 'walletabc',
      bridgeCapabilities: { address: 'OtherWallet' },
    })).toEqual({ kind: 'skip', reason: 'already-ready' });
  });

  it('displays the wallet already paired with the desktop wallet service without making it the signer', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: 'WalletABC' },
    })).toEqual({ kind: 'display-paired', address: 'WalletABC', mismatch: false });
  });

  it('displays but marks mismatch when the bridge wallet is not the sign-in wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: 'WalletXYZ' },
    })).toEqual({ kind: 'display-paired', address: 'WalletXYZ', mismatch: true });
  });

  it('keeps the sign-in button blocked when the bridge has no wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: null },
    })).toEqual({ kind: 'skip', reason: 'bridge-wallet-missing' });
  });
});

describe('resolveWalletSigningRequestCopy', () => {
  it('labels Agentic Cloud sign-in message approvals as signed in', () => {
    expect(resolveWalletSigningRequestCopy({
      kind: 'sign_message',
      display: { summary: 'Agentic Cloud sign-in' },
    })).toMatchObject({
      pendingTitle: 'Signing in',
      successToastTitle: 'Signed in',
      failureToastTitle: 'Sign-in failed',
    });
  });

  it('labels CLI cloud login message approvals as signed in', () => {
    expect(resolveWalletSigningRequestCopy({
      kind: 'sign_message',
      display: { summary: 'Agentic CLI login' },
    })).toMatchObject({
      pendingTitle: 'Signing in',
      successToastTitle: 'Signed in',
    });
  });

  it('keeps generic message approvals as message signing', () => {
    expect(resolveWalletSigningRequestCopy({
      kind: 'sign_message',
      display: { summary: 'Sign review proof' },
    })).toMatchObject({
      pendingTitle: 'Signing message',
      successToastTitle: 'Message signed',
      failureToastTitle: 'Message signing failed',
    });
  });

  it('labels transaction signatures without bridge terminology', () => {
    expect(resolveWalletSigningRequestCopy({
      kind: 'sign_transaction',
      display: { summary: 'Sign transfer transaction' },
    })).toMatchObject({
      pendingTitle: 'Signing transaction',
      successToastTitle: 'Transaction signed',
      failureToastTitle: 'Transaction signing failed',
    });
  });
});

describe('resolveCliCloudSignInReadiness', () => {
  it('can sign immediately when the requested wallet has a direct signer', () => {
    expect(resolveCliCloudSignInReadiness({
      requestReady: true,
      connectedWallet: 'WalletABC',
      desiredWallet: 'walletabc',
      directSignerReady: true,
    })).toMatchObject({
      walletPaired: true,
      canStart: true,
      heading: 'Ready for wallet signature',
      buttonLabel: 'Sign in to Cloud Storage',
    });
  });

  it('allows the button to reconnect when the bridge only supplies the wallet address', () => {
    expect(resolveCliCloudSignInReadiness({
      requestReady: true,
      connectedWallet: 'WalletABC',
      desiredWallet: 'WalletABC',
      directSignerReady: false,
    })).toMatchObject({
      walletPaired: true,
      canStart: true,
      heading: 'Wallet paired - reconnect to sign',
      buttonLabel: 'Connect wallet and sign in',
    });
  });

  it('blocks when the paired wallet does not match the sign-in request', () => {
    expect(resolveCliCloudSignInReadiness({
      requestReady: true,
      connectedWallet: 'WalletXYZ',
      desiredWallet: 'WalletABC',
      directSignerReady: true,
    })).toMatchObject({
      walletPaired: false,
      walletMismatch: true,
      canStart: false,
    });
  });
});

describe('cliIntentAllowsBridgeRequestClaim', () => {
  it('prevents cloud sign-in pages from claiming their own bridge signing request', () => {
    expect(cliIntentAllowsBridgeRequestClaim('sign-in')).toBe(false);
    expect(cliIntentAllowsBridgeRequestClaim('sign-out')).toBe(false);
    expect(cliIntentAllowsBridgeRequestClaim('connect')).toBe(true);
    expect(cliIntentAllowsBridgeRequestClaim('approve')).toBe(true);
  });

  it('prevents desktop connect pages from claiming signing requests', () => {
    expect(cliIntentAllowsBridgeRequestClaim('connect', 'desktop')).toBe(false);
    expect(cliIntentAllowsBridgeRequestClaim('disconnect', 'desktop')).toBe(false);
    expect(cliIntentAllowsBridgeRequestClaim('sign', 'desktop')).toBe(true);
    expect(cliIntentAllowsBridgeRequestClaim('approve', 'desktop')).toBe(true);
  });
});
