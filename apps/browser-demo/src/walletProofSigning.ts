/**
 * Centralized "sign a proof" path.
 *
 * Most wallets sign the UTF-8 proof bytes directly via `signMessage`. Several
 * wallet paths fail this path and need a memo-tx fallback instead:
 *   • Phantom — `get_capabilities` advertises only `supports_sign_and_send_transactions`.
 *   • Solflare — `get_capabilities` advertises only `solana:signTransactions`.
 *   • Seed Vault (Seeker) — the production "Wallet" app (`com.solanamobile.wallet`)
 *     advertises sign_messages but its Seed Management UI renders with only a Close
 *     button when invoked via sign_messages, returning CancellationException with no
 *     protocol reply. `sign_transactions` surfaces the normal two-tap + biometric
 *     approval and works.
 *   • Unknown wallets — when the MWA SDK returns no caller package and the wallet
 *     supplies no `walletUriBase` (e.g. the production Seeker case), Android can't
 *     fingerprint the responding wallet. `WalletRegistry.reportSignMessageSupported`
 *     defaults blank packages to `false` so this helper routes through the memo-tx
 *     fallback rather than gambling on direct `signMessage`.
 *
 * Calling `signMessage` on any of these hangs ~90s or shows an approve sheet that
 * returns "CancellationException (no message)" with no protocol-level reply. The
 * Android native bridge owns the workaround: when the connected wallet's MWA
 * capabilities report `supports.signMessage === false`, this helper routes proof
 * signing through the Android native `sign_proof` bridge kind, which signs a
 * memo-only legacy transaction whose memo data is the same proof bytes the message
 * path would have signed. The transaction is NEVER broadcast — the wallet signature
 * serves as ownership proof and a fresh blockhash expires harmlessly.
 *
 * The desktop QR relay for Phantom/Solflare uses the same memo-tx proof shape
 * directly from JS. Solflare QR can approve `signMessage` and still return to
 * `/qr-connect` without encrypted `nonce`/`data`, which strands the phone relay.
 * Its `signTransaction` deeplink is already the working path for swaps, so proofs
 * use a signed memo transaction there too.
 *
 * iOS-native wallet approvals use the same JS memo-tx proof fallback. Phantom,
 * Solflare, Backpack, and Jupiter all need `signTransaction` for the main wallet
 * action surface anyway, so proof-only actions avoid relying on per-wallet mobile
 * `signMessage` behavior while still producing a non-broadcast ownership proof.
 *
 * This module is the single entry point; per-host routing is in the native bridge
 * (see `apps/android-twa/app/src/main/java/com/agentic/wallet/mwa/MwaController.kt`
 * `signProofMessage`, the `WalletRegistry.reportSignMessageSupported` policy, and
 * `MemoProofRouter.useMemoTxFallback` — those three must agree).
 * Backend verifier: `apps/render-web/src/cloud/auth.ts` `verifyTxMemoProof`.
 */

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';
import { LEDGER_WALLET_NAME } from '@solana-agent-wallet-adapter/ledger-wallet';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

export type WalletProofEncoding = 'utf8-message' | 'tx-memo-proof';
export type WalletSignatureEncoding = 'base58' | 'base64';

export interface WalletProofSignature {
  signature: string;
  proofEncoding: WalletProofEncoding;
  /**
   * Signature encoding. Most Wallet Standard wallets (Phantom, Backpack,
   * Solflare web) return base58 for signMessage and the Android memo-tx
   * fallback also returns base58. We expose this field so future wallets that
   * return base64 can be carried through the proof envelope without silent
   * server rejection. Defaults to base58 when not explicitly known.
   */
  signatureEncoding: WalletSignatureEncoding;
  proofTxBase64?: string;
  proofMemoText?: string;
}

export interface ProofSigningAppState {
  selectedWalletName: string;
  address: string;
  androidNativeEnvironment: { isAndroidNative: boolean };
  iosNativeEnvironment?: { isIosNative: boolean };
  capabilities?: {
    backend?: string;
    supports?: {
      signMessage?: boolean;
      signTransaction?: boolean;
    };
  } | null;
}

