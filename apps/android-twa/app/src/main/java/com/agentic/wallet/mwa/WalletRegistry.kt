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

    fun forceSignThenRpc(packageName: String): Boolean = packageName.lowercase().contains("backpack")

    fun messageSigningUnsupported(packageName: String): Boolean {
        val lower = packageName.lowercase()
        return lower.contains("phantom") || lower.contains("solflare")
    }

    fun standaloneSignTransactionUnsupported(packageName: String): Boolean =
        packageName.lowercase().contains("jupiter") || packageName.lowercase().contains("jup")

    fun supportsSiws(packageName: String): Boolean = !packageName.lowercase().contains("solflare")
}
