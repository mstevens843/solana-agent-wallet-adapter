package com.agentic.wallet.mwa

import java.io.ByteArrayOutputStream

/**
 * Hand-rolled Solana legacy memo-only transaction serializer for the
 * Phantom/Solflare/Seed-Vault ownership-proof fallback. These wallets either don't
 * implement `sign_messages` over MWA (Phantom, Solflare) or do so in a way that
 * hangs/cancels (Seed Vault on Seeker), so the proof path substitutes a memo-only
 * `sign_transactions` call. The signed transaction is NEVER broadcast.
 *
 * The caller (typically [MemoProofRouter.buildUnsignedMemoTx]) is expected to pass
 * a fixed-size hashed envelope as [memoBytes] — see
 * [MemoProofRouter.buildProofMemo] for the canonical envelope shape and
 * [MemoProofRouter.PROOF_MEMO_PREFIX] for the version marker. The envelope keeps
 * the total tx well under Solana's 1232-byte PACKET_DATA_SIZE limit even for
 * arbitrarily long plan-review messages — a previous design that embedded the
 * literal message bytes produced a 1673-byte tx for a 1502-byte message and was
 * rejected by Seed Vault with "Invalid transaction. The transaction from the site
 * is not properly formed and can't be signed." Phantom and Solflare don't validate
 * tx size today but the memo-tx is never broadcast so they got away with it; the
 * envelope-based contract works uniformly across all three.
 *
 * Account-key order is load-bearing: `staticAccountKeys[0]` MUST be the fee-payer
 * (signer + writable) and `staticAccountKeys[1]` MUST be the memo program (readonly
 * + unsigned). The server-side verifier at `apps/render-web/src/cloud/auth.ts`
 * `verifyTxMemoProof` extracts `feePayerKey = parsed.staticAccountKeys[0]` and
 * rejects the proof if it does not equal the claimed wallet pubkey. The wallet will
 * still happily sign a tx with reversed order, so this is the one bug a serializer
 * mistake would let silently through.
 *
 * Reference layout (legacy, no versioned prefix):
 *   - signatures: compact-u16 count (1) + 64 zero bytes placeholder
 *   - message:
 *       header: [numRequiredSigs=1, numReadonlySigned=0, numReadonlyUnsigned=1]
 *       accountKeys: compact-u16(2) + feePayer(32B) + memoProgram(32B)
 *       recentBlockhash: 32B
 *       instructions: compact-u16(1) + ix
 *           ix: programIdIndex=1, accountsLen=1, accounts=[0], dataLen=compact-u16(memoSize), data
 */
object MemoProofTx {
    val MEMO_PROGRAM_ID_BYTES: ByteArray = Base58.decode("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr").also {
        require(it.size == 32) { "Memo program ID must decode to 32 bytes; got ${it.size}" }
    }

    fun compactU16(value: Int): ByteArray {
        require(value in 0..0xFFFF) { "compact-u16 value out of range: $value" }
        val out = ByteArrayOutputStream(3)
        var remaining = value
        while (true) {
            val byte = remaining and 0x7F
            remaining = remaining ushr 7
            if (remaining == 0) {
                out.write(byte)
                return out.toByteArray()
            }
            out.write(byte or 0x80)
        }
    }

    fun buildUnsignedMemoProofTransaction(
        feePayerBytes: ByteArray,
        recentBlockhashBytes: ByteArray,
        memoBytes: ByteArray,
    ): ByteArray {
        require(feePayerBytes.size == 32) { "feePayer must be 32 bytes; got ${feePayerBytes.size}" }
        require(recentBlockhashBytes.size == 32) { "recentBlockhash must be 32 bytes; got ${recentBlockhashBytes.size}" }
        require(memoBytes.size in 0..0xFFFF) { "memo must encode in compact-u16; got ${memoBytes.size}" }

        val tx = ByteArrayOutputStream()

        tx.write(compactU16(1))
        tx.write(ByteArray(64))

        tx.write(1)
        tx.write(0)
        tx.write(1)

        tx.write(compactU16(2))
        tx.write(feePayerBytes)
        tx.write(MEMO_PROGRAM_ID_BYTES)

        tx.write(recentBlockhashBytes)

        tx.write(compactU16(1))
        tx.write(1)
        tx.write(compactU16(1))
        tx.write(0)
        tx.write(compactU16(memoBytes.size))
        tx.write(memoBytes)

        return tx.toByteArray()
    }

    fun extractEd25519SignatureFromSignedTx(signedTxBytes: ByteArray): ByteArray {
        require(signedTxBytes.isNotEmpty()) { "signedTxBytes is empty" }
        var offset = 0
        var sigCount = 0
        var shift = 0
        while (offset < signedTxBytes.size) {
            val byte = signedTxBytes[offset].toInt() and 0xFF
            offset += 1
            sigCount = sigCount or ((byte and 0x7F) shl shift)
            if (byte and 0x80 == 0) break
            shift += 7
            require(shift <= 21) { "Malformed compact-u16 signature count" }
        }
        require(sigCount >= 1) { "Signed transaction has no signatures" }
        require(signedTxBytes.size >= offset + 64) { "Signed transaction is too short to contain the first signature" }
        return signedTxBytes.copyOfRange(offset, offset + 64)
    }
}
