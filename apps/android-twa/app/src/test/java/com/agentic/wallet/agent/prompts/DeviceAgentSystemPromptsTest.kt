package com.agentic.wallet.agent.prompts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pin the Phase 3 verbatim prompts against canary substrings ported from
 * apps/browser-demo/src/planner.ts (lines 1374, 1638, 1701). If the planner
 * source moves or the Kotlin copy drifts, one of these assertions will fire.
 *
 * The substrings are deliberately small and uniquely identifying so the test
 * is robust against deliberate but minor wording tweaks; major rewrites or
 * accidental truncation will still surface.
 */
class DeviceAgentSystemPromptsTest {
    @Test
    fun planPromptIsVerbatim() {
        val text = DeviceAgentSystemPrompts.PLAN
        assertFalse("PLAN must not have leading/trailing whitespace", text != text.trim())
        assertTrue(text.startsWith("You convert Solana wallet user requests into structured approval plans."))
        assertTrue(text.contains("Return only JSON with string fields intent, route, risk, approval, and safeguards"))
        assertTrue(text.contains("`inputTokenLabel`"))
        assertTrue(text.contains("(for example \"POPCAT\")"))
        // 913dabb guardrails: forward-looking phrasing required, auto-* phrasings forbidden.
        assertTrue(text.contains("forward-looking terms"))
        assertTrue(text.contains("pre-submitted/signed/approved"))
        assertTrue(text.endsWith("The wallet user must approve separately."))
    }

    @Test
    fun reviewPromptIsVerbatim() {
        val text = DeviceAgentSystemPrompts.REVIEW
        assertFalse("REVIEW must not have leading/trailing whitespace", text != text.trim())
        assertTrue(text.startsWith("You review a Solana wallet action draft before it is sent for wallet approval."))
        assertTrue(text.contains("evidence.findings as an array of {label,value,tone}"))
        assertTrue(text.contains("Use plan.actionType to decide which checks apply"))
        assertTrue(text.contains("For first-class adapter actions"))
        assertTrue(text.contains("jupiter_lend_*"))
        assertTrue(text.contains("\"approve if under \$20, deny if over \$20\""))
        assertTrue(text.contains("\"approve if under \$X\", \"deny if over \$Y\""))
        assertTrue(text.contains("\"\$16.79\""))
        assertTrue(text.contains("STRUCTURED DECISION CONTRACT"))
        assertTrue(text.contains("POLICY BUNDLE"))
        assertTrue(text.contains("Treat policyBundle.evaluations as the source of truth"))
        assertTrue(text.contains("policyBundle.hasBlockingFailure is true"))
        assertTrue(text.contains("AND/OR policyBundle.atoms"))
        assertTrue(text.contains("UNTRUSTED USER TEXT"))
        assertTrue(text.contains("<UNTRUSTED_USER_TEXT ...>...</UNTRUSTED_USER_TEXT>"))
        assertTrue(text.endsWith("never user-supplied prose."))
    }

    @Test
    fun askPromptIsVerbatim() {
        val text = DeviceAgentSystemPrompts.ASK
        assertFalse("ASK must not have leading/trailing whitespace", text != text.trim())
        assertTrue(text.startsWith("You answer the user's question about a Solana wallet action plan."))
        assertTrue(text.contains("1 to 4 sentences, plain English"))
        assertTrue(text.contains("connectors can only read facts or prepare wallet-gated work"))
        assertTrue(text.contains("use policyBundle.evaluations as source-of-truth"))
        assertTrue(text.contains("answer only those targeted outside facts"))
        assertTrue(text.endsWith("say so plainly and state what fact is missing."))
    }

    @Test
    fun boundariesAreVerbatim() {
        assertEquals(
            "AI prepares a plan only. Wallet approval and signing happen later in the user wallet.",
            DeviceAgentBoundaries.PLAN,
        )
        assertEquals(
            "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction.",
            DeviceAgentBoundaries.REVIEW,
        )
        assertEquals(
            "This is conversational Q&A about a draft. It cannot sign or submit a transaction.",
            DeviceAgentBoundaries.ASK,
        )
        assertEquals(
            "Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input.",
            DeviceAgentBoundaries.REVIEW_DEFAULT_INSTRUCTION,
        )
    }
}
