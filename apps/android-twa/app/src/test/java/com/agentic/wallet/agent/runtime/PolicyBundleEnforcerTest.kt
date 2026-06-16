package com.agentic.wallet.agent.runtime

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyBundleEnforcerTest {
    private fun bundleWithFailure(): JSONObject = JSONObject()
        .put("hasBlockingFailure", true)
        .put(
            "evaluations",
            JSONArray()
                .put(
                    JSONObject()
                        .put("atomId", "atom.price.sol.gte.80")
                        .put("pass", true)
                        .put(
                            "finding",
                            JSONObject()
                                .put("label", "SOL price")
                                .put("value", "$146.50 — jupiter")
                                .put("tone", "good"),
                        ),
                )
                .put(
                    JSONObject()
                        .put("atomId", "atom.external_price.helium.lt.20")
                        .put("pass", false)
                        .put(
                            "finding",
                            JSONObject()
                                .put("label", "Helium plan")
                                .put("value", "$25 — web")
                                .put("tone", "fail"),
                        ),
                ),
        )

    private fun payload(bundle: JSONObject?): JSONObject {
        val payload = JSONObject()
        if (bundle != null) {
            payload.put("context", JSONObject().put("policyBundle", bundle))
        }
        return payload
    }

    @Test
    fun overridesApproveToDeny() {
        val result = JSONObject().put("text", """{"decision":"approve","reason":"looks good"}""")
        val out = PolicyBundleEnforcer.enforce(result, payload(bundleWithFailure()))
        val parsed = JSONObject(out.getString("text"))
        assertEquals("deny", parsed.getString("decision"))
        assertTrue(parsed.getString("reason").contains("Helium plan"))
        val blocking = parsed.getJSONArray("blockingFactIds")
        assertEquals(1, blocking.length())
        assertEquals("atom.external_price.helium.lt.20", blocking.getString(0))
        val override = out.getJSONObject("safetyOverride")
        assertEquals("policy_bundle_blocking_failure", override.getString("reason"))
        assertEquals("approve", override.getString("originalDecision"))
        assertEquals("deny", override.getString("enforcedDecision"))
    }

    @Test
    fun passesThroughDeny() {
        val text = """{"decision":"deny","reason":"bad"}"""
        val result = JSONObject().put("text", text)
        val out = PolicyBundleEnforcer.enforce(result, payload(bundleWithFailure()))
        val parsed = JSONObject(out.getString("text"))
        assertEquals("deny", parsed.getString("decision"))
        assertEquals("bad", parsed.getString("reason"))
        assertTrue(parsed.getJSONObject("evidence").getJSONArray("findings").length() > 0)
        assertNull(out.optJSONObject("safetyOverride"))
    }

    @Test
    fun passesThroughWhenNoBundle() {
        val text = """{"decision":"approve","reason":"ok"}"""
        val result = JSONObject().put("text", text)
        val out = PolicyBundleEnforcer.enforce(result, payload(null))
        assertEquals(text, out.getString("text"))
        assertNull(out.optJSONObject("safetyOverride"))
    }

    @Test
    fun passesThroughWhenBundleHasNoFailure() {
        val bundle = bundleWithFailure().put("hasBlockingFailure", false)
        val text = """{"decision":"approve","reason":"ok"}"""
        val result = JSONObject().put("text", text)
        val out = PolicyBundleEnforcer.enforce(result, payload(bundle))
        assertNull(out.optJSONObject("safetyOverride"))
    }

    @Test
    fun languageCanonicalizationFailureForcesNeedsInput() {
        val bundle = JSONObject()
            .put("hasBlockingFailure", false)
            .put("evaluations", JSONArray())
            .put(
                "language",
                JSONObject()
                    .put("sourceLanguage", "zh-Hans")
                    .put("canonicalizationStatus", "failed")
                    .put("requiresInput", true),
            )
        val result = JSONObject().put("text", """{"decision":"approve","reason":"ok"}""")
        val out = PolicyBundleEnforcer.enforce(result, payload(bundle))
        val parsed = JSONObject(out.getString("text"))
        assertEquals("needs_input", parsed.getString("decision"))
        assertTrue(parsed.getString("reason").contains("could not safely translate"))
        assertEquals("policy.language.canonicalization", parsed.getJSONArray("missingFactIds").getString(0))
        assertTrue(parsed.getJSONObject("evidence").getBoolean("languageSafetyApplied"))
        assertEquals("policy_language_canonicalization_failed", out.getJSONObject("safetyOverride").getString("reason"))
    }

    @Test
    fun passesThroughWhenLlmTextNotJson() {
        val result = JSONObject().put("text", "this is not json")
        val out = PolicyBundleEnforcer.enforce(result, payload(bundleWithFailure()))
        assertNull(out.optJSONObject("safetyOverride"))
    }

    @Test
    fun safetyOverrideIncludesBlockingFactIds() {
        val result = JSONObject().put("text", """{"decision":"approve","reason":"good"}""")
        val out = PolicyBundleEnforcer.enforce(result, payload(bundleWithFailure()))
        val override = out.getJSONObject("safetyOverride")
        val ids = override.getJSONArray("blockingFactIds")
        assertEquals(1, ids.length())
        assertEquals("atom.external_price.helium.lt.20", ids.getString(0))
    }
}
