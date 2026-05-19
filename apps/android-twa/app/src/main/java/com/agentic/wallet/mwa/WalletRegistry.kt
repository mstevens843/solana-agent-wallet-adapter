package com.agentic.wallet.mwa

object WalletRegistry {
    const val UNKNOWN = 0
    const val PHANTOM = 20
    const val SOLFLARE = 25
    const val BACKPACK = 36
    const val JUPITER = 40
    const val SEED_VAULT = 50

    private const val PHANTOM_PACKAGE = "app.phantom"
    private const val SOLFLARE_PACKAGE = "com.solflare.mobile"
    private const val BACKPACK_PACKAGE = "app.backpack.mobile"
    private const val JUPITER_PACKAGE = "ag.jup.jupiter.android"
    private const val SEED_VAULT_PACKAGE = "com.solanamobile.seedvaultimpl"

    fun inferPackage(walletUriBase: String, explicitPackage: String = ""): String {
        if (explicitPackage.isNotBlank()) return explicitPackage
        val lower = walletUriBase.lowercase()
        return when {
            lower.contains("phantom.app") -> PHANTOM_PACKAGE
            lower.contains("solflare.com") -> SOLFLARE_PACKAGE
            lower.contains("backpack.app") -> BACKPACK_PACKAGE
            lower.contains("jup.ag") || lower.contains("jupiter") -> JUPITER_PACKAGE
            lower.startsWith("solanamobilewallet:") -> SEED_VAULT_PACKAGE
            else -> ""
        }
    }

    fun walletType(packageName: String, walletUriBase: String = ""): Int {
        val lower = "$packageName $walletUriBase".lowercase()
        return when {
            lower.contains("phantom") -> PHANTOM
            lower.contains("solflare") -> SOLFLARE
            lower.contains("backpack") -> BACKPACK
            lower.contains("jupiter") || lower.contains("jup.ag") -> JUPITER
            lower.contains("seedvault") || lower.contains("solanamobilewallet") -> SEED_VAULT
            else -> UNKNOWN
        }
    }

    // Jupiter mobile is a WalletConnect/Reown wrapper rather than a native MWA wallet,
    // and its native sign_and_send_transactions handler chokes on Jupiter quote-API
    // v0 + ALT swap transactions in practice (the reference apps only exercise simple
    // memo txs, which is why this isn't documented in their KNOWN_ISSUES files).
    // Route Jupiter through the same sign-then-RPC path as Backpack so we control the
    // broadcast via the resolved Helius RPC URL. Jupiter's sign_transactions handler
    // works fine — only its sign_and_send wrapper is the problem.
    fun forceSignThenRpc(packageName: String): Boolean {
        val lower = packageName.lowercase()
        return lower.contains("backpack") || lower.contains("jupiter") || lower.contains("jup")
    }

    // Wallets whose MWA `sign_messages` either hangs or returns a Close-only approval
    // sheet with `CancellationException (no message)` and no protocol-level reply.
    //   • Phantom — advertises only `supports_sign_and_send_transactions`.
    //   • Solflare — advertises only `solana:signTransactions`.
    //   • Seed Vault — on Seeker hardware the Seed Management UI renders with only a
    //     Close button when invoked via sign_messages, even though `sign_transactions`
    //     surfaces the normal two-tap + biometric approval. Reference apps don't
    //     exercise sign_messages with Seed Vault, which is why this isn't in
    //     grant-godot/KNOWN_ISSUES.md.
    // Callers should use [MwaController.signProofMessage] (memo-tx fallback) or
    // [MemoProofRouter.useMemoTxFallback] instead of [MwaController.signMessages] for
    // these wallets.
    fun messageSigningUnsupported(packageName: String): Boolean {
        val lower = packageName.lowercase()
        return lower.contains("phantom") ||
            lower.contains("solflare") ||
            lower.contains("seedvault")
    }

    // Wallets whose MWA `sign_in` path falls back to `sign_messages` (per the Kotlin
    // clientlib's CAIP-122 fallback when the wallet doesn't return a native
    // signInResult) and therefore inherits the same hung-approval failure mode. Solflare
    // historically; Seed Vault joins the list on the same Seeker-hardware evidence as
    // [messageSigningUnsupported] above.
    fun supportsSiws(packageName: String): Boolean {
        val lower = packageName.lowercase()
        return !lower.contains("solflare") && !lower.contains("seedvault")
    }
}
