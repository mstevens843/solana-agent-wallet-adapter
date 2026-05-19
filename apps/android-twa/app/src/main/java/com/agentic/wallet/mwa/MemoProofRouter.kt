package com.agentic.wallet.mwa

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
 *   • The unsigned memo-tx byte layout.
 *   • The ed25519 signature extraction and result assembly.
 */
internal object MemoProofRouter {
    /**
     * Whether [walletPackage] needs the memo-tx fallback rather than a direct
     * `sign_messages` MWA call. Thin delegate over [WalletRegistry.messageSigningUnsupported]
     * — extracted as a named function so call sites read as intent ("this wallet needs
     * the fallback") and tests can lock routing decisions in.
     */
    fun useMemoTxFallback(walletPackage: String): Boolean =
        WalletRegistry.messageSigningUnsupported(walletPackage)

    /**
     * Builds the unsigned memo-only legacy transaction whose memo data is the UTF-8
     * encoding of [message]. Pure: no I/O, no Android APIs. [publicKeyBytes] must be the
     * 32-byte fee payer (= proof signer) public key; [blockhashBytes] must be the 32-byte
     * latest blockhash supplied by the caller.
     *
     * Throws [IllegalArgumentException] (from [MemoProofTx.buildUnsignedMemoProofTransaction])
     * when inputs have the wrong shape.
     */
    fun buildUnsignedMemoTx(
        publicKeyBytes: ByteArray,
        blockhashBytes: ByteArray,
        message: String,
    ): ByteArray {
        val memoBytes = message.toByteArray(Charsets.UTF_8)
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
