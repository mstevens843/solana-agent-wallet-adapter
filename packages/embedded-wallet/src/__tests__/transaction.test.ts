import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  extractMessageBytes,
  isVersionedTransaction,
  stitchSignature,
} from '../transaction.js';

function buildLegacyTransfer(
  payer: PublicKey,
  recipient: PublicKey,
  blockhash: string,
): Transaction {
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: 1_000_000,
    }),
  );
  return tx;
}

function buildV0Transfer(
  payer: PublicKey,
  recipient: PublicKey,
  blockhash: string,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: recipient,
        lamports: 1_000_000,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

const BLOCKHASH = '11111111111111111111111111111111';

describe('isVersionedTransaction', () => {
  it('returns false for legacy and true for v0', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const legacy = buildLegacyTransfer(
      signer.publicKey,
      recipient.publicKey,
      BLOCKHASH,
    ).serialize({ requireAllSignatures: false });
    const v0 = buildV0Transfer(
      signer.publicKey,
      recipient.publicKey,
      BLOCKHASH,
    ).serialize();
    expect(isVersionedTransaction(legacy)).toBe(false);
    expect(isVersionedTransaction(v0)).toBe(true);
  });
});

describe('extractMessageBytes + stitchSignature — legacy', () => {
  it('round-trips through external signing and produces a valid signature', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = buildLegacyTransfer(
      signer.publicKey,
      recipient.publicKey,
      BLOCKHASH,
    );
    const wireBytes = tx.serialize({ requireAllSignatures: false });
    const { versioned, messageBytes } = extractMessageBytes(wireBytes);
    expect(versioned).toBe(false);

    const signature = ed25519.sign(messageBytes, signer.secretKey.slice(0, 32));
    expect(signature).toHaveLength(64);

    const signed = stitchSignature(wireBytes, signer.publicKey.toBase58(), signature);

    // Parse the signed wire and verify the signature is now attached.
    const reparsed = Transaction.from(signed);
    const attached = reparsed.signatures.find(
      (s) => s.publicKey.toBase58() === signer.publicKey.toBase58(),
    );
    expect(attached?.signature).not.toBeNull();
    expect(attached?.signature?.length).toBe(64);
    expect(ed25519.verify(signature, messageBytes, signer.publicKey.toBytes())).toBe(true);
  });
});

describe('extractMessageBytes + stitchSignature — v0', () => {
  it('round-trips through external signing and produces a valid signature', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const tx = buildV0Transfer(
      signer.publicKey,
      recipient.publicKey,
      BLOCKHASH,
    );
    const wireBytes = tx.serialize();
    const { versioned, messageBytes } = extractMessageBytes(wireBytes);
    expect(versioned).toBe(true);

    const signature = ed25519.sign(messageBytes, signer.secretKey.slice(0, 32));

    const signed = stitchSignature(wireBytes, signer.publicKey.toBase58(), signature);

    const reparsed = VersionedTransaction.deserialize(signed);
    expect(reparsed.signatures[0]).toEqual(signature);
    expect(ed25519.verify(signature, messageBytes, signer.publicKey.toBytes())).toBe(true);
  });
});

describe('extractMessageBytes rejects empty input', () => {
  it('throws a clear error rather than a cryptic web3.js failure', () => {
    expect(() => extractMessageBytes(new Uint8Array())).toThrow(/empty/);
  });
});

describe('stitchSignature rejects malformed signatures', () => {
  it('throws when signature is not 64 bytes', () => {
    const signer = Keypair.generate();
    const recipient = Keypair.generate();
    const wireBytes = buildLegacyTransfer(
      signer.publicKey,
      recipient.publicKey,
      BLOCKHASH,
    ).serialize({ requireAllSignatures: false });
    expect(() =>
      stitchSignature(wireBytes, signer.publicKey.toBase58(), new Uint8Array(63)),
    ).toThrow(/64 bytes/);
  });
});

describe('base64 helpers round-trip', () => {
  it('encodes and decodes binary cleanly', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16]);
    const b64 = bytesToBase64(bytes);
    expect(base64ToBytes(b64)).toEqual(bytes);
  });
});
