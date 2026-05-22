// Solana transaction message extraction + signature stitching.
//
// Wallet Standard `signTransaction` receives the FULL serialized transaction
// (wire format with empty signature slots) and must return the same bytes
// with the requested signature filled in. The Rust signer (Slice A) only
// signs raw bytes — it doesn't know what a Solana transaction is — so this
// module is the bridge:
//
//   wireBytes  ──► parse (legacy or v0) ──► message-bytes-to-sign  ──► IPC
//                                                                       │
//                                                                       ▼
//   wireBytes' ◄── reserialize ◄── attach 64-byte signature ◄─── sigBytes
//
// `VersionedTransaction.deserialize()` is the universal parser — it handles
// both legacy and v0 wire formats and dispatches to the correct
// `Message` / `MessageV0` internally. We don't need to detect the format
// up-front: just deserialize, sign the message bytes, and serialize back.

import { PublicKey, VersionedTransaction } from '@solana/web3.js';

/**
 * Returns `true` if `bytes` is a versioned (v0+) Solana transaction. Used by
 * callers who need to know the format (e.g., for UI hints); not required for
 * signing — both formats round-trip through `VersionedTransaction`.
 */
export function isVersionedTransaction(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    return tx.message.version !== 'legacy';
  } catch {
    return false;
  }
}

/**
 * Parse a wire-format Solana transaction and return the bytes that must be
 * ed25519-signed (the message bytes). The caller passes these to the Rust
 * signer via `wallet_sign_transaction`.
 */
export function extractMessageBytes(wireBytes: Uint8Array): {
  versioned: boolean;
  messageBytes: Uint8Array;
} {
  if (wireBytes.length === 0) {
    throw new Error('transaction bytes are empty');
  }
  const tx = VersionedTransaction.deserialize(wireBytes);
  return {
    versioned: tx.message.version !== 'legacy',
    messageBytes: tx.message.serialize(),
  };
}

/**
 * Re-serialize the transaction with the supplied signature attached for
 * `signerAddress`. Returns the new wire-format bytes.
 *
 * - `signature` must be the raw 64-byte ed25519 signature.
 * - `signerAddress` must be a base58 Solana address whose corresponding
 *   public key appears in the transaction's signer list.
 */
export function stitchSignature(
  wireBytes: Uint8Array,
  signerAddress: string,
  signature: Uint8Array,
): Uint8Array {
  if (signature.length !== 64) {
    throw new Error(`signature must be 64 bytes, got ${signature.length}`);
  }
  const tx = VersionedTransaction.deserialize(wireBytes);
  tx.addSignature(new PublicKey(signerAddress), signature);
  return tx.serialize();
}

/** Convert a `Uint8Array` to a base64 string (browser-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  // Node fallback for tests.
  return Buffer.from(binary, 'binary').toString('base64');
}

/** Convert a base64 string back to `Uint8Array`. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  // Node fallback for tests.
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
