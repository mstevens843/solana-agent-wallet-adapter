package com.agentic.wallet.config

import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed mirror of the JSON shape served by `/api/android-config` (see
 * `apps/render-web/src/cloud/androidConfig.ts`). Parse via [RemoteConfigSchema.parse].
 *
 * Field-by-field parsing tolerates the server adding new fields (forward-compat) and
 * missing fields (falls back to bundled defaults in [RemoteConfigDefaults]).
 */
data class RemoteConfig(
    val version: Int,
    val walletRegistry: List<WalletEntry>,
    val memoProofRouter: MemoProofRouterConfig,
    val featureFlags: Map<String, Boolean>,
) {
    fun walletEntryByPackage(packageName: String): WalletEntry? {
        if (packageName.isBlank()) return null
        val lower = packageName.lowercase()
        return walletRegistry.firstOrNull { entry ->
            entry.packageNames.any { it.equals(lower, ignoreCase = true) }
        }
    }
}

data class WalletEntry(
    val id: Int,
    val name: String,
    val packageNames: List<String>,
    val uriPatterns: List<String>,
    val iconSha256First8: String?,
    val supportsSignMessages: Boolean,
    val supportsSiws: Boolean,
    val forceSignThenRpc: Boolean,
)

data class MemoProofRouterConfig(
    val envelopeVersion: String,
    val proofMemoPrefix: String,
    val fallbackOnBlankPackage: Boolean,
)

object RemoteConfigSchema {
    fun parse(text: String): RemoteConfig? {
        if (text.isBlank()) return null
        return try {
            parseObject(JSONObject(text))
        } catch (_: Exception) {
            null
        }
    }

    private fun parseObject(json: JSONObject): RemoteConfig {
        val version = json.optInt("version", RemoteConfigDefaults.VERSION)
        // Reject downgraded payloads. If the server (or a stale on-disk cache from
        // a previous APK with a lower schema floor) sends a version below this
        // binary's bundled floor, fall back to bundled defaults instead of
        // accepting the older shape. Throws so the outer parse() catches and
        // returns null, prompting the loader to use RemoteConfigDefaults.
        if (version < RemoteConfigDefaults.VERSION) {
            throw IllegalArgumentException(
                "remote config version $version is below bundled floor ${RemoteConfigDefaults.VERSION}",
            )
        }
        val walletRegistry = parseWalletRegistry(json.optJSONArray("walletRegistry"))
        val memoProofRouter = parseMemoProofRouter(json.optJSONObject("memoProofRouter"))
        val featureFlags = parseFeatureFlags(json.optJSONObject("featureFlags"))
        return RemoteConfig(
            version = version,
            walletRegistry = walletRegistry,
            memoProofRouter = memoProofRouter,
            featureFlags = featureFlags,
        )
    }

    private fun parseWalletRegistry(array: JSONArray?): List<WalletEntry> {
        if (array == null) return RemoteConfigDefaults.WALLET_REGISTRY
        val entries = mutableListOf<WalletEntry>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            entries += WalletEntry(
                id = item.optInt("id", 0),
                name = item.optString("name", ""),
                packageNames = parseStringArray(item.optJSONArray("packageNames")),
                uriPatterns = parseStringArray(item.optJSONArray("uriPatterns")),
                iconSha256First8 = item.optString("iconSha256First8", "").takeIf { it.isNotBlank() },
                supportsSignMessages = item.optBoolean("supportsSignMessages", false),
                supportsSiws = item.optBoolean("supportsSiws", true),
                forceSignThenRpc = item.optBoolean("forceSignThenRpc", false),
            )
        }
        return if (entries.isEmpty()) RemoteConfigDefaults.WALLET_REGISTRY else entries
    }

    private fun parseMemoProofRouter(json: JSONObject?): MemoProofRouterConfig {
        if (json == null) return RemoteConfigDefaults.MEMO_PROOF_ROUTER
        val prefix = json.optString("proofMemoPrefix", "").takeIf { it.isNotBlank() }
            ?: RemoteConfigDefaults.MEMO_PROOF_ROUTER.proofMemoPrefix
        return MemoProofRouterConfig(
            envelopeVersion = json.optString("envelopeVersion", RemoteConfigDefaults.MEMO_PROOF_ROUTER.envelopeVersion),
            proofMemoPrefix = prefix,
            fallbackOnBlankPackage = json.optBoolean("fallbackOnBlankPackage", true),
        )
    }

    private fun parseFeatureFlags(json: JSONObject?): Map<String, Boolean> {
        if (json == null) return emptyMap()
        val map = mutableMapOf<String, Boolean>()
        for (key in json.keys()) {
            val raw = json.opt(key) ?: continue
            if (raw is Boolean) {
                map[key] = raw
            }
        }
        return map
    }

    private fun parseStringArray(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until array.length()) {
            val value = array.optString(i, "").trim()
            if (value.isNotBlank()) out += value
        }
        return out
    }
}

