package com.agentic.wallet.agent.prompts

internal object DeviceAgentBoundaries {
    const val PLAN: String =
        "AI prepares a plan only. Wallet approval and signing happen later in the user wallet."
    const val REVIEW: String =
        "This AI review can approve, deny, or request more input. It cannot sign or submit a transaction."
    const val ASK: String =
        "This is conversational Q&A about a draft. It cannot sign or submit a transaction."
    const val REVIEW_DEFAULT_INSTRUCTION: String =
        "Review this draft before it is sent for wallet approval. Decide approve, deny, or needs_input."
}
