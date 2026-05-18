package com.agentic.wallet.agent.provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CitationFilterTest {
    private val pricingInstruction =
        "check helium mobile. lowest monthly plan. if less than \$20. approve."
    private val nonPricingInstruction = "is this a real token mint"

    private fun cite(url: String, title: String? = null) = Citation(url, title)

    @Test
    fun pricingKeywordsAreDetected() {
        assertTrue(CitationFilter.isPricingInstruction("what is the price of helium mobile"))
        assertTrue(CitationFilter.isPricingInstruction("check the monthly cost"))
        assertTrue(CitationFilter.isPricingInstruction("lowest fee"))
        assertTrue(CitationFilter.isPricingInstruction("current rate"))
        assertTrue(CitationFilter.isPricingInstruction("cheapest plan"))
        assertTrue(CitationFilter.isPricingInstruction("lowest plans"))
        assertTrue(CitationFilter.isPricingInstruction("vendor subscription"))
        assertTrue(CitationFilter.isPricingInstruction("per month"))
        assertTrue(CitationFilter.isPricingInstruction("per-month"))
        assertTrue(CitationFilter.isPricingInstruction("under \$20"))
        assertTrue(CitationFilter.isPricingInstruction("approve if less than \$5"))
    }

    @Test
    fun nonPricingTextDoesNotMatch() {
        assertFalse(CitationFilter.isPricingInstruction("is this a real token mint"))
        assertFalse(CitationFilter.isPricingInstruction("what protocol does jupiter use"))
        assertFalse(CitationFilter.isPricingInstruction("show recent transactions"))
        assertFalse(CitationFilter.isPricingInstruction(""))
        assertFalse(CitationFilter.isPricingInstruction("   "))
        assertFalse(CitationFilter.isPricingInstruction(null))
    }

    @Test
    fun dropsBlogNewsMediumSubstackOnPricingQuestions() {
        val filtered = CitationFilter.filterLowAuthorityCitations(
            listOf(
                cite("https://blog.heliummobile.com/break-free", "Break Free"),
                cite("https://news.vendor.com/article"),
                cite("https://medium.com/@user/post"),
                cite("https://author.substack.com/p/article"),
                cite("https://community.vendor.com/thread"),
                cite("https://forum.vendor.com/thread"),
                cite("https://user.wordpress.com/post"),
            ),
            pricingInstruction,
        )
        assertEquals(emptyList<Citation>(), filtered)
    }

    @Test
    fun preservesOfficialPricingPagesAndSupportSubdomains() {
        val filtered = CitationFilter.filterLowAuthorityCitations(
            listOf(
                cite("https://www.heliummobile.com/plans", "Plans"),
                cite("https://hellohelium.com/plans"),
                cite("https://support.hellohelium.com/faq"),
                cite("https://pricing.vendor.com/tiers"),
                cite("https://vendor.com/about"),
            ),
            pricingInstruction,
        )
        assertEquals(5, filtered.size)
        assertEquals("https://www.heliummobile.com/plans", filtered[0].url)
    }

    @Test
    fun nonPricingQuestionsArePassThrough() {
        val input = listOf(
            cite("https://blog.example.com/post"),
            cite("https://medium.com/@user/post"),
            cite("https://example.com/api"),
        )
        val filtered = CitationFilter.filterLowAuthorityCitations(input, nonPricingInstruction)
        assertEquals(3, filtered.size)
    }

    @Test
    fun mixedListIsTrimmedToOfficialDomains() {
        val filtered = CitationFilter.filterLowAuthorityCitations(
            listOf(
                cite("https://blog.heliummobile.com/zero-plan"),
                cite("https://www.heliummobile.com/plans", "Plans"),
                cite("https://hellohelium.com/"),
            ),
            pricingInstruction,
        )
        assertEquals(
            listOf("https://www.heliummobile.com/plans", "https://hellohelium.com/"),
            filtered.map { it.url },
        )
    }

    @Test
    fun malformedUrlsArePreserved() {
        val filtered = CitationFilter.filterLowAuthorityCitations(
            listOf(cite("not-a-url"), cite("https://www.heliummobile.com/plans")),
            pricingInstruction,
        )
        // Malformed entries pass through; we'd rather surface them than silently drop
        // potentially-legitimate citations on a parsing edge case.
        assertEquals(2, filtered.size)
    }
}
