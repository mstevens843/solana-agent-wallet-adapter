import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';

import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { ACCEPTED_ENVELOPE_PREFIXES, encodeBase58, verifyWalletSignature } from '../cloud/auth.js';

const MEMO_PROGRAM_V2_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Mirror of `apps/android-twa/.../MemoProofRouter.PROOF_MEMO_PREFIX`. Kept in sync
// by hand because the server has no Kotlin import path; the cross-test
// `routingDecisionsAgreeBetweenJsAndAndroid` (Android side) plus this constant
// (server side) are the contract anchors.
const PROOF_MEMO_ENVELOPE_PREFIX = 'Agentic plan review proof v1\nSHA-256: ';

function buildEnvelopeMemoText(message: string): string {
  const hex = createHash('sha256').update(Buffer.from(message, 'utf8')).digest('hex');
  return PROOF_MEMO_ENVELOPE_PREFIX + hex;
}

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

  // Hashed-envelope contract: memo = "Agentic plan review proof v1\nSHA-256: " + hex.
  // The android-twa builder emits this for any message length so the memo-tx fits
  // under Solana's 1232-byte packet limit even for multi-KB plan-review messages.
  it('verifies a hashed-envelope memo-tx proof for a short message', () => {
    const wallet = createTestWallet();
    const message = 'short proof';
    const signedTx = buildMemoTx(wallet, buildEnvelopeMemoText(message));
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

  it('verifies a hashed-envelope memo-tx proof for an oversize message that would not fit literally', () => {
    const wallet = createTestWallet();
    // 4000-char message would have produced a ~4170-byte tx under the literal-bytes
    // contract — well past Solana's 1232-byte packet limit. Hashed envelope keeps
    // the tx small regardless.
    const message = 'a'.repeat(4000);
    const signedTx = buildMemoTx(wallet, buildEnvelopeMemoText(message));
    expect(signedTx.length).toBeLessThanOrEqual(1232);
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

  it('rejects a hashed-envelope memo-tx proof when the envelope hex does not match sha256(message)', () => {
    const wallet = createTestWallet();
    const realMessage = 'real proof bound to wallet';
    // Build the envelope from a DIFFERENT message — attacker swaps in the wrong digest.
    const signedTx = buildMemoTx(wallet, buildEnvelopeMemoText('decoy message attacker substituted'));
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message: realMessage,
      signature,
      proofEncoding: 'tx-memo-proof',
      proofTxBase64: signedTxToBase64(signedTx),
    });

    expect(ok).toBe(false);
  });

  it('rejects a hashed-envelope memo-tx proof with a malformed hex suffix', () => {
    const wallet = createTestWallet();
    const message = 'short proof';
    // Envelope with truncated digest (32 chars instead of 64) — must not pass.
    const malformedMemoText = PROOF_MEMO_ENVELOPE_PREFIX + 'a'.repeat(32);
    const signedTx = buildMemoTx(wallet, malformedMemoText);
    const signature = extractFirstSignature(signedTx);

    const ok = verifyWalletSignature({
      walletAddress: wallet.walletAddress,
      message,
      signature,
      proofEncoding: 'tx-memo-proof',
      proofTxBase64: signedTxToBase64(signedTx),
    });

    expect(ok).toBe(false);
  });

  // ACCEPTED_ENVELOPE_PREFIXES is the forward-compat contract: server must accept any
  // prefix the APK might send, even from old installs we can't force-update through the
  // Solana dApp Store. These tests pin the array contents so a careless edit can't
  // silently break shipped clients.
  describe('ACCEPTED_ENVELOPE_PREFIXES contract', () => {
    it('includes the v1 envelope (which every shipped APK emits today)', () => {
      expect(ACCEPTED_ENVELOPE_PREFIXES).toContain('Agentic plan review proof v1\nSHA-256: ');
    });

    it('NEVER drops the v1 envelope prefix — IMMUTABILITY GUARD', () => {
      // CRITICAL FOREVER INVARIANT: the v1 prefix MUST stay in this array as long
      // as any APK ever shipped with v1 exists in the wild. APKs in the Solana
      // dApp Store cannot be force-updated; users can be running v1-emitting
      // APKs years from now. If a future dev "cleans up" by removing v1 to
      // simplify the array, every old APK's proof signing breaks silently and
      // every existing user is locked out of sign-in.
      //
      // If you are reading this because a code review flagged the v1 prefix as
      // dead code: it is NOT dead. Do not remove it. Add new prefixes by
      // appending — never replace.
      expect(ACCEPTED_ENVELOPE_PREFIXES).toContain('Agentic plan review proof v1\nSHA-256: ');
      expect(ACCEPTED_ENVELOPE_PREFIXES.length).toBeGreaterThanOrEqual(1);
    });

    it('verifies a proof under every prefix currently in the array', () => {
      const wallet = createTestWallet();
      const message = 'multi-version compat probe';
      for (const prefix of ACCEPTED_ENVELOPE_PREFIXES) {
        const hex = createHash('sha256').update(Buffer.from(message, 'utf8')).digest('hex');
        const memoText = prefix + hex;
        const signedTx = buildMemoTx(wallet, memoText);
        const signature = extractFirstSignature(signedTx);
        const ok = verifyWalletSignature({
          walletAddress: wallet.walletAddress,
          message,
          signature,
          proofEncoding: 'tx-memo-proof',
          proofTxBase64: signedTxToBase64(signedTx),
        });
        expect(ok, `prefix=${JSON.stringify(prefix)}`).toBe(true);
      }
    });

    it('rejects a hashed-envelope memo-tx proof whose prefix is not in the accepted array', () => {
      const wallet = createTestWallet();
      const message = 'short proof';
      const hex = createHash('sha256').update(Buffer.from(message, 'utf8')).digest('hex');
      // A plausible-looking but unregistered prefix — must NOT verify until added to
      // ACCEPTED_ENVELOPE_PREFIXES on a server redeploy.
      const memoText = 'Agentic plan review proof v999\nSHA-256: ' + hex;
      const signedTx = buildMemoTx(wallet, memoText);
      const signature = extractFirstSignature(signedTx);

      const ok = verifyWalletSignature({
        walletAddress: wallet.walletAddress,
        message,
        signature,
        proofEncoding: 'tx-memo-proof',
        proofTxBase64: signedTxToBase64(signedTx),
      });

      expect(ok).toBe(false);
    });
  });
});
