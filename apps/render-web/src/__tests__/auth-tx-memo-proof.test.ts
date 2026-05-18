import { generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { encodeBase58, verifyWalletSignature } from '../cloud/auth.js';

const MEMO_PROGRAM_V2_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

interface TestWallet {
  walletAddress: string;
  privateKey: KeyObject;
}

function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyBytes = Buffer.from(publicKeyDer).subarray(-32);
  return {
    walletAddress: encodeBase58(publicKeyBytes),
    privateKey,
  };
}

function buildMemoTx(wallet: TestWallet, memoText: string, blockhash = '11111111111111111111111111111111'): Buffer {
  const feePayer = new PublicKey(wallet.walletAddress);
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_V2_ID),
      keys: [{ pubkey: feePayer, isSigner: true, isWritable: true }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );
  const compiledMessage = tx.serializeMessage();
  const signature = signDetached(null, compiledMessage, wallet.privateKey);
  tx.addSignature(feePayer, signature);
  return tx.serialize({ requireAllSignatures: true, verifySignatures: true });
}

function signedTxToBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

function extractFirstSignature(signedTx: Buffer): string {
  const tx = Transaction.from(signedTx);
  const entry = tx.signatures.find((sig) => sig.signature)?.signature;
  if (!entry) throw new Error('No signature found in transaction.');
  return encodeBase58(entry);
}

describe('verifyWalletSignature tx-memo-proof', () => {
  it('verifies a valid memo-tx proof where memo bytes match the message', () => {
    const wallet = createTestWallet();
    const message = 'Agentic Cloud sign-in proof for memo-tx workaround';
    const signedTx = buildMemoTx(wallet, message);
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message,
      signature,
      proofEncoding: 'tx-memo-proof',
      proofTxBase64: signedTxToBase64(signedTx),
    });

    expect(ok).toBe(true);
  });

  it('rejects a memo-tx proof when memo bytes differ from the claimed message', () => {
    const wallet = createTestWallet();
    const signedTx = buildMemoTx(wallet, 'real memo text');
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message: 'attacker tampered message',
      signature,
      proofEncoding: 'tx-memo-proof',
      proofTxBase64: signedTxToBase64(signedTx),
    });

    expect(ok).toBe(false);
  });

  it('rejects when proofEncoding is tx-memo-proof but proofTxBase64 is missing', () => {
    const wallet = createTestWallet();
    const message = 'proof message';
    const signedTx = buildMemoTx(wallet, message);
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message,
      signature,
      proofEncoding: 'tx-memo-proof',
    });

    expect(ok).toBe(false);
  });

  it('falls through to utf8-message verification when proofEncoding is omitted', () => {
    const wallet = createTestWallet();
    const message = 'classic utf-8 path';
    const utf8Signature = encodeBase58(signDetached(null, Buffer.from(message, 'utf8'), wallet.privateKey));

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message,
      signature: utf8Signature,
    });

    expect(ok).toBe(true);
  });

  it('rejects a memo-tx proof signed by a different wallet', () => {
    const realWallet = createTestWallet();
    const otherWallet = createTestWallet();
    const message = 'proof for the real wallet only';
    const signedTx = buildMemoTx(otherWallet, message);
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: realWallet.walletAddress,
      message,
      signature,
      proofEncoding: 'tx-memo-proof',
      proofTxBase64: signedTxToBase64(signedTx),
    });

    expect(ok).toBe(false);
  });
});
