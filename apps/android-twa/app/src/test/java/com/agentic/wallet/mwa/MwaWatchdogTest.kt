package com.agentic.wallet.mwa

import org.junit.Assert.assertEquals
import org.junit.Test

class MwaWatchdogTest {
    @Test
    fun resumeWatchdog_withoutForegroundExitClassifiesPickerDismissal() {
        val decision = mwaResumeWatchdogDecision(leftHostForeground = false)

        assertEquals(MWA_PICKER_DISMISS_GRACE_MS, decision.delayMs)
        assertEquals("USER_REJECTED", decision.code)
        assertEquals("FAIL_PICKER_DISMISSED", decision.step)
        assertEquals("Wallet picker dismissed without selection", decision.userMessage)
    }

    @Test
    fun resumeWatchdog_afterForegroundExitClassifiesHandoffReturnWithoutResult() {
        val decision = mwaResumeWatchdogDecision(leftHostForeground = true)

        assertEquals(MWA_HANDOFF_RETURN_GRACE_MS, decision.delayMs)
        assertEquals("MWA_HANDOFF_RETURNED_WITHOUT_RESULT", decision.code)
        assertEquals("FAIL_MWA_HANDOFF_RETURNED_WITHOUT_RESULT", decision.step)
        assertEquals("Wallet handoff returned without completing the MWA request.", decision.userMessage)
    }
}
