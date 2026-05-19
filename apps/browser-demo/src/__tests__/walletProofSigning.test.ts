import { describe, expect, it, vi } from 'vitest';

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';

import {
  setProofSigningContext,
  shouldRouteProofThroughAndroidNative,
  signWalletProofMessage,
  type AndroidProofBackend,
  type ProofSigningAppState,
} from '../walletProofSigning.js';

function fakeClient(impl: Partial<SolanaSigningClient>): SolanaSigningClient {
  return impl as unknown as SolanaSigningClient;
}

function appState(overrides: Partial<ProofSigningAppState>): ProofSigningAppState {
  return {
    selectedWalletName: 'Backpack',
    address: '11111111111111111111111111111111',
    androidNativeEnvironment: { isAndroidNative: false },
    capabilities: { supports: { signMessage: true } },
    ...overrides,
  };
}

describe('shouldRouteProofThroughAndroidNative', () => {
  it('routes when Android-native and the wallet reports no sign_messages support', () => {
    expect(
      shouldRouteProofThroughAndroidNative(
        appState({
          androidNativeEnvironment: { isAndroidNative: true },
          capabilities: { supports: { signMessage: false } },
        }),
      ),
    ).toBe(true);
  });

  it('does not route when Android-native but the wallet supports sign_messages', () => {
    expect(
      shouldRouteProofThroughAndroidNative(
        appState({
          androidNativeEnvironment: { isAndroidNative: true },
          capabilities: { supports: { signMessage: true } },
        }),
      ),
    ).toBe(false);
  });

  it('does not route on non-Android shells regardless of capabilities', () => {
    expect(
      shouldRouteProofThroughAndroidNative(
        appState({
          androidNativeEnvironment: { isAndroidNative: false },
          capabilities: { supports: { signMessage: false } },
        }),
      ),
    ).toBe(false);
  });
});

describe('signWalletProofMessage', () => {
  it('falls through to client.signMessage when the wallet supports sign_messages', async () => {
    const signMessage = vi.fn(async () => ({ signature: 'mock-base58-signature' }));
    const signProof = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage }),
      getAppState: () => appState({}),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => ({ signProof } as AndroidProofBackend),
    });

    const result = await signWalletProofMessage('proof text', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).toHaveBeenCalledOnce();
    expect(signProof).not.toHaveBeenCalled();
    expect(result.proofEncoding).toBe('utf8-message');
    expect(result.signature).toBe('mock-base58-signature');
    expect(result.proofTxBase64).toBeUndefined();
  });

  it('delegates to the Android proof backend when capabilities report no sign_messages', async () => {
    const signMessage = vi.fn();
    const signProof = vi.fn(async (msg: string) => ({
      signature: 'native-base58-signature',
      encoding: 'tx-memo-proof' as const,
      transactionBase64: `signed:${msg}`,
    }));
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Phantom',
          androidNativeEnvironment: { isAndroidNative: true },
          capabilities: { supports: { signMessage: false } },
        }),
      getLatestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k' }),
      getAndroidProofBackend: () => ({ signProof } as AndroidProofBackend),
    });

    const message = 'agent decision proof';
    const result = await signWalletProofMessage(message, 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signProof).toHaveBeenCalledOnce();
    expect(signProof).toHaveBeenCalledWith(message, 'summary');
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.signature).toBe('native-base58-signature');
    expect(result.proofTxBase64).toBe(`signed:${message}`);
    expect(result.proofMemoText).toBe(message);
  });

  it('returns utf8-message when the Android backend chooses to sign the message directly', async () => {
    const signMessage = vi.fn();
    const signProof = vi.fn(async () => ({
      signature: 'native-utf8-signature',
      encoding: 'utf8' as const,
    }));
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Backpack',
          androidNativeEnvironment: { isAndroidNative: true },
          capabilities: { supports: { signMessage: false } },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => ({ signProof } as AndroidProofBackend),
    });

    const result = await signWalletProofMessage('proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signProof).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('utf8-message');
    expect(result.signature).toBe('native-utf8-signature');
    expect(result.proofTxBase64).toBeUndefined();
  });
});
