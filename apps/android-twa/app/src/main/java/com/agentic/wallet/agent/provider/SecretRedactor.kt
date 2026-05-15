package com.agentic.wallet.agent.provider

internal object SecretRedactor {
    private val BEARER_PATTERN = Regex("Bearer\\s+[A-Za-z0-9._~+/=-]+", RegexOption.IGNORE_CASE)
    private val SK_PROJ_PATTERN = Regex("\\bsk-proj-[A-Za-z0-9_-]{8,}\\b")
    private val SK_PATTERN = Regex("\\bsk-[A-Za-z0-9_-]{8,}\\b")
    private val JWT_PATTERN = Regex("\\b[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\b")
    private val KEY_VALUE_PATTERN = Regex(
        "(api[-_ ]?key|token|secret)([\"':=\\s]+)([^\"',\\s\\[]{8,})",
        RegexOption.IGNORE_CASE,
    )

    fun redact(value: String, secret: String?): String {
        var current = value
        val trimmed = secret?.trim().orEmpty()
        if (trimmed.isNotEmpty()) {
            current = current.replace(trimmed, "[redacted]")
        }
        current = BEARER_PATTERN.replace(current, "Bearer [redacted]")
        current = SK_PROJ_PATTERN.replace(current, "sk-proj-[redacted]")
        current = SK_PATTERN.replace(current, "sk-[redacted]")
        current = JWT_PATTERN.replace(current, "[redacted-token]")
        current = KEY_VALUE_PATTERN.replace(current) { match ->
            "${match.groupValues[1]}${match.groupValues[2]}[redacted]"
        }
        return current
    }
}
