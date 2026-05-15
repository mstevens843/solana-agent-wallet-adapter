package com.agentic.wallet.agent.provider

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit-only policy guards on [DefaultHttpExecutor] that don't need a real socket.
 *
 * Cancellation and the 1 MB response body cap require a wire-mock or live server to exercise;
 * they're documented as a Phase 7 instrumented-test follow-up. See the Phase 3 v3 plan file.
 */
class HttpExecutorPolicyTest {
    @Test
    fun rejectsHttpScheme() {
        val ex = runCatching {
            runBlocking {
                DefaultHttpExecutor().postJson("http://example.com/v1/chat/completions", emptyMap(), "{}")
            }
        }.exceptionOrNull()
        assertTrue("Expected ProviderHttpException, got $ex", ex is ProviderHttpException)
        val httpEx = ex as ProviderHttpException
        assertEquals(ProviderErrorCodes.INVALID_CONFIG, httpEx.code)
        assertTrue(
            "Error should reference https requirement: ${httpEx.message}",
            httpEx.message.contains("https://", ignoreCase = false),
        )
    }

    @Test
    fun rejectsBareScheme() {
        val ex = runCatching {
            runBlocking {
                DefaultHttpExecutor().postJson("example.com/v1/chat/completions", emptyMap(), "{}")
            }
        }.exceptionOrNull()
        assertTrue("Expected ProviderHttpException, got $ex", ex is ProviderHttpException)
        assertEquals(ProviderErrorCodes.INVALID_CONFIG, (ex as ProviderHttpException).code)
    }

    @Test
    fun acceptsHttpsSchemeCaseInsensitive() {
        // Even with malformed host the scheme check should pass; the actual connection will
        // fail later but that's not what this test exercises. We assert that the scheme guard
        // does not fire by confirming the failure mode is NETWORK / TIMEOUT, not INVALID_CONFIG.
        val ex = runCatching {
            runBlocking {
                DefaultHttpExecutor(
                    connectTimeoutMs = 250,
                    readTimeoutMs = 250,
                ).postJson("HTTPS://nonexistent-host.invalid/v1/anything", emptyMap(), "{}")
            }
        }.exceptionOrNull()
        // Either NETWORK (DNS resolution failure) or TIMEOUT — both are acceptable; the only
        // unacceptable outcome here would be INVALID_CONFIG, which would mean the scheme guard
        // wrongly rejected "HTTPS://".
        assertTrue("Expected ProviderHttpException, got $ex", ex is ProviderHttpException)
        val code = (ex as ProviderHttpException).code
        assertTrue(
            "Scheme guard should accept HTTPS:// (any case); got code=$code message=${ex.message}",
            code == ProviderErrorCodes.NETWORK || code == ProviderErrorCodes.TIMEOUT,
        )
    }
}
