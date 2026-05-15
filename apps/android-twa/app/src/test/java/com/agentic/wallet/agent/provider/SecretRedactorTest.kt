package com.agentic.wallet.agent.provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretRedactorTest {
    @Test
    fun replacesExactSecret() {
        val secret = "sk-test-1234567890ABCDEF"
        val redacted = SecretRedactor.redact("Authorization failed for $secret", secret)
        assertFalse(redacted.contains(secret))
        assertTrue(redacted.contains("[redacted]"))
    }

    @Test
    fun trimsSecretBeforeReplacing() {
        val redacted = SecretRedactor.redact("Failed: foo-secret", "  foo-secret  ")
        assertEquals("Failed: [redacted]", redacted)
    }

    @Test
    fun noOpOnBlankSecret() {
        assertEquals("hello world", SecretRedactor.redact("hello world", ""))
        assertEquals("hello world", SecretRedactor.redact("hello world", null))
        assertEquals("hello world", SecretRedactor.redact("hello world", "   "))
    }

    @Test
    fun redactsBearerPattern() {
        val redacted = SecretRedactor.redact("got Bearer abcDEF.123-456_xyz token", null)
        assertTrue(redacted.contains("Bearer [redacted]"))
        assertFalse(redacted.contains("abcDEF.123-456_xyz"))
    }

    @Test
    fun redactsSkProjPattern() {
        val redacted = SecretRedactor.redact("error sk-proj-ABCDEF12345 occurred", null)
        assertTrue(redacted.contains("sk-proj-[redacted]"))
        assertFalse(redacted.contains("sk-proj-ABCDEF12345"))
    }

    @Test
    fun redactsKeyValueStyle() {
        val redacted = SecretRedactor.redact("api-key=ABCDEFGHIJKLMNOP", null)
        assertTrue("Expected key redaction, got $redacted", redacted.contains("[redacted]"))
        assertFalse(redacted.contains("ABCDEFGHIJKLMNOP"))
    }

    @Test
    fun redactsJwtLikePattern() {
        val jwt = "eyJabcd1234567890abcd.eyJsubbing0987654321abc.signaturedeadbeefcafe1234"
        val redacted = SecretRedactor.redact("got token $jwt then proceeded", null)
        assertTrue("Expected JWT redaction, got: $redacted", redacted.contains("[redacted-token]"))
        assertFalse(redacted.contains(jwt))
    }

    @Test
    fun redactsBareSkPattern() {
        val redacted = SecretRedactor.redact("error with sk-ABCDEF1234567890XYZ occurred", null)
        assertTrue(redacted.contains("sk-[redacted]"))
        assertFalse(redacted.contains("ABCDEF1234567890XYZ"))
    }

    @Test
    fun redactsMultipleSecretOccurrences() {
        val secret = "sk-test-multi-EXAMPLEKEY"
        val redacted = SecretRedactor.redact(
            "first $secret then again $secret done",
            secret,
        )
        assertFalse("Both occurrences should be redacted: $redacted", redacted.contains(secret))
        // both occurrences replaced — at least two [redacted] markers
        assertEquals(2, "\\[redacted\\]".toRegex().findAll(redacted).count())
    }

    @Test
    fun regexFallbacksApplyEvenWithoutExactSecret() {
        val redacted = SecretRedactor.redact("calling Bearer abc123XYZ_456.token-data more text", null)
        assertTrue(redacted.contains("Bearer [redacted]"))
        assertFalse(redacted.contains("abc123XYZ_456.token-data"))
    }
}
