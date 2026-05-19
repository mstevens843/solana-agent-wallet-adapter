package com.agentic.wallet.mwa

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Integration-style coverage of the memo-tx ownership-proof pipeline that
 * [MwaController.signProofMessage] runs for Phantom / Solflare / Seed Vault. The MWA
 * SDK call (`signTransactions`) is the only piece left to on-device smoke; everything
 * else is exercised here against [MemoProofRouter].
 */
class MemoProofRouterTest {

    private val seedVaultRecord = AgentMwaAuthRecord(
        publicKeyBase58 = Base58.encode(ByteArray(32) { 0x11.toByte() }),
        publicKeyBytes = ByteArray(32) { 0x11.toByte() },
        walletPackage = "com.solanamobile.seedvaultimpl",
        walletUriBase = "solanamobilewallet://v1",
        walletType = WalletRegistry.SEED_VAULT,
        authToken = "fake-auth-token",
        authenticated = true,
    )

    private val backpackRecord = seedVaultRecord.copy(
        walletPackage = "app.backpack.mobile",
        walletType = WalletRegistry.BACKPACK,
    )

    @Test
    fun useMemoTxFallback_seedVault() {
        assertTrue(MemoProofRouter.useMemoTxFallback(seedVaultRecord.walletPackage))
    }

    @Test
    fun useMemoTxFallback_phantomAndSolflare() {
        assertTrue(MemoProofRouter.useMemoTxFallback("app.phantom"))
        assertTrue(MemoProofRouter.useMemoTxFallback("com.solflare.mobile"))
    }

    @Test
    fun useMemoTxFallback_signMessagesCapableWallets() {
        assertFalse(MemoProofRouter.useMemoTxFallback(backpackRecord.walletPackage))
        assertFalse(MemoProofRouter.useMemoTxFallback("ag.jup.jupiter.android"))
        assertFalse(MemoProofRouter.useMemoTxFallback(""))
    }

    @Test
    fun buildUnsignedMemoTx_embedsUtf8MessageBytesAsMemoData() {
        val blockhash = ByteArray(32) { 0x22.toByte() }
        val message = "agent decision proof for Seed Vault"

        val unsignedTx = MemoProofRouter.buildUnsignedMemoTx(
            seedVaultRecord.publicKeyBytes,
            blockhash,
            message,
        )

        // Layout invariants taken from MemoProofTxTest.
        // 1 (sig count) + 64 (placeholder sig) + 3 (header) + 1 (acct keys count) +
        // 32 (feePayer) + 32 (memoProgram) + 32 (blockhash) + 1 (ix count) +
        // 1 (programIdIdx) + 1 (accountsLen) + 1 (accounts[0]) + 1 (dataLen) + memo.
        val memoBytes = message.toByteArray(Charsets.UTF_8)
        val expectedSize = 1 + 64 + 3 + 1 + 32 + 32 + 32 + 1 + 1 + 1 + 1 + 1 + memoBytes.size
        assertEquals(expectedSize, unsignedTx.size)

        // Fee payer should be at offset 1 + 64 + 3 + 1 = 69.
        assertArrayEquals(
            seedVaultRecord.publicKeyBytes,
            unsignedTx.copyOfRange(69, 69 + 32),
        )

        // The memo data is the last [memoBytes.size] bytes of the transaction.
        assertArrayEquals(
            memoBytes,
            unsignedTx.copyOfRange(unsignedTx.size - memoBytes.size, unsignedTx.size),
        )
    }

