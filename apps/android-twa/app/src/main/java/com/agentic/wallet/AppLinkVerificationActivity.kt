package com.agentic.wallet

import android.app.Activity
import android.os.Bundle

/**
 * Verification-only Android App Links endpoint.
 *
 * Wallets such as Backpack verify the MWA identity URI against Android's domain-verification
 * state. This activity gives Android an always-enabled HTTPS handler for the app's own
 * identity host without changing normal launch, WebView, or wallet-action flows.
 */
class AppLinkVerificationActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        finish()
    }
}
