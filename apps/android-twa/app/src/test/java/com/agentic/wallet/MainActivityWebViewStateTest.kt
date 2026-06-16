package com.agentic.wallet

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainActivityWebViewStateTest {

    @Test
    fun shouldRestoreSavedWebViewState_onlyForBundledLocalShell() {
        assertTrue(shouldRestoreSavedWebViewState("", savedInstanceStatePresent = true))
        assertFalse(shouldRestoreSavedWebViewState("", savedInstanceStatePresent = false))
        assertFalse(shouldRestoreSavedWebViewState("https://agentic-signer.com/demo", savedInstanceStatePresent = true))
    }

    @Test
    fun shouldReloadRemoteFromWebViewUrl_whenRemoteShellIsOnBundledFallback() {
        assertTrue(shouldReloadRemoteFromWebViewUrl(
            remoteWebUrl = "https://agentic-signer.com/demo",
            remoteWebHost = "agentic-signer.com",
            currentUrl = "https://agentic.local/",
        ))
    }

    @Test
    fun shouldReloadRemoteFromWebViewUrl_whenRemoteShellIsOnUnexpectedHost() {
        assertTrue(shouldReloadRemoteFromWebViewUrl(
            remoteWebUrl = "https://agentic-signer.com/demo",
            remoteWebHost = "agentic-signer.com",
            currentUrl = "https://example.com/demo",
        ))
    }

    @Test
    fun shouldReloadRemoteFromWebViewUrl_keepsCurrentRemoteHost() {
        assertFalse(shouldReloadRemoteFromWebViewUrl(
            remoteWebUrl = "https://agentic-signer.com/demo",
            remoteWebHost = "agentic-signer.com",
            currentUrl = "https://agentic-signer.com/app",
        ))
    }
}
