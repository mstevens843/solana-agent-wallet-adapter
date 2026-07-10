import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';
import { LEDGER_WALLET_NAME } from '@solana-agent-wallet-adapter/ledger-wallet';
import { Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  setIosProofMemoTxFallback,
  setProofSigningContext,
  shouldRouteProofThroughAndroidNative,
  shouldRouteProofThroughIosNative,
  shouldRouteProofThroughLedgerMemo,
  shouldRouteProofThroughRemoteRelayMemo,
  signWalletProofMessage,
  type AndroidProofBackend,
  type ProofSigningAppState,
} from '../walletProofSigning.js';

// iOS proofs default to signMessage now; the memo-tx path is an opt-in fallback.
// Reset the flag after every test so cases don't leak state into each other.
afterEach(() => {
  setIosProofMemoTxFallback(false);
});

function fakeClient(impl: Partial<SolanaSigningClient>): SolanaSigningClient {
  return impl as unknown as SolanaSigningClient;
}

function appState(overrides: Partial<ProofSigningAppState>): ProofSigningAppState {
  return {
    selectedWalletName: 'Backpack',
    address: '11111111111111111111111111111111',
    androidNativeEnvironment: { isAndroidNative: false },
    iosNativeEnvironment: { isIosNative: false },
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

describe('shouldRouteProofThroughLedgerMemo', () => {
  it('routes Ledger proof signing through a memo transaction', () => {
    expect(shouldRouteProofThroughLedgerMemo(appState({ selectedWalletName: LEDGER_WALLET_NAME }))).toBe(true);
    expect(shouldRouteProofThroughLedgerMemo(appState({ selectedWalletName: 'Backpack' }))).toBe(false);
  });
});

describe('shouldRouteProofThroughRemoteRelayMemo', () => {
  it('routes Phantom/Solflare QR relay proof signing through a memo transaction', () => {
    expect(
      shouldRouteProofThroughRemoteRelayMemo(
        appState({
          selectedWalletName: 'Solflare mobile',
          capabilities: {
            backend: 'remote-relay-deeplink',
            supports: { signMessage: false, signTransaction: true },
          },
        }),
      ),
    ).toBe(true);
  });

  it('does not route non-QR relay wallets through the remote memo path', () => {
    expect(
      shouldRouteProofThroughRemoteRelayMemo(
        appState({
          selectedWalletName: 'Solflare',
          capabilities: {
            backend: 'wallet-standard-web',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('shouldRouteProofThroughIosNative', () => {
  it('does NOT route Phantom/Solflare through memo tx by default (signMessage path)', () => {
    expect(
      shouldRouteProofThroughIosNative(
        appState({
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-phantom',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      ),
    ).toBe(false);
  });

  it('routes Phantom and Solflare iOS native wallets through a memo transaction when the fallback is enabled', () => {
    setIosProofMemoTxFallback(true);
    expect(
      shouldRouteProofThroughIosNative(
        appState({
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-phantom',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      ),
    ).toBe(true);
  });

  it('ALWAYS routes Backpack iOS native proofs through the memo transaction path (no working signMessage route)', () => {
    // Backpack routes to memo-tx regardless of the Phantom/Solflare emergency flag.
    setIosProofMemoTxFallback(false);
    expect(
      shouldRouteProofThroughIosNative(
        appState({
          selectedWalletName: 'Backpack',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-backpack',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      ),
    ).toBe(true);
  });

  it('does not route Jupiter iOS WalletConnect proofs through the memo transaction path even with the fallback enabled', () => {
    setIosProofMemoTxFallback(true);
    expect(
      shouldRouteProofThroughIosNative(
        appState({
          selectedWalletName: 'Jupiter',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-jupiter',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      ),
    ).toBe(false);
  });

  it('does not route non-iOS wallets through the iOS memo path even with the fallback enabled', () => {
    setIosProofMemoTxFallback(true);
    expect(
      shouldRouteProofThroughIosNative(
        appState({
          iosNativeEnvironment: { isIosNative: false },
          capabilities: {
            backend: 'wallet-standard-web',
            supports: { signMessage: true, signTransaction: true },
          },
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

  it('routes Ledger proofs through a signed memo transaction', async () => {
    const signer = Keypair.generate();
    const signature = new Uint8Array(64).fill(7);
    const signMessage = vi.fn();
    const signTransaction = vi.fn(async (txBase64: string) => {
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      tx.addSignature(signer.publicKey, Buffer.from(signature));
      return {
        signature: Buffer.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString('base64'),
      };
    });
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: LEDGER_WALLET_NAME,
          address: signer.publicKey.toBase58(),
          capabilities: { supports: { signMessage: true } },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('ledger proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.signature).toBe(bs58.encode(signature));
    expect(result.proofTxBase64).toBeTruthy();
    const signed = Transaction.from(Buffer.from(result.proofTxBase64!, 'base64'));
    const memo = signed.instructions.find((ix) => ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
    expect(new TextDecoder().decode(memo!.data)).toMatch(/^Agentic plan review proof v1\nSHA-256: [0-9a-f]{64}$/);
  });

  it('routes QR relay proofs through a signed memo transaction', async () => {
    const signer = Keypair.generate();
    const signature = new Uint8Array(64).fill(9);
    const signMessage = vi.fn();
    const signTransaction = vi.fn(async (txBase64: string) => {
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      tx.addSignature(signer.publicKey, Buffer.from(signature));
      return {
        signature: Buffer.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString('base64'),
      };
    });
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Solflare mobile',
          address: signer.publicKey.toBase58(),
          capabilities: {
            backend: 'remote-relay-deeplink',
            supports: { signMessage: false, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('qr proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.signature).toBe(bs58.encode(signature));
    expect(result.proofTxBase64).toBeTruthy();
    expect(result.proofMemoText).toBe('qr proof');
  });

  it('routes iOS native proofs through a signed memo transaction when the memo-tx fallback is enabled', async () => {
    setIosProofMemoTxFallback(true);
    const signer = Keypair.generate();
    const signature = new Uint8Array(64).fill(11);
    const signMessage = vi.fn();
    const signTransaction = vi.fn(async (txBase64: string) => {
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      tx.addSignature(signer.publicKey, Buffer.from(signature));
      return {
        signature: Buffer.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString('base64'),
      };
    });
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Phantom',
          address: signer.publicKey.toBase58(),
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-phantom',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('ios proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.signature).toBe(bs58.encode(signature));
    expect(result.proofTxBase64).toBeTruthy();
    expect(result.proofMemoText).toBe('ios proof');
  });

  it('signs iOS Phantom proofs as messages by default (no transaction simulator)', async () => {
    const signMessage = vi.fn(async () => ({ signature: 'phantom-message-signature' }));
    const signTransaction = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Phantom',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-phantom',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('ios phantom proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signTransaction).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledOnce();
    expect(result).toEqual({
      signature: 'phantom-message-signature',
      proofEncoding: 'utf8-message',
      signatureEncoding: 'base58',
    });
  });

  it('signs Backpack iOS native proofs as a memo transaction (no working signMessage route)', async () => {
    const signer = Keypair.generate();
    const signature = new Uint8Array(64).fill(7);
    const signMessage = vi.fn();
    const signTransaction = vi.fn(async (txBase64: string) => {
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      tx.addSignature(signer.publicKey, Buffer.from(signature));
      return {
        signature: Buffer.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString('base64'),
      };
    });
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Backpack',
          address: signer.publicKey.toBase58(),
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-backpack',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('ios backpack proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.signature).toBe(bs58.encode(signature));
    expect(result.proofTxBase64).toBeTruthy();
  });

  it('signs Jupiter iOS WalletConnect proofs as messages', async () => {
    const signMessage = vi.fn(async () => ({ signature: 'jupiter-message-signature' }));
    const signTransaction = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Jupiter',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-jupiter',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage('ios jupiter proof', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      signature: 'jupiter-message-signature',
      proofEncoding: 'utf8-message',
      signatureEncoding: 'base58',
    });
  });

  it('keeps Jupiter iOS Cloud Storage sign-in on WalletConnect signMessage', async () => {
    const signMessage = vi.fn(async () => ({ signature: 'jupiter-cloud-signin-signature' }));
    const signTransaction = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Jupiter',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-jupiter',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage(
      'Agentic Cloud wants you to sign in with your Solana wallet.',
      'Agentic Cloud sign-in',
      'mainnet-beta' as Cluster,
    );

    expect(signMessage).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(result.proofEncoding).toBe('utf8-message');
    expect(result.signature).toBe('jupiter-cloud-signin-signature');
  });

  it('keeps Jupiter iOS Cloud Storage deletion on WalletConnect signMessage', async () => {
    const signMessage = vi.fn(async () => ({ signature: 'jupiter-cloud-delete-signature' }));
    const signTransaction = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () =>
        appState({
          selectedWalletName: 'Jupiter',
          iosNativeEnvironment: { isIosNative: true },
          capabilities: {
            backend: 'ios-native-jupiter',
            supports: { signMessage: true, signTransaction: true },
          },
        }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      getAndroidProofBackend: () => null,
    });

    const result = await signWalletProofMessage(
      'Agentic Cloud wants you to delete this wallet workspace.',
      'Delete Agentic Cloud workspace',
      'mainnet-beta' as Cluster,
    );

    expect(signMessage).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(result.proofEncoding).toBe('utf8-message');
    expect(result.signature).toBe('jupiter-cloud-delete-signature');
  });
});
