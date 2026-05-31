import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import {
  attachSolanaSignature,
  DEFAULT_IOS_APP_URL,
  iosNativeAppUrl,
  iosNativeWalletConnectTransactionParam,
} from '../iosNative.js';

describe('iosNativeAppUrl', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', '');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', '');
    vi.stubEnv('AGENTIC_CLOUD_API_BASE_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the production HTTPS origin for native wallet sessions', () => {
    expect(iosNativeAppUrl()).toBe(DEFAULT_IOS_APP_URL);
  });

  it('uses an explicit iOS app URL as a normalized origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'https://staging.agentic-signer.com/app?surface=ios');

    expect(iosNativeAppUrl()).toBe('https://staging.agentic-signer.com');
  });

  it('ignores non-HTTPS native webview origins and falls back to a hosted API origin', () => {
    vi.stubEnv('VITE_AGENTIC_IOS_APP_URL', 'capacitor://localhost');
    vi.stubEnv('VITE_AGENTIC_CLOUD_API_BASE_URL', 'https://agentic-signer.com/api/mobile-config');

    expect(iosNativeAppUrl()).toBe('https://agentic-signer.com');
  });
});

describe('iosNativeWalletConnectTransactionParam', () => {
  it('keeps Jupiter WalletConnect transaction payloads in base64', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'AQIDBA==',
      encoding: 'base64',
    })).toBe('AQIDBA==');
  });

  it('base64-encodes non-base64 transaction payloads before WalletConnect submission', () => {
    expect(iosNativeWalletConnectTransactionParam({
      data: 'tx',
      encoding: 'utf8',
    })).toBe('dHg=');
  });
});

describe('attachSolanaSignature', () => {
  it('reconstructs a signed legacy transaction from a signature-only WalletConnect response', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const signature = new Uint8Array(64).fill(17);
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: recipient.publicKey,
        lamports: 1,
      }),
    );
    const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

    const signedBytes = attachSolanaSignature(
      new Uint8Array(unsigned),
      signer.publicKey.toBase58(),
      bs58.encode(signature),
    );

    const signed = Transaction.from(signedBytes);
    expect(signed.signatures[0]?.publicKey.equals(signer.publicKey)).toBe(true);
    expect(new Uint8Array(signed.signatures[0]!.signature!)).toEqual(signature);
  });

  it('reconstructs a signed versioned transaction from a signature-only WalletConnect response', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const signature = new Uint8Array(64).fill(23);
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: recipient.publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const signedBytes = attachSolanaSignature(
      tx.serialize(),
      signer.publicKey.toBase58(),
      bs58.encode(signature),
    );

    const signed = VersionedTransaction.deserialize(signedBytes);
    expect(signed.signatures[0]).toEqual(signature);
  });
});
