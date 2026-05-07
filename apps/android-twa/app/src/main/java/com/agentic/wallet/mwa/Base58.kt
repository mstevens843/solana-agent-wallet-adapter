package com.agentic.wallet.mwa

import java.math.BigInteger

object Base58 {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    private val BASE = BigInteger.valueOf(58)

    fun encode(input: ByteArray): String {
        if (input.isEmpty()) return ""
        var zeros = 0
        for (byte in input) {
            if (byte.toInt() == 0) zeros += 1 else break
        }
        var value = BigInteger(1, input)
        val builder = StringBuilder()
        while (value > BigInteger.ZERO) {
            val divRem = value.divideAndRemainder(BASE)
            value = divRem[0]
            builder.append(ALPHABET[divRem[1].toInt()])
        }
        repeat(zeros) { builder.append('1') }
        return builder.reverse().toString()
    }

    fun decode(input: String): ByteArray {
        if (input.isBlank()) return ByteArray(0)
        var value = BigInteger.ZERO
        for (char in input) {
            val digit = ALPHABET.indexOf(char)
            if (digit < 0) return ByteArray(0)
            value = value.multiply(BASE).add(BigInteger.valueOf(digit.toLong()))
        }
        val raw = value.toByteArray().let {
            if (it.size > 1 && it[0].toInt() == 0) it.copyOfRange(1, it.size) else it
        }
        val zeros = input.takeWhile { it == '1' }.length
        return ByteArray(zeros) + raw
    }
}
