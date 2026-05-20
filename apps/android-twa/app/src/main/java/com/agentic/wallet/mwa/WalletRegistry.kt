package com.agentic.wallet.mwa

import java.security.MessageDigest

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
    private const val SEED_VAULT_ICON_HEAD = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANgAAADY"
    private const val SEED_VAULT_ICON_TAIL_SENTINEL =
        "QChlppOaiUo1Z22pIwKl0xN6leqUK+T8P/q4PWPnCdaVAAAAAElFTkSuQmCC"
    // Solflare's MWA authorize reply on Seeker returns blank walletUriBase/walletPackage
    // and a 41 KB data:image/...;base64 PNG with no "solflare" text anywhere in it, so
    // every text matcher in inferPackage/walletType misses. The icon is a fixed asset, so
    // its SHA-256 first-8 fingerprint is stable across reconnects (verified on-device).
    // If Solflare ships a new icon, walletIconLogMetadata.walletIconKnownSolflare will
    // start logging false alongside the new hash — swap the constant or widen to a Set.
    private const val SOLFLARE_ICON_SHA256_8 = "245123d8a7fd8aa5"

    fun inferPackage(walletUriBase: String, explicitPackage: String = "", walletIcon: String = ""): String {
        if (explicitPackage.isNotBlank()) return explicitPackage
        val lower = "$walletUriBase $walletIcon".lowercase()
        return when {
            lower.contains("phantom.app") -> PHANTOM_PACKAGE
            lower.contains("solflare.com") -> SOLFLARE_PACKAGE
            lower.contains("backpack.app") -> BACKPACK_PACKAGE
            lower.contains("jup.ag") || lower.contains("jupiter") -> JUPITER_PACKAGE
            lower.contains("seedvault") || lower.contains("seed-vault") || lower.contains("seedvaultwallet") || lower.startsWith("solanamobilewallet:") -> SEED_VAULT_PACKAGE
            isKnownSolflareIcon(walletIcon) -> SOLFLARE_PACKAGE
            isKnownSeedVaultIcon(walletIcon) -> SEED_VAULT_PACKAGE
            else -> ""
        }
    }

    fun walletType(packageName: String, walletUriBase: String = "", walletIcon: String = ""): Int {
        val lower = "$packageName $walletUriBase $walletIcon".lowercase()
        return when {
            lower.contains("phantom") -> PHANTOM
            lower.contains("solflare") -> SOLFLARE
            lower.contains("backpack") -> BACKPACK
            lower.contains("jupiter") || lower.contains("jup.ag") -> JUPITER
            lower.contains("seedvault") || lower.contains("seed-vault") || lower.contains("seedvaultwallet") || lower.contains("solanamobilewallet") -> SEED_VAULT
            isKnownSolflareIcon(walletIcon) -> SOLFLARE
            isKnownSeedVaultIcon(walletIcon) -> SEED_VAULT
            else -> UNKNOWN
        }
    }

    fun isKnownSeedVaultIcon(walletIcon: String): Boolean {
        val normalized = normalizeWalletIconSignature(walletIcon)
        return normalized.contains(SEED_VAULT_ICON_HEAD) && normalized.contains(SEED_VAULT_ICON_TAIL_SENTINEL)
    }

    fun isKnownSolflareIcon(walletIcon: String): Boolean {
        if (walletIcon.isBlank()) return false
        return sha256First8(walletIcon.toByteArray(Charsets.UTF_8)) == SOLFLARE_ICON_SHA256_8
    }

    fun walletIconLogMetadata(walletIcon: String): Map<String, Any?> {
        val trimmed = walletIcon.trim()
        val normalized = normalizeWalletIconSignature(walletIcon)
        val kind = when {
            trimmed.isBlank() -> "blank"
            normalized.startsWith("data:image/") -> "data-image"
            normalized.startsWith("http://") || normalized.startsWith("https://") -> "url"
            else -> "inline"
        }
        return mapOf(
            "walletIconKind" to kind,
            "walletIconChars" to walletIcon.length,
            "walletIconSha256_8" to sha256First8(walletIcon.toByteArray(Charsets.UTF_8)),
            "walletIconKnownSeedVault" to isKnownSeedVaultIcon(walletIcon),
            "walletIconKnownSolflare" to isKnownSolflareIcon(walletIcon),
        )
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

    // Whether to advertise `supports.signMessage = true` to the JS bridge for a record
    // with the given [walletPackage]. False when the package is blank (we can't verify
    // the wallet — see MwaController.capabilitiesJson for the full rationale) or when
    // [messageSigningUnsupported] explicitly flags it. Mirrored by
    // `MemoProofRouter.useMemoTxFallback` so JS-side routing and Android-side routing
    // stay in agreement: any wallet for which `reportSignMessageSupported` returns false
    // takes the memo-tx fallback in `signProofMessage`.
    fun reportSignMessageSupported(walletPackage: String): Boolean =
        walletPackage.isNotBlank() && !messageSigningUnsupported(walletPackage)

    private fun sha256First8(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).take(8).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun normalizeWalletIconSignature(walletIcon: String): String =
        walletIcon.trim()
            .replace("\\/", "/")
            .replace("\\n", "")
            .filterNot { it.isWhitespace() }
}
