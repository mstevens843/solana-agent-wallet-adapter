import { describe, expect, it } from 'vitest';

import { resolveCliSignInBridgeHydration } from '../cliSignInBridge.js';

describe('resolveCliSignInBridgeHydration', () => {
  it('does nothing when the current page already has the requested wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      currentWallet: 'WalletABC',
      desiredWallet: 'walletabc',
      bridgeCapabilities: { address: 'OtherWallet' },
    })).toEqual({ kind: 'skip', reason: 'already-ready' });
  });

  it('adopts the wallet already paired on the local bridge', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: 'WalletABC' },
    })).toEqual({ kind: 'adopt', address: 'WalletABC', mismatch: false });
  });

  it('adopts but marks mismatch when the bridge wallet is not the sign-in wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: 'WalletXYZ' },
    })).toEqual({ kind: 'adopt', address: 'WalletXYZ', mismatch: true });
  });

  it('keeps the sign-in button blocked when the bridge has no wallet', () => {
    expect(resolveCliSignInBridgeHydration({
      desiredWallet: 'WalletABC',
      bridgeCapabilities: { address: null },
    })).toEqual({ kind: 'skip', reason: 'bridge-wallet-missing' });
  });
});
