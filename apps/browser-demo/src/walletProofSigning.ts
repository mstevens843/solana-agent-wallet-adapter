/**
 * Centralized "sign a proof" path. Most wallets sign the UTF-8 proof bytes
 * directly via `signMessage`. Two Android-native MWA wallets do NOT implement
 * `sign_messages` and need a memo-tx fallback:
 *
 *   • Phantom — `get_capabilities` returns `["supports_sign_and_send_transactions"]`
 *   • Solflare — `get_capabilities` returns `["solana:signTransactions"]`
 *
 * Calling `signMessage` on either wallet either hangs ~90s or shows an approve
 * sheet that returns to a "failed" / Close screen with no protocol-level reply.
 * We work around this by signing a memo-only transaction whose memo data is the
 * same proof bytes the message path would have signed. The transaction is NOT
 * broadcast — the wallet signature serves as proof of consent and the fresh
 * blockhash expires harmlessly.
 *
 * Reference: ~/Desktop/grant-godot/KNOWN_ISSUES.md (Phantom + Solflare sections),
 * ~/Desktop/grant-unity/KNOWN_ISSUES.md (Phantom + Solflare sections),
 * ~/Desktop/cocos-solana-mwa/assets/solana-mwa/scripts/MWAManager.ts (1641-1747).
 */

import bs58 from 'bs58';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';

export const MEMO_PROGRAM_V2_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export type WalletProofEncoding = 'utf8-message' | 'tx-memo-proof';

export interface WalletProofSignature {
  signature: string;
  proofEncoding: WalletProofEncoding;
  proofTxBase64?: string;
  proofMemoText?: string;
}

export interface ProofSigningAppState {
  selectedWalletName: string;
  address: string;
  androidNativeEnvironment: { isAndroidNative: boolean };
}

export interface ProofSigningContext {
  getClient: () => SolanaSigningClient;
  getAppState: () => ProofSigningAppState;
  getLatestBlockhash: (cluster: Cluster) => Promise<{ blockhash: string }>;
}

let context: ProofSigningContext | null = null;

export function setProofSigningContext(ctx: ProofSigningContext): void {
  context = ctx;
}

export function isPhantomAndroidNativeMwa(state: ProofSigningAppState): boolean {
  return walletNeedsAndroidMemoTxProof(state, 'phantom');
}

export function isSolflareAndroidNativeMwa(state: ProofSigningAppState): boolean {
  return walletNeedsAndroidMemoTxProof(state, 'solflare');
}

/**
 * True when the connected wallet is one of the Android-native MWA wallets that
 * doesn't implement `sign_messages` (Phantom or Solflare today) and we therefore
 * need to substitute a memo-only `sign_transactions` call.
 */
export function walletNeedsAndroidNativeMemoTxProof(state: ProofSigningAppState): boolean {
  return walletNeedsAndroidMemoTxProof(state, 'phantom') || walletNeedsAndroidMemoTxProof(state, 'solflare');
}

function walletNeedsAndroidMemoTxProof(state: ProofSigningAppState, walletNameNeedle: string): boolean {
  if (!state.androidNativeEnvironment.isAndroidNative) return false;
  return state.selectedWalletName.toLowerCase().includes(walletNameNeedle);
}

export async function signWalletProofMessage(
  message: string,
  summary: string,
  cluster: Cluster,
): Promise<WalletProofSignature> {
  if (!context) {
    throw new Error('Proof signing context is not ready — connect a wallet first.');
  }
  const client = context.getClient();
  const state = context.getAppState();
  if (!walletNeedsAndroidNativeMemoTxProof(state)) {
    const result = await client.signMessage(message, { cluster, summary });
    return { signature: result.signature, proofEncoding: 'utf8-message' };
  }

  const feePayer = new PublicKey(state.address);
  const { blockhash } = await context.getLatestBlockhash(cluster);
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_V2_ID),
      keys: [{ pubkey: feePayer, isSigner: true, isWritable: true }],
      data: Buffer.from(message, 'utf8'),
    }),
  );
  const proofTxBase64 = encodeBase64(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );

  const result = await client.signTransaction(proofTxBase64, { cluster, summary });
  const signature = extractFirstSignature(result.signature);
  return {
    signature,
    proofEncoding: 'tx-memo-proof',
    proofTxBase64: result.signature,
    proofMemoText: message,
  };
}

function extractFirstSignature(signedTransactionBase64: string): string {
  const bytes = decodeBase64(signedTransactionBase64);
  try {
    const transaction = Transaction.from(bytes);
    const sig = transaction.signatures.find((entry) => entry.signature && !isZeroSignature(entry.signature))?.signature;
    if (sig) return bs58.encode(sig);
  } catch {
    // fall through to versioned parsing
  }
  try {
    const transaction = VersionedTransaction.deserialize(bytes);
    const sig = transaction.signatures.find((entry) => !isZeroSignature(entry));
    if (sig) return bs58.encode(sig);
  } catch {
    // fall through to error below
  }
  throw new Error('Wallet returned proof transaction bytes without a readable signature.');
}

function isZeroSignature(signature: Uint8Array): boolean {
  return signature.every((byte) => byte === 0);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
