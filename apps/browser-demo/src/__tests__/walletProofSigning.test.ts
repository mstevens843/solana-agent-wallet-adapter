import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';

import bs58 from 'bs58';
import { Transaction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';

import {
  MEMO_PROGRAM_V2_ID,
  isPhantomAndroidNativeMwa,
  setProofSigningContext,
  signWalletProofMessage,
  type ProofSigningAppState,
} from '../walletProofSigning.js';

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: bs58.encode(publicKeyBytes),
    privateKey,
  };
}

function fakeClient(impl: Partial<SolanaSigningClient>): SolanaSigningClient {
  return impl as unknown as SolanaSigningClient;
}

function appState(overrides: Partial<ProofSigningAppState>): ProofSigningAppState {
  return {
    selectedWalletName: 'Backpack',
    address: '11111111111111111111111111111111',
    androidNativeEnvironment: { isAndroidNative: false },
    ...overrides,
  };
}

describe('isPhantomAndroidNativeMwa', () => {
  it('returns true for Phantom on Android native', () => {
    expect(isPhantomAndroidNativeMwa(appState({ selectedWalletName: 'Phantom', androidNativeEnvironment: { isAndroidNative: true } }))).toBe(true);
    expect(isPhantomAndroidNativeMwa(appState({ selectedWalletName: 'phantom', androidNativeEnvironment: { isAndroidNative: true } }))).toBe(true);
  });

  it('returns false for Phantom in a non-Android shell', () => {
    expect(isPhantomAndroidNativeMwa(appState({ selectedWalletName: 'Phantom', androidNativeEnvironment: { isAndroidNative: false } }))).toBe(false);
  });

  it('returns false for non-Phantom wallets on Android', () => {
    expect(isPhantomAndroidNativeMwa(appState({ selectedWalletName: 'Backpack', androidNativeEnvironment: { isAndroidNative: true } }))).toBe(false);
  });
});

describe('signWalletProofMessage', () => {
  it('falls through to signMessage for non-Phantom wallets', async () => {
    const wallet = createTestWallet();
    const signMessage = vi.fn(async () => ({ signature: 'mock-base58-signature' }));
    const signTransaction = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () => appState({ address: wallet.walletAddress }),
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
    });

    const result = await signWalletProofMessage('proof text', 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).toHaveBeenCalledOnce();
    expect(signTransaction).not.toHaveBeenCalled();
    expect(result.proofEncoding).toBe('utf8-message');
    expect(result.signature).toBe('mock-base58-signature');
    expect(result.proofTxBase64).toBeUndefined();
  });

  it('routes Phantom Android through signTransaction with a memo containing the message bytes', async () => {
    const wallet = createTestWallet();
    let capturedTxBase64 = '';
    const signTransaction = vi.fn(async (txBase64: string) => {
      capturedTxBase64 = txBase64;
      const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
      const msg = tx.serializeMessage();
      const signature = signDetached(null, msg, wallet.privateKey);
      tx.addSignature(tx.feePayer!, signature);
      return { signature: tx.serialize({ requireAllSignatures: true, verifySignatures: true }).toString('base64') };
    });
    const signMessage = vi.fn();
    setProofSigningContext({
      getClient: () => fakeClient({ signMessage, signTransaction }),
      getAppState: () => appState({
        selectedWalletName: 'Phantom',
        address: wallet.walletAddress,
        androidNativeEnvironment: { isAndroidNative: true },
      }),
      getLatestBlockhash: async () => ({ blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k' }),
    });

    const message = 'agent decision proof';
    const result = await signWalletProofMessage(message, 'summary', 'mainnet-beta' as Cluster);

    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).toHaveBeenCalledOnce();
    expect(result.proofEncoding).toBe('tx-memo-proof');
    expect(result.proofTxBase64).toBeDefined();
    expect(result.proofMemoText).toBe(message);

    // The unsigned tx sent to the wallet must contain a Memo v2 instruction whose data == message bytes.
    const sentTx = Transaction.from(Buffer.from(capturedTxBase64, 'base64'));
    const memoIx = sentTx.instructions.find((ix) => ix.programId.toBase58() === MEMO_PROGRAM_V2_ID);
    expect(memoIx).toBeDefined();
    expect(memoIx?.data.toString('utf8')).toBe(message);
  });
});