export interface AndroidProofBackend {
  signProof(message: string, summary?: string): Promise<{
    signature: string;
    encoding: 'utf8' | 'tx-memo-proof';
    transactionBase64?: string;
  }>;
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PROOF_MEMO_PREFIX = 'Agentic plan review proof v1\nSHA-256: ';
type InstructionData = ConstructorParameters<typeof TransactionInstruction>[0]['data'];

export interface ProofSigningContext {
  getClient: () => SolanaSigningClient;
  getAppState: () => ProofSigningAppState;
  getLatestBlockhash: (cluster: Cluster) => Promise<{ blockhash: string }>;
  getAndroidProofBackend?: () => AndroidProofBackend | null;
}

let context: ProofSigningContext | null = null;

export function setProofSigningContext(ctx: ProofSigningContext): void {
  context = ctx;
}

/**
 * True when the current connection is an Android-native MWA wallet whose
 * `get_capabilities` reply does not include `sign_messages`. The native bridge
 * is the source of truth — JS does not string-match wallet names.
 */
export function shouldRouteProofThroughAndroidNative(state: ProofSigningAppState): boolean {
  if (!state.androidNativeEnvironment.isAndroidNative) return false;
  return state.capabilities?.supports?.signMessage === false;
}

export function shouldRouteProofThroughLedgerMemo(state: ProofSigningAppState): boolean {
  return state.selectedWalletName === LEDGER_WALLET_NAME;
}

export function shouldRouteProofThroughRemoteRelayMemo(state: ProofSigningAppState): boolean {
  return state.capabilities?.backend === 'remote-relay-deeplink'
    && state.capabilities?.supports?.signTransaction === true;
}

export function shouldRouteProofThroughIosNative(state: ProofSigningAppState): boolean {
  return state.iosNativeEnvironment?.isIosNative === true
    && state.capabilities?.supports?.signTransaction === true;
}

export async function signWalletProofMessage(
  message: string,
  summary: string,
  cluster: Cluster,
): Promise<WalletProofSignature> {
  if (!context) {
    throw new Error('Proof signing context is not ready — connect a wallet first.');
  }
  const state = context.getAppState();
  if (shouldRouteProofThroughAndroidNative(state)) {
    const backend = context.getAndroidProofBackend?.();
    if (!backend) {
      throw new Error('Android native proof backend is not available — reconnect the wallet and try again.');
    }
    const result = await backend.signProof(message, summary);
    if (result.encoding === 'tx-memo-proof') {
      if (!result.transactionBase64) {
        throw new Error('Android native MWA returned a tx-memo-proof result without transactionBase64.');
      }
      return {
        signature: result.signature,
        proofEncoding: 'tx-memo-proof',
        signatureEncoding: 'base58',
        proofTxBase64: result.transactionBase64,
        proofMemoText: message,
      };
    }
    return {
      signature: result.signature,
      proofEncoding: 'utf8-message',
      signatureEncoding: 'base58',
    };
  }
  if (shouldRouteProofThroughLedgerMemo(state)) {
    return signMemoTransactionProof(message, summary, cluster, state);
  }
  if (shouldRouteProofThroughRemoteRelayMemo(state)) {
    return signMemoTransactionProof(message, summary, cluster, state);
  }
  if (shouldRouteProofThroughIosNative(state)) {
    return signMemoTransactionProof(message, summary, cluster, state);
  }
  const client = context.getClient();
  const result = await client.signMessage(message, { cluster, summary });
  return {
    signature: result.signature,
    proofEncoding: 'utf8-message',
    signatureEncoding: 'base58',
  };
}

async function signMemoTransactionProof(
  message: string,
  summary: string,
  cluster: Cluster,
  state: ProofSigningAppState,
): Promise<WalletProofSignature> {
  if (!context) {
    throw new Error('Proof signing context is not ready — connect a wallet first.');
  }
  const client = context.getClient();
  const feePayer = new PublicKey(state.address);
  const { blockhash } = await context.getLatestBlockhash(cluster);
  const memoText = `${PROOF_MEMO_PREFIX}${await sha256Hex(message)}`;
  const tx = new Transaction({
    feePayer,
    recentBlockhash: blockhash,
  }).add(
    new TransactionInstruction({
      keys: [{ pubkey: feePayer, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: new TextEncoder().encode(memoText) as unknown as InstructionData,
    }),
  );
  const unsignedBase64 = bytesToBase64(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  const signed = await client.signTransaction(unsignedBase64, { cluster, summary });
  const signedBytes = base64ToBytes(signed.signature);
  const signature = signatureFromSignedLegacyTransaction(signedBytes, feePayer);
  return {
    signature,
    proofEncoding: 'tx-memo-proof',
    signatureEncoding: 'base58',
    proofTxBase64: signed.signature,
    proofMemoText: message,
  };
}

function signatureFromSignedLegacyTransaction(transactionBytes: Uint8Array, signer: PublicKey): string {
  const tx = Transaction.from(transactionBytes);
  const entry = tx.signatures.find((candidate) => candidate.publicKey.equals(signer));
  if (!entry?.signature) {
    throw new Error('Memo proof did not include the connected wallet signature.');
  }
  return bs58.encode(new Uint8Array(entry.signature));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
