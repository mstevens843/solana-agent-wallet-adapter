/**
 * Centralized "sign a proof" path.
 *
 * Most wallets sign the UTF-8 proof bytes directly via `signMessage`. Several
 * Android-native MWA wallets fail this path and need a memo-tx fallback instead:
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
 * This module is the single entry point; per-host routing is in the native bridge
 * (see `apps/android-twa/app/src/main/java/com/agentic/wallet/mwa/MwaController.kt`
 * `signProofMessage`, the `WalletRegistry.reportSignMessageSupported` policy, and
 * `MemoProofRouter.useMemoTxFallback` — those three must agree).
 * Backend verifier: `apps/render-web/src/cloud/auth.ts` `verifyTxMemoProof`.
 */

import type { Cluster, SolanaSigningClient } from '@solana-agent-wallet-adapter/core';

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
  capabilities?: { supports?: { signMessage?: boolean } } | null;
}

export interface AndroidProofBackend {
  signProof(message: string, summary?: string): Promise<{
    signature: string;
    encoding: 'utf8' | 'tx-memo-proof';
    transactionBase64?: string;
  }>;
}

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
  const client = context.getClient();
  const result = await client.signMessage(message, { cluster, summary });
  return {
    signature: result.signature,
    proofEncoding: 'utf8-message',
    signatureEncoding: 'base58',
  };
}
