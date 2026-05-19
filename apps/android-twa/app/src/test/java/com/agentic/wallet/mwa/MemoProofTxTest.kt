package com.agentic.wallet.mwa

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MemoProofTxTest {

    @Test
    fun compactU16_singleByte() {
        assertArrayEquals(byteArrayOf(0), MemoProofTx.compactU16(0))
        assertArrayEquals(byteArrayOf(1), MemoProofTx.compactU16(1))
        assertArrayEquals(byteArrayOf(127), MemoProofTx.compactU16(127))
    }

    @Test
    fun compactU16_twoByte() {
        assertArrayEquals(byteArrayOf(0x80.toByte(), 1), MemoProofTx.compactU16(128))
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0x7F), MemoProofTx.compactU16(16_383))
    }

    @Test
    fun compactU16_threeByte() {
        assertArrayEquals(byteArrayOf(0x80.toByte(), 0x80.toByte(), 1), MemoProofTx.compactU16(16_384))
        assertArrayEquals(byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0x03), MemoProofTx.compactU16(0xFFFF))
    }

    @Test
    fun memoProgramIdBytes_decodesTo32Bytes() {
        assertEquals(32, MemoProofTx.MEMO_PROGRAM_ID_BYTES.size)
        // Round-trip Base58 to confirm the constant matches the canonical address.
        assertEquals("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", Base58.encode(MemoProofTx.MEMO_PROGRAM_ID_BYTES))
    }

    @Test
    fun buildUnsignedMemoProofTransaction_layoutInvariants() {
        val feePayer = ByteArray(32) { 0x11.toByte() }
        val blockhash = ByteArray(32) { 0x22.toByte() }
        val memo = "hello".toByteArray(Charsets.UTF_8)

        val tx = MemoProofTx.buildUnsignedMemoProofTransaction(feePayer, blockhash, memo)

        // Compute the expected total length so any future change to the layout is loud.
        // 1 (sig count) + 64 (placeholder sig) + 3 (header) + 1 (acct keys count) + 32 (feePayer) +
        // 32 (memoProgram) + 32 (blockhash) + 1 (ix count) + 1 (programIdIdx) + 1 (accountsLen) +
        // 1 (accounts[0]) + 1 (dataLen) + 5 (memo) = 175.
        assertEquals(175, tx.size)

        var offset = 0
        assertEquals(1, tx[offset].toInt())
        offset += 1
        repeat(64) {
            assertEquals(0, tx[offset + it].toInt())
        }
        offset += 64
        assertArrayEquals(byteArrayOf(1, 0, 1), tx.copyOfRange(offset, offset + 3))
        offset += 3
        assertEquals(2, tx[offset].toInt())
        offset += 1
        assertArrayEquals(feePayer, tx.copyOfRange(offset, offset + 32))
        offset += 32
        assertArrayEquals(MemoProofTx.MEMO_PROGRAM_ID_BYTES, tx.copyOfRange(offset, offset + 32))
        offset += 32
        assertArrayEquals(blockhash, tx.copyOfRange(offset, offset + 32))
        offset += 32
        assertEquals(1, tx[offset].toInt())
        offset += 1
        assertEquals(1, tx[offset].toInt())
        offset += 1
        assertEquals(1, tx[offset].toInt())
        offset += 1
        assertEquals(0, tx[offset].toInt())
        offset += 1
        assertEquals(memo.size, tx[offset].toInt() and 0xFF)
        offset += 1
        assertArrayEquals(memo, tx.copyOfRange(offset, offset + memo.size))
    }

    @Test
    fun buildUnsignedMemoProofTransaction_rejectsBadFeePayer() {
        val short = ByteArray(31)
        val blockhash = ByteArray(32)
        val memo = "x".toByteArray(Charsets.UTF_8)
        try {
            MemoProofTx.buildUnsignedMemoProofTransaction(short, blockhash, memo)
            error("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            assertTrue(true)
        }
    }

    @Test
    fun buildUnsignedMemoProofTransaction_handlesLargeMemo() {
        val feePayer = ByteArray(32)
        val blockhash = ByteArray(32)
        val memo = ByteArray(300) { (it and 0xFF).toByte() }

        val tx = MemoProofTx.buildUnsignedMemoProofTransaction(feePayer, blockhash, memo)

        // 300 = 0x012C → compact-u16 encodes as 0xAC 0x02 (two bytes).
        // Total: 1 + 64 + 3 + 1 + 32 + 32 + 32 + 1 + 1 + 1 + 1 + 2 + 300 = 471.
        assertEquals(471, tx.size)
    }

    @Test
    fun extractEd25519Signature_singleSignature() {
        val sig = ByteArray(64) { it.toByte() }
        val signedTx = byteArrayOf(1) + sig + ByteArray(50) { 0x42.toByte() }
        val extracted = MemoProofTx.extractEd25519SignatureFromSignedTx(signedTx)
        assertArrayEquals(sig, extracted)
    }

    @Test
    fun extractEd25519Signature_rejectsTruncatedTx() {
        val signedTx = byteArrayOf(1) + ByteArray(20)
        try {
            MemoProofTx.extractEd25519SignatureFromSignedTx(signedTx)
            error("expected IllegalArgumentException")
        } catch (_: IllegalArgumentException) {
            assertTrue(true)
        }
    }
}
