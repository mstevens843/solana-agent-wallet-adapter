package com.agentic.wallet.mwa

import com.agentic.wallet.config.RemoteConfigLoader
import java.security.MessageDigest

/**
 * Pure-JVM helpers for the ownership-proof memo-tx fallback path. Extracted from
 * [MwaController.signProofMessage] so unit tests can exercise the build/sign/extract
 * pipeline without an Android dependency on `android.util.Base64` or the MWA SDK.
 *
 * The caller (MwaController) keeps responsibility for:
 *   • Fetching the latest blockhash via JSON-RPC.
 *   • Driving the wallet through `signTransactions` over MWA.
 *   • Base64-decoding the wallet's signed-tx string.
 *   • Logging and error mapping.
 *
 * This object provides the parts that don't need any of that:
 *   • The routing decision (which wallets go through memo-tx vs direct sign_messages).
 *   • The proof memo envelope (a fixed-size hashed wrapper of the message, so the
 *     transaction stays under Solana's 1232-byte `PACKET_DATA_SIZE` limit regardless
 *     of how long the proof message text is).
 *   • The unsigned memo-tx byte layout.
 *   • The ed25519 signature extraction and result assembly.
 */
internal object MemoProofRouter {
    /**
     * Prefix of the memo envelope. The full memo is `PROOF_MEMO_PREFIX + sha256hex(message)`,
     * which is always exactly [PROOF_MEMO_PREFIX].length + 64 bytes regardless of how long
     * the underlying proof message is. The server-side verifier
     * (`apps/render-web/src/cloud/auth.ts` `verifyTxMemoProof`) recognizes this prefix and
     * recomputes SHA-256 of the claimed `proofMemoText` to confirm the signed memo binds
     * to the message bytes the dApp sent alongside `proofTxBase64`.
     *
     * The version marker (`v1`) lets future revisions evolve the envelope shape without
     * breaking existing signed proofs. Driven by `/api/android-config` so the prefix can
     * advance to `v2` via Render redeploy; the bundled fallback in
     * [com.agentic.wallet.config.RemoteConfigDefaults] keeps the APK working when the
     * server is unreachable. Server's [ACCEPTED_ENVELOPE_PREFIXES] must always include
     * every prefix a shipped APK might emit.
     */
    val PROOF_MEMO_PREFIX: String
        get() = RemoteConfigLoader.config().memoProofRouter.proofMemoPrefix
    /**
     * Whether [walletPackage] needs the memo-tx fallback rather than a direct
     * `sign_messages` MWA call. Returns true for:
     *  - The known-broken wallets (Phantom, Solflare, Seed Vault) via
     *    [WalletRegistry.messageSigningUnsupported].
     *  - Any session where [walletPackage] is blank AND the remote config's
     *    `fallbackOnBlankPackage` flag is true (default), because Phantom/Solflare return
     *    `walletUriBase: null` in their MWA authorize reply and the JS bridge doesn't
     *    yet supply a `targetWalletPackage`, so `record.walletPackage` is blank for
     *    every fresh Phantom/Solflare authorization (see device logcat
     *    `[MwaController] capabilitiesJson | DONE … walletPackage=""` followed by
     *    `signMessages | FAIL_TIMEOUT WALLET_HUNG` / `FAIL_WALLET_RESULT WALLET_CRASHED
     *    CancellationException`). Defaulting to the memo-tx fallback in that case is
     *    safe: every MWA wallet implements `sign_transactions`, and the server-side
     *    verifier accepts the `tx-memo-proof` envelope for any wallet. Once the JS
     *    layer ships an explicit wallet picker and forwards `targetWalletPackage`, the
     *    blank-package case stops triggering and wallets that *can* sign messages
     *    (e.g. Backpack) regain their native path — at which point we can flip
     *    `fallbackOnBlankPackage` to false via remote config.
     */
    fun useMemoTxFallback(walletPackage: String): Boolean {
        val routerConfig = RemoteConfigLoader.config().memoProofRouter
        if (walletPackage.isBlank()) return routerConfig.fallbackOnBlankPackage
        return WalletRegistry.messageSigningUnsupported(walletPackage)
    }

    /**
     * Builds the fixed-size memo envelope for [message]. Always
     * [PROOF_MEMO_PREFIX].length + 64 UTF-8 bytes (under 110 total) regardless of
     * how long [message] is, which is what keeps the final memo-tx safely under
     * Solana's 1232-byte `PACKET_DATA_SIZE` limit even for multi-KB plan-review
     * proofs (a 1249-byte message produced a 1420-byte tx and got `"Invalid
     * transaction. The transaction from the site is not properly formed and can't be
     * signed."` from Solflare and Seed Vault — see plan file for the device logcat).
     *
     * Pure: no I/O, no Android APIs. Suitable for unit tests.
     */
    fun buildProofMemo(message: String): String {
        val messageBytes = message.toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(messageBytes)
        val hex = buildString(digest.size * 2) {
            for (byte in digest) append("%02x".format(byte))
        }
        return PROOF_MEMO_PREFIX + hex
    }

    /**
     * Builds the unsigned memo-only legacy transaction whose memo data is the
     * hashed envelope of [message] (see [buildProofMemo]). Pure: no I/O, no Android
     * APIs. [publicKeyBytes] must be the 32-byte fee payer (= proof signer) public
     * key; [blockhashBytes] must be the 32-byte latest blockhash supplied by the
     * caller.
     *
     * Throws [IllegalArgumentException] (from [MemoProofTx.buildUnsignedMemoProofTransaction])
     * when inputs have the wrong shape.
     */
    fun buildUnsignedMemoTx(
        publicKeyBytes: ByteArray,
        blockhashBytes: ByteArray,
        message: String,
    ): ByteArray {
        val memoBytes = buildProofMemo(message).toByteArray(Charsets.UTF_8)
        return MemoProofTx.buildUnsignedMemoProofTransaction(publicKeyBytes, blockhashBytes, memoBytes)
    }

    /**
     * Given the wallet's signed-tx bytes (already Base64-decoded by the caller), extract
     * the ed25519 signature and assemble the final [AgentMwaSigningResult]. The caller
     * passes the original Base64 string back as [signedTxBase64] so the result can be
     * forwarded to the server verifier without re-encoding.
     *
     * Throws [IllegalArgumentException] when [signedTxBytes] is too short to contain the
     * 64-byte signature.
     */
    fun resultFromSignedTx(signedTxBase64: String, signedTxBytes: ByteArray): AgentMwaSigningResult {
        val sig = MemoProofTx.extractEd25519SignatureFromSignedTx(signedTxBytes)
        return AgentMwaSigningResult(
            signature = Base58.encode(sig),
            encoding = "tx-memo-proof",
            transactionBase64 = signedTxBase64,
        )
    }
}
