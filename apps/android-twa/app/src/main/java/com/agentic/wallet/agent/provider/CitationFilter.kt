package com.agentic.wallet.agent.provider

import java.net.URI

// Kotlin port of apps/browser-demo/src/deviceAgent/provider/citationFilter.ts.
// Drops low-authority web research sources (blog/news subdomains, medium.com,
// substack.com, etc.) on pricing questions to prevent stale-price citations.
// Non-pricing questions pass through unchanged.

internal data class Citation(
    val url: String,
    val title: String? = null,
    val citedText: String? = null,
)

internal object CitationFilter {
    // Word-bounded pricing keywords OR a dollar-sign-then-digit anywhere. The dollar
    // alternative has no \b prefix because `$` is non-word and "under $20" has no word
    // boundary directly before `$`.
    private val PRICING_KEYWORDS = Regex(
        "\\b(price|cost|fee|rate|plan|plans|subscription|monthly|per[\\s-]?month)\\b|\\\$\\s*\\d",
        RegexOption.IGNORE_CASE,
    )

    // Hostnames matching any pattern are dropped on pricing questions.
    private val LOW_AUTHORITY_HOST_PATTERNS: List<Regex> = listOf(
        Regex("^blog\\.", RegexOption.IGNORE_CASE),
        Regex("^news\\.", RegexOption.IGNORE_CASE),
        Regex("\\.blog$", RegexOption.IGNORE_CASE),
        Regex("(^|\\.)medium\\.com$", RegexOption.IGNORE_CASE),
        Regex("(^|\\.)substack\\.com$", RegexOption.IGNORE_CASE),
        Regex("(^|\\.)wordpress\\.com$", RegexOption.IGNORE_CASE),
        Regex("(^|\\.)tumblr\\.com$", RegexOption.IGNORE_CASE),
        Regex("^community\\.", RegexOption.IGNORE_CASE),
        Regex("^forum\\.", RegexOption.IGNORE_CASE),
    )

    fun isPricingInstruction(text: String?): Boolean {
        if (text == null || text.trim().isEmpty()) return false
        return PRICING_KEYWORDS.containsMatchIn(text)
    }

    fun filterLowAuthorityCitations(
        citations: List<Citation>,
        instructionText: String?,
    ): List<Citation> {
        if (!isPricingInstruction(instructionText)) return citations.toList()
        return citations.filter { !isLowAuthorityHost(it.url) }
    }

    private fun isLowAuthorityHost(url: String): Boolean {
        if (url.isEmpty()) return false
        val host = try {
            URI(url).host?.lowercase() ?: return false
        } catch (_: Throwable) {
            // Malformed URLs are NOT filtered — match TS behavior of "tolerate without dropping".
            return false
        }
        if (host.isEmpty()) return false
        for (pattern in LOW_AUTHORITY_HOST_PATTERNS) {
            if (pattern.containsMatchIn(host)) return true
        }
        return false
    }
}
