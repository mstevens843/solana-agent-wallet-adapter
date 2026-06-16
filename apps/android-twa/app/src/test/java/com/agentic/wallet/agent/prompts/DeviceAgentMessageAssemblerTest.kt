package com.agentic.wallet.agent.prompts

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class DeviceAgentMessageAssemblerTest {
    private val fixedClock: Clock =
        Clock.fixed(Instant.parse("2026-05-15T12:00:00Z"), ZoneOffset.UTC)

    @Test
    fun planUsesPlanSystemPrompt() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject().put("userPrompt", "send 1 SOL to alice"),
        )
        assertEquals(DeviceAgentSystemPrompts.PLAN, messages.system)
        val userJson = JSONObject(messages.userContent)
        assertEquals("send 1 SOL to alice", userJson.optString("userPrompt"))
        assertEquals(DeviceAgentBoundaries.PLAN, userJson.optString("requiredBoundary"))
    }

    @Test
    fun planAcceptsBrowserPayloadAliases() {
        val connector = JSONObject().put("id", "jupiter").put("selected", true)
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("prompt", "swap 1 SOL for USDC")
                .put("connectorContext", JSONArray().put(connector)),
        )

        val userJson = JSONObject(messages.userContent)
        assertEquals("swap 1 SOL for USDC", userJson.optString("userPrompt"))
        assertEquals("jupiter", userJson.optJSONArray("protocolConnectors")?.getJSONObject(0)?.optString("id"))
        assertFalse(userJson.has("prompt"))
        assertFalse(userJson.has("connectorContext"))
    }

    @Test
    fun planConnectorRuleDefaultsWhenNoSelectedConnector() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "swap")
                .put(
                    "protocolConnectors",
                    JSONArray().put(JSONObject().put("id", "jupiter").put("selected", false)),
                ),
        )
        val rule = JSONObject(messages.userContent).optString("connectorRule")
        assertTrue(rule.startsWith("Only propose first-class or Blink executable actions"))
    }

    @Test
    fun planConnectorRuleSwitchesWhenSelected() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "swap")
                .put(
                    "protocolConnectors",
                    JSONArray().put(
                        JSONObject()
                            .put("id", "jupiter")
                            .put("name", "Jupiter")
                            .put("selected", true),
                    ),
                ),
        )
        val rule = JSONObject(messages.userContent).optString("connectorRule")
        assertTrue(rule.startsWith("Use the selected protocol connector only: Jupiter."))
        assertTrue(rule.contains("Do not switch protocols."))
        assertTrue(rule.contains("The wallet owner must approve separately."))
    }

    @Test
    fun planConnectorRuleHonorsSelectedOnly() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "swap")
                .put(
                    "protocolConnectors",
                    JSONArray().put(
                        JSONObject()
                            .put("id", "raydium")
                            .put("selectedOnly", true),
                    ),
                ),
        )
        val rule = JSONObject(messages.userContent).optString("connectorRule")
        assertTrue(rule.contains("raydium"))
    }

    @Test
    fun reviewDefaultsToNotRequiredResearchObject() {
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(
            JSONObject()
                .put("plan", JSONObject().put("intent", "swap"))
                .put("walletAddress", "ABC123"),
            fixedClock,
        )
        assertEquals(DeviceAgentSystemPrompts.REVIEW, messages.system)
        val userJson = JSONObject(messages.userContent)
        val research = userJson.optJSONObject("research")!!
        assertEquals(false, research.optBoolean("needed", true))
        assertEquals("not_required", research.optString("mode"))
        assertEquals("2026-05-15T12:00:00Z", research.optString("currentDate"))
        assertEquals(3, research.optInt("maxSearches"))
        assertEquals(DeviceAgentBoundaries.REVIEW, userJson.optString("requiredBoundary"))
        assertEquals("ABC123", userJson.optString("walletAddress"))
    }

    @Test
    fun reviewPreservesCallerProvidedResearchObject() {
        val research = JSONObject()
            .put("needed", true)
            .put("mode", "auto_current_facts")
            .put("currentDate", "2026-05-16T03:00:00Z")
            .put("maxSearches", 2)
            .put("sourcePolicy", "prefer official sources")
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(
            JSONObject()
                .put("plan", JSONObject().put("intent", "swap"))
                .put("research", research),
            fixedClock,
        )
        val userJson = JSONObject(messages.userContent)
        assertEquals(research.toString(), userJson.optJSONObject("research")?.toString())
    }

    @Test
    fun reviewDefaultsInstructionAndWalletAndCluster() {
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(JSONObject(), fixedClock)
        val userJson = JSONObject(messages.userContent)
        assertEquals(DeviceAgentBoundaries.REVIEW_DEFAULT_INSTRUCTION, userJson.optString("instruction"))
        assertEquals("not_connected", userJson.optString("walletAddress"))
        assertEquals("unknown", userJson.optString("cluster"))
        assertNotNull(userJson.opt("plan"))
    }

    @Test
    fun askDefaultsToNotRequiredResearchObjectAndUsesAskBoundary() {
        val messages = DeviceAgentMessageAssembler.buildAskMessages(
            JSONObject()
                .put("question", "is this safe?")
                .put("plan", JSONObject().put("intent", "swap")),
            fixedClock,
        )
        assertEquals(DeviceAgentSystemPrompts.ASK, messages.system)
        val userJson = JSONObject(messages.userContent)
        assertEquals("is this safe?", userJson.optString("question"))
        assertEquals(DeviceAgentBoundaries.ASK, userJson.optString("requiredBoundary"))
        val research = userJson.optJSONObject("research")!!
        assertEquals(false, research.optBoolean("needed", true))
        assertEquals("not_required", research.optString("mode"))
    }

    @Test
    fun askPreservesCallerProvidedResearchObject() {
        val research = JSONObject()
            .put("needed", true)
            .put("mode", "auto_current_facts")
            .put("currentDate", "2026-05-16T03:00:00Z")
            .put("maxSearches", 1)
        val messages = DeviceAgentMessageAssembler.buildAskMessages(
            JSONObject()
                .put("question", "what is the current price?")
                .put("research", research),
            fixedClock,
        )
        val userJson = JSONObject(messages.userContent)
        assertEquals(research.toString(), userJson.optJSONObject("research")?.toString())
    }

    @Test
    fun localizeBuildsTargetLanguageDisplayCopyAndOutputShape() {
        val payload = JSONObject()
            .put("language", "zh-Hans")
            .put("summary", "Approve the swap.")
        val messages = DeviceAgentMessageAssembler.buildLocalizeMessages(payload)
        assertEquals(DeviceAgentSystemPrompts.LOCALIZE, messages.system)
        val userJson = JSONObject(messages.userContent)
        assertEquals("zh-Hans", userJson.optString("targetLanguage"))
        assertEquals("Approve the swap.", userJson.optJSONObject("displayCopy")?.optString("summary"))
        val shape = userJson.optJSONObject("requiredOutputShape")!!
        // Full-coverage output shape: every translatable array the model may return.
        assertTrue(shape.has("findings"))
        assertTrue(shape.has("questions"))
        assertTrue(shape.has("reviewers"))
        assertTrue(shape.has("policies"))
        assertTrue(shape.has("facts"))
        assertTrue(shape.has("counterfactuals"))
    }

    @Test
    fun planUserNotesOmittedWhenAbsent() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject().put("userPrompt", "send 1 SOL"),
        )
        val userJson = JSONObject(messages.userContent)
        // Mirror planner.ts: undefined fields are omitted by JSON.stringify
        assertFalse(
            "userNotes must be absent when payload doesn't carry it",
            userJson.has("userNotes"),
        )
    }

    @Test
    fun planUserNotesPreservedWhenPresent() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "send 1 SOL")
                .put("userNotes", "remember the memo"),
        )
        val userJson = JSONObject(messages.userContent)
        assertTrue(userJson.has("userNotes"))
        assertEquals("remember the memo", userJson.optString("userNotes"))
    }

    @Test
    fun planPreBuiltConnectorRulePassesThrough() {
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "swap")
                .put("connectorRule", "custom rule X.")
                .put(
                    "protocolConnectors",
                    JSONArray().put(JSONObject().put("id", "jupiter").put("selected", true)),
                ),
        )
        val userJson = JSONObject(messages.userContent)
        // Pre-built connectorRule must NOT be replaced with derivation output
        assertEquals("custom rule X.", userJson.optString("connectorRule"))
    }

    @Test
    fun planTemplateAndParametersRoundTripUnchanged() {
        val template = JSONObject().put("id", "swap").put("title", "Swap SOL→USDC")
        val parameters = JSONObject().put("amount", "1.5").put("slippageBps", "50")
        val messages = DeviceAgentMessageAssembler.buildPlanMessages(
            JSONObject()
                .put("userPrompt", "swap")
                .put("template", template)
                .put("parameters", parameters),
        )
        val userJson = JSONObject(messages.userContent)
        assertEquals(template.toString(), userJson.optJSONObject("template")?.toString())
        assertEquals(parameters.toString(), userJson.optJSONObject("parameters")?.toString())
    }

    @Test
    fun reviewContextDeepEqualsInput() {
        val context = JSONObject()
            .put(
                "evidenceFacts",
                JSONArray().put(JSONObject().put("id", "f1")).put(JSONObject().put("id", "f2")),
            )
            .put("evidenceGate", JSONObject().put("decision", "pass"))
        val messages = DeviceAgentMessageAssembler.buildReviewMessages(
            JSONObject()
                .put("plan", JSONObject().put("intent", "swap"))
                .put("context", context),
            fixedClock,
        )
        val userJson = JSONObject(messages.userContent)
        assertEquals(context.toString(), userJson.optJSONObject("context")?.toString())
    }

    @Test
    fun researchModeIsCollectFactsOnlyWhenTargetsAbsent() {
        val messages = DeviceAgentMessageAssembler.buildResearchMessages(
            JSONObject()
                .put("instruction", "check helium mobile lowest plan if less than \$20 approve")
                .put("walletAddress", "ABC123"),
            null,
            fixedClock,
        )
        val userJson = JSONObject(messages.userContent)
        val research = userJson.optJSONObject("research")!!
        assertEquals(true, research.optBoolean("needed"))
        assertEquals("collect_current_facts_only", research.optString("mode"))
        assertEquals("2026-05-15T12:00:00Z", research.optString("currentDate"))
        assertEquals(3, research.optInt("maxSearches"))
        assertTrue(research.optString("sourcePolicy").startsWith("Prefer official vendor pricing pages"))
        assertTrue(messages.system.contains("research current outside facts"))
        assertTrue(messages.system.contains("Prefer official vendor pricing pages"))
        assertEquals("ABC123", userJson.optString("walletAddress"))
        assertTrue(
            userJson.optString("requiredBoundary").contains("This research pass cannot approve"),
        )
    }

    @Test
    fun researchModeIsResolveAtomsWhenTargetsPresent() {
        val targets = JSONArray()
            .put(JSONObject().put("id", "helium-plan-price").put("description", "lowest monthly plan"))
        val messages = DeviceAgentMessageAssembler.buildResearchMessages(
            JSONObject().put("instruction", "approve if cheaper than \$20"),
            targets,
            fixedClock,
        )
        val userJson = JSONObject(messages.userContent)
        val research = userJson.optJSONObject("research")!!
        assertEquals("resolve_specific_atoms", research.optString("mode"))
        // researchTargets must be inside context, not at the user-content root.
        val context = userJson.optJSONObject("context")!!
        assertEquals(targets.toString(), context.optJSONArray("researchTargets")?.toString())
        assertTrue(messages.system.contains("atomic fact requests"))
    }

    @Test
    fun researchMergesExistingContextWithTargets() {
        val existingContext = JSONObject().put("evidenceFacts", JSONArray().put(JSONObject().put("id", "f1")))
        val targets = JSONArray().put(JSONObject().put("id", "plan-cost"))
        val messages = DeviceAgentMessageAssembler.buildResearchMessages(
            JSONObject()
                .put("instruction", "do thing")
                .put("context", existingContext),
            targets,
            fixedClock,
        )
        val context = JSONObject(messages.userContent).optJSONObject("context")!!
        assertNotNull(context.optJSONArray("evidenceFacts"))
        assertEquals(targets.toString(), context.optJSONArray("researchTargets")?.toString())
    }

    @Test
    fun researchDefaultsInstructionAndWalletAndCluster() {
        val messages = DeviceAgentMessageAssembler.buildResearchMessages(JSONObject(), null, fixedClock)
        val userJson = JSONObject(messages.userContent)
        assertEquals(DeviceAgentBoundaries.REVIEW_DEFAULT_INSTRUCTION, userJson.optString("instruction"))
        assertEquals("not_connected", userJson.optString("walletAddress"))
        assertEquals("unknown", userJson.optString("cluster"))
    }
}
