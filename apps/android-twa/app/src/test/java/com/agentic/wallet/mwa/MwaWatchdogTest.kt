package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Test

class MwaWatchdogTest {
    @Test
    fun resumeWatchdog_withoutForegroundExitClassifiesPickerDismissal() {
        val decision = mwaResumeWatchdogDecision(walletForegrounded = false)

        assertEquals(MWA_PICKER_DISMISS_GRACE_MS, decision.delayMs)
        assertEquals("USER_REJECTED", decision.code)
        assertEquals("STEP_PICKER_DISMISS_WATCHDOG", decision.waitStep)
        assertEquals("FAIL_PICKER_DISMISSED", decision.step)
        assertEquals("Wallet picker dismissed without selection", decision.userMessage)
    }

    @Test
    fun resumeWatchdog_afterWalletForegroundWaitsForWalletResult() {
        val decision = mwaResumeWatchdogDecision(walletForegrounded = true)

        assertEquals(MWA_HANDOFF_RETURN_GRACE_MS, decision.delayMs)
        assertEquals("MWA_HANDOFF_RETURNED_WITHOUT_RESULT", decision.code)
        assertEquals("STEP_HANDOFF_GRACE_WAIT", decision.waitStep)
        assertEquals("FAIL_MWA_HANDOFF_TIMEOUT", decision.step)
        assertEquals("Wallet handoff returned without completing the MWA request.", decision.userMessage)
    }
}