    @Test
    fun buildUnsignedMemoTx_rejectsShortFeePayer() {
        try {
            MemoProofRouter.buildUnsignedMemoTx(
                ByteArray(31), // wrong length
                ByteArray(32),
                "proof",
            )
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun resultFromSignedTx_extractsEd25519SignatureAndAssemblesResult() {
        // Synthetic signed-tx: compact-u16 count = 1 (single byte 0x01), then 64-byte
        // signature, then any tail bytes (the rest of the transaction message — not
        // parsed by extractEd25519SignatureFromSignedTx).
        val signature = ByteArray(64) { (it + 1).toByte() }
        val tail = ByteArray(40) { 0x42.toByte() }
        val signedTxBytes = byteArrayOf(0x01.toByte()) + signature + tail
        val signedTxBase64 = "OPAQUE_BASE64_PLACEHOLDER_FROM_WALLET"

        val result = MemoProofRouter.resultFromSignedTx(signedTxBase64, signedTxBytes)

        assertEquals(Base58.encode(signature), result.signature)
        assertEquals("tx-memo-proof", result.encoding)
        assertEquals(signedTxBase64, result.transactionBase64)
        assertEquals(null, result.txid)
    }

    @Test
    fun resultFromSignedTx_propagatesIllegalArgumentOnTruncatedTx() {
        // Compact-u16 count = 1, then only 20 bytes — far short of a 64-byte signature.
        val truncated = byteArrayOf(0x01.toByte()) + ByteArray(20)
        try {
            MemoProofRouter.resultFromSignedTx("ignored", truncated)
            fail("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            // expected — re-exposes MemoProofTx.extractEd25519SignatureFromSignedTx behavior.
        }
    }

    @Test
    fun endToEnd_seedVaultProofPipeline() {
        // Drive the same pipeline signProofMessage walks, minus the MWA SDK call:
        //   1. Build the unsigned memo-tx for the Seed Vault auth record.
        //   2. Splice a known 64-byte signature in where the wallet would have signed.
        //   3. Ask the router to assemble the AgentMwaSigningResult.
        //   4. Assert the result carries the right encoding, transaction, and signature.
        val blockhash = ByteArray(32) { 0x33.toByte() }
        val message = "Agentic Cloud sign-in proof — Seed Vault end-to-end"
        val walletSignature = ByteArray(64) { ((it * 7) and 0xFF).toByte() }

        val unsignedTx = MemoProofRouter.buildUnsignedMemoTx(
            seedVaultRecord.publicKeyBytes,
            blockhash,
            message,
        )

        // Replace the 64-byte placeholder signature at offset 1 with the wallet's signature.
        // This mirrors what a real MWA `sign_transactions` reply looks like after the wallet
        // fills in the signature slot.
        val signedTx = unsignedTx.copyOf()
        System.arraycopy(walletSignature, 0, signedTx, 1, walletSignature.size)

        // The caller in MwaController.signProofMessage decodes the wallet's Base64 string
        // into bytes before invoking resultFromSignedTx; here we provide a placeholder
        // string since the router only uses it as the transactionBase64 passthrough.
        val placeholderBase64 = "WALLET_SIGNED_TX_BASE64"
        val result = MemoProofRouter.resultFromSignedTx(placeholderBase64, signedTx)

        assertEquals("tx-memo-proof", result.encoding)
        assertEquals(placeholderBase64, result.transactionBase64)
        assertEquals(Base58.encode(walletSignature), result.signature)
    }

    @Test
    fun endToEnd_largeMemoStillProducesTxMemoProof() {
        // A multi-hundred-byte proof message exercises compact-u16's two-byte path inside
        // MemoProofTx; the router's contract should still hold.
        val blockhash = ByteArray(32) { 0x44.toByte() }
        val message = buildString {
            repeat(300) { append('a' + (it % 26)) }
        }
        val walletSignature = ByteArray(64) { 0x55.toByte() }

        val unsignedTx = MemoProofRouter.buildUnsignedMemoTx(
            seedVaultRecord.publicKeyBytes,
            blockhash,
            message,
        )
        val signedTx = unsignedTx.copyOf()
        System.arraycopy(walletSignature, 0, signedTx, 1, walletSignature.size)

        val result = MemoProofRouter.resultFromSignedTx("OPAQUE", signedTx)

        assertEquals("tx-memo-proof", result.encoding)
        assertEquals(Base58.encode(walletSignature), result.signature)
    }
}