/**
 * Hardcoded fallback that ships with the APK and matches the server-side
 * `apps/render-web/src/cloud/androidConfig.ts` payload byte-for-byte at APK build time.
 * The APK uses these defaults until [RemoteConfigLoader] successfully fetches a fresh
 * config from the server. Keep in sync with the server module on every release.
 */
object RemoteConfigDefaults {
    const val VERSION = 1

    val MEMO_PROOF_ROUTER = MemoProofRouterConfig(
        envelopeVersion = "v1",
        proofMemoPrefix = "Agentic plan review proof v1\nSHA-256: ",
        fallbackOnBlankPackage = true,
    )

    val WALLET_REGISTRY: List<WalletEntry> = listOf(
        WalletEntry(
            id = 20,
            name = "phantom",
            packageNames = listOf("app.phantom"),
            uriPatterns = listOf("phantom.app"),
            iconSha256First8 = null,
            supportsSignMessages = false,
            supportsSiws = true,
            forceSignThenRpc = false,
        ),
        WalletEntry(
            id = 25,
            name = "solflare",
            packageNames = listOf("com.solflare.mobile"),
            uriPatterns = listOf("solflare.com"),
            iconSha256First8 = "245123d8a7fd8aa5",
            supportsSignMessages = false,
            supportsSiws = false,
            forceSignThenRpc = false,
        ),
        WalletEntry(
            id = 36,
            name = "backpack",
            packageNames = listOf("app.backpack.mobile"),
            uriPatterns = listOf("backpack.app"),
            iconSha256First8 = null,
            supportsSignMessages = true,
            supportsSiws = true,
            forceSignThenRpc = true,
        ),
        WalletEntry(
            id = 40,
            name = "jupiter",
            packageNames = listOf("ag.jup.jupiter.android"),
            uriPatterns = listOf("jup.ag", "jupiter"),
            iconSha256First8 = null,
            supportsSignMessages = true,
            supportsSiws = true,
            forceSignThenRpc = true,
        ),
        WalletEntry(
            id = 50,
            name = "seedvault",
            packageNames = listOf("com.solanamobile.seedvaultimpl"),
            uriPatterns = listOf("seedvault", "seed-vault", "seedvaultwallet", "solanamobilewallet"),
            iconSha256First8 = null,
            supportsSignMessages = false,
            supportsSiws = false,
            forceSignThenRpc = false,
        ),
    )

    // PARITY ANCHOR: must mirror FEATURE_FLAGS in
    // apps/render-web/src/cloud/androidConfig.ts. Operators flip these via
    // `/api/android-config`; bundled defaults are the safety net.
    val FEATURE_FLAGS: Map<String, Boolean> = mapOf(
        // Incident kill-switch: force EVERY wallet through the memo-tx proof
        // path (the most-tested branch of MWA routing) when a wallet vendor
        // ships a bad sign_messages handler. Default off; ops flips it on
        // server-side and changes propagate on next config refresh.
        "forceMemoTxFallback" to false,
    )

    val DEFAULT_CONFIG = RemoteConfig(
        version = VERSION,
        walletRegistry = WALLET_REGISTRY,
        memoProofRouter = MEMO_PROOF_ROUTER,
        featureFlags = FEATURE_FLAGS,
    )
}
