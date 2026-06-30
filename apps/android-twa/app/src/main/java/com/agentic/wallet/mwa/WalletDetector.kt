package com.agentic.wallet.mwa

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * Enumerates which MWA-compatible wallets are installed and detects Solana Mobile
 * hardware (Seeker / Saga). Surfaced through the JS bridge as `detectWallets` /
 * `detectDevice`. Parity with `cocos-solana-mwa/.../mwa/WalletDetector.java`.
 *
 * Manifest `<queries><package …>` entries are required for `getPackageInfo` to find
 * non-installed apps on Android 11+; see `AndroidManifest.xml`.
 */
object WalletDetector {

    data class KnownWallet(
        val name: String,
        val packageName: String,
        val storeUrl: String,
        val walletType: Int,
        val packageAliases: List<String> = emptyList(),
    )

    val KNOWN_WALLETS: List<KnownWallet> = listOf(
        KnownWallet("Phantom", "app.phantom", "https://play.google.com/store/apps/details?id=app.phantom", WalletRegistry.PHANTOM),
        KnownWallet("Solflare", "com.solflare.mobile", "https://play.google.com/store/apps/details?id=com.solflare.mobile", WalletRegistry.SOLFLARE),
        KnownWallet(
            "Backpack",
            WalletRegistry.BACKPACK_PACKAGE,
            "https://backpack.app/download",
            WalletRegistry.BACKPACK,
            packageAliases = listOf(WalletRegistry.BACKPACK_LEGACY_PACKAGE),
        ),
        KnownWallet("Jupiter", "ag.jup.jupiter.android", "https://play.google.com/store/apps/details?id=ag.jup.jupiter.android", WalletRegistry.JUPITER),
        KnownWallet("Seed Vault", "com.solanamobile.seedvaultimpl", "https://solanamobile.com/seeker", WalletRegistry.SEED_VAULT),
        KnownWallet("Espresso Cash", "com.pleasecrypto.flutter", "https://play.google.com/store/apps/details?id=com.pleasecrypto.flutter", WalletRegistry.UNKNOWN),
    )

    /**
     * Returns one JSON object per [KNOWN_WALLETS] entry plus an `installed` flag and `versionName`
     * (when available). Order matches [KNOWN_WALLETS] so callers can render a stable picker.
     */
    fun detectInstalledWallets(context: Context): JSONArray {
        val pm = context.packageManager
        val results = JSONArray()
        for (wallet in KNOWN_WALLETS) {
            val installed = installedWalletPackage(pm, wallet)
            results.put(
                JSONObject()
                    .put("name", wallet.name)
                    .put("packageName", installed?.first ?: wallet.packageName)
                    .put("storeUrl", wallet.storeUrl)
                    .put("walletType", wallet.walletType)
                    .put("installed", installed != null)
                    .put("versionName", installed?.second.orEmpty()),
            )
        }
        AgentMwaLog.info(
            "WalletDetector",
            "detectInstalledWallets",
            "DONE",
            "wallet detection complete",
            mapOf("count" to results.length(), "installedCount" to (0 until results.length()).count { results.getJSONObject(it).optBoolean("installed") }),
        )
        return results
    }

    private fun installedWalletPackage(pm: PackageManager, wallet: KnownWallet): Pair<String, String>? {
        for (packageName in listOf(wallet.packageName) + wallet.packageAliases) {
            val info = try {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(packageName, 0)
            } catch (_: PackageManager.NameNotFoundException) {
                null
            } catch (err: Throwable) {
                AgentMwaLog.warn(
                    "WalletDetector",
                    "detectInstalledWallets",
                    "FAIL_LOOKUP",
                    "package lookup failed",
                    mapOf("package" to packageName, "class" to err.javaClass.simpleName, "message" to err.message),
                )
                null
            }
            if (info != null) return packageName to info.versionName.orEmpty()
        }
        return null
    }

    /**
     * Detects Solana Mobile hardware. Mirrors cocos `WalletDetector.detectDevice` logic:
     * manufacturer == "Solana Mobile" AND (model contains "Seeker"|"Chapter2"|"Saga").
     */
    fun detectDevice(): JSONObject {
        val manufacturer = (Build.MANUFACTURER ?: "").trim()
        val model = (Build.MODEL ?: "").trim()
        val product = (Build.PRODUCT ?: "").trim()
        val device = (Build.DEVICE ?: "").trim()
        val isSolanaMobile = manufacturer.equals("Solana Mobile", ignoreCase = true)
        val isSeeker = isSolanaMobile && (
            model.contains("Seeker", ignoreCase = true) ||
                model.contains("Chapter2", ignoreCase = true) ||
                product.contains("seeker", ignoreCase = true)
            )
        val isSaga = isSolanaMobile && model.contains("Saga", ignoreCase = true)
        return JSONObject()
            .put("isSolanaMobile", isSolanaMobile)
            .put("isSeeker", isSeeker)
            .put("isSaga", isSaga)
            .put("manufacturer", manufacturer)
            .put("model", model)
            .put("product", product)
            .put("device", device)
            .put("sdkInt", Build.VERSION.SDK_INT)
    }
}
