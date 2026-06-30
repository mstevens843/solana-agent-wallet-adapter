package com.agentic.wallet.mwa

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object MwaIdentityPreflight {
    private const val ASSETLINKS_PATH = "/.well-known/assetlinks.json"
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 5_000

    suspend fun logBeforeConnect(
        context: Context,
        identity: AgentMwaIdentity,
        requestId: String,
        cluster: AgentCluster,
        targetWalletPackage: String,
        resolvedTargetWalletPackage: String,
    ) = withContext(Dispatchers.IO) {
        val origin = identityOrigin(identity.uri)
        val appPackage = context.packageName
        val appFingerprints = appSigningFingerprints(context, appPackage)
        val appLinksState = appLinksVerificationState(context, appPackage, origin)
        val baseMetadata = mapOf(
            "requestId" to requestId,
            "cluster" to cluster.id,
            "appPackage" to appPackage,
            "identityName" to identity.name,
            "identityUri" to identity.uri,
            "identityOrigin" to origin.orEmpty(),
            "identityHttps" to (origin?.startsWith("https://") == true),
            "identityIconUri" to identity.iconUri,
            "targetWalletPackage" to targetWalletPackage,
            "resolvedTargetWalletPackage" to resolvedTargetWalletPackage,
            "appSigningSha256" to appFingerprints.joinToString(";"),
            "appSigningSha256Count" to appFingerprints.size,
        ) + appLinksState.toLogMetadata() +
            installedPackageMetadata(context, "targetWallet", resolvedTargetWalletPackage) +
            backpackFamilyMetadata(context)

        AgentMwaLog.info(
            "MwaIdentityPreflight",
            "logBeforeConnect",
            "START",
            "checking Android MWA identity inputs before wallet launch",
            baseMetadata,
        )

        if (origin == null) {
            AgentMwaLog.warn(
                "MwaIdentityPreflight",
                "logBeforeConnect",
                "FAIL_IDENTITY_URI",
                "identityUri is not an absolute HTTP(S) URL",
                baseMetadata,
            )
            return@withContext
        }
        if (appLinksState.shouldWarn) {
            AgentMwaLog.warn(
                "MwaIdentityPreflight",
                "logBeforeConnect",
                "WARN_APP_LINKS_STATE",
                "Android App Links state may prevent wallets from verifying the identity URI host",
                baseMetadata,
            )
        }
        if (appFingerprints.isEmpty()) {
            AgentMwaLog.warn(
                "MwaIdentityPreflight",
                "logBeforeConnect",
                "FAIL_APP_SIGNING_CERT",
                "could not read APK signing certificate fingerprints",
                baseMetadata,
            )
        }

        val url = "$origin$ASSETLINKS_PATH"
        val conn = try {
            (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/json")
            }
        } catch (err: Exception) {
            AgentMwaLog.failure(
                "MwaIdentityPreflight",
                "logBeforeConnect",
                "FAIL_OPEN_CONNECTION",
                "Digital Asset Links URL did not yield an HTTP connection",
                err,
                baseMetadata + mapOf("assetlinksUrl" to url),
            )
            return@withContext
        }

        try {
            val status = conn.responseCode
            val contentType = conn.contentType.orEmpty()
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val result = inspectAssetLinksJson(
                text = text,
                appPackage = appPackage,
                expectedFingerprints = appFingerprints,
            )
            val metadata = baseMetadata + mapOf(
                "assetlinksUrl" to url,
                "httpStatus" to status,
                "contentType" to contentType,
                "bodyChars" to text.length,
                "bodySha256_8" to sha256First8(text.toByteArray(Charsets.UTF_8)),
            ) + result.toLogMetadata()
            val step = if (status in 200..299 && result.fingerprintMatch) "SUCCESS" else "WARN_VERIFICATION"
            val message = if (result.fingerprintMatch) {
                "Digital Asset Links contains this app package and signing certificate"
            } else {
                "Digital Asset Links did not prove this app package/signing certificate"
            }
            if (result.fingerprintMatch) {
                AgentMwaLog.info("MwaIdentityPreflight", "logBeforeConnect", step, message, metadata)
            } else {
                AgentMwaLog.warn("MwaIdentityPreflight", "logBeforeConnect", step, message, metadata)
            }
        } catch (err: Exception) {
            AgentMwaLog.failure(
                "MwaIdentityPreflight",
                "logBeforeConnect",
                "FAIL_FETCH",
                "Digital Asset Links preflight fetch failed",
                err,
                baseMetadata + mapOf("assetlinksUrl" to url),
            )
        } finally {
            conn.disconnect()
        }
    }

    fun installedPackageMetadata(context: Context, prefix: String, packageName: String): Map<String, Any?> {
        if (packageName.isBlank()) {
            return mapOf(
                "${prefix}Package" to "",
                "${prefix}Installed" to false,
                "${prefix}VersionName" to "",
                "${prefix}VersionCode" to "",
            )
        }
        val info = packageInfo(context, packageName, 0)
        return mapOf(
            "${prefix}Package" to packageName,
            "${prefix}Installed" to (info != null),
            "${prefix}VersionName" to info?.versionName.orEmpty(),
            "${prefix}VersionCode" to versionCode(info),
        )
    }

    fun backpackFamilyMetadata(context: Context): Map<String, Any?> =
        WalletRegistry.BACKPACK_PACKAGES.fold(emptyMap()) { acc, packageName ->
            val key = if (packageName == WalletRegistry.BACKPACK_PACKAGE) "backpackStandalone" else "backpackLegacy"
            acc + installedPackageMetadata(context, key, packageName)
        }

    fun resolveBackpackTargetPackage(context: Context, targetWalletPackage: String): String {
        val requested = targetWalletPackage.trim()
        if (requested.isBlank() || !WalletRegistry.isBackpackPackage(requested)) return requested
        return WalletRegistry.BACKPACK_PACKAGES.firstOrNull { packageInfo(context, it, 0) != null }
            ?: WalletRegistry.BACKPACK_PACKAGE
    }

    fun inspectAssetLinksJson(
        text: String,
        appPackage: String,
        expectedFingerprints: List<String>,
    ): AssetLinksInspection {
        val parsed = try {
            JSONArray(text)
        } catch (err: Exception) {
            return AssetLinksInspection(
                parseOk = false,
                packageEntryFound = false,
                relationFound = false,
                namespaceOk = false,
                fingerprintMatch = false,
                expectedFingerprints = normalizeFingerprints(expectedFingerprints),
                assetLinksFingerprints = emptyList(),
                matchedFingerprints = emptyList(),
                error = err.javaClass.simpleName,
            )
        }
        val normalizedExpected = normalizeFingerprints(expectedFingerprints)
        var packageEntryFound = false
        var relationFound = false
        var namespaceOk = false
        val fingerprints = mutableListOf<String>()
        val matched = mutableListOf<String>()
        for (index in 0 until parsed.length()) {
            val item = parsed.optJSONObject(index) ?: continue
            val target = item.optJSONObject("target") ?: JSONObject()
            if (target.optString("package_name", "") != appPackage) continue
            packageEntryFound = true
            namespaceOk = target.optString("namespace", "") == "android_app"
            relationFound = containsRelation(item.optJSONArray("relation"))
            val entryFingerprints = stringArray(target.optJSONArray("sha256_cert_fingerprints"))
                .mapNotNull { normalizeFingerprint(it) }
            fingerprints += entryFingerprints
            matched += entryFingerprints.filter { normalizedExpected.contains(it) }
        }
        return AssetLinksInspection(
            parseOk = true,
            packageEntryFound = packageEntryFound,
            relationFound = relationFound,
            namespaceOk = namespaceOk,
            fingerprintMatch = matched.isNotEmpty() && relationFound && namespaceOk,
            expectedFingerprints = normalizedExpected,
            assetLinksFingerprints = fingerprints.distinct(),
            matchedFingerprints = matched.distinct(),
            error = "",
        )
    }

    private fun identityOrigin(value: String): String? {
        val uri = runCatching { Uri.parse(value) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host ?: return null
        if (scheme != "https" && scheme != "http") return null
        return "$scheme://$host${if (uri.port > 0) ":${uri.port}" else ""}"
    }

    private fun appLinksVerificationState(
        context: Context,
        packageName: String,
        origin: String?,
    ): AppLinksVerificationState {
        val host = origin
            ?.let { runCatching { Uri.parse(it).host?.lowercase() }.getOrNull() }
            .orEmpty()
        if (host.isBlank()) {
            return AppLinksVerificationState.unsupported(host = host, error = "missing_identity_host")
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return AppLinksVerificationState.unsupported(host = host, error = "sdk_below_31")
        }
        return try {
            val manager = context.getSystemService(DomainVerificationManager::class.java)
                ?: return AppLinksVerificationState.unsupported(host = host, error = "manager_unavailable")
            val state = manager.getDomainVerificationUserState(packageName)
                ?: return AppLinksVerificationState.unsupported(host = host, error = "state_unavailable")
            val hostToState = state.hostToStateMap.orEmpty()
                .mapKeys { it.key.lowercase() }
                .toSortedMap()
            val hostState = hostToState[host]
            AppLinksVerificationState(
                supported = true,
                host = host,
                linkHandlingAllowed = state.isLinkHandlingAllowed,
                hostState = hostState,
                verifiedHosts = hostsForState(hostToState, DomainVerificationUserState.DOMAIN_STATE_VERIFIED),
                selectedHosts = hostsForState(hostToState, DomainVerificationUserState.DOMAIN_STATE_SELECTED),
                noneHosts = hostsForState(hostToState, DomainVerificationUserState.DOMAIN_STATE_NONE),
                error = "",
            )
        } catch (err: Throwable) {
            AppLinksVerificationState.unsupported(host = host, error = err.javaClass.simpleName)
        }
    }

    private fun hostsForState(hostToState: Map<String, Int>, state: Int): List<String> =
        hostToState.filterValues { it == state }.keys.toList()

    @Suppress("DEPRECATION")
    private fun appSigningFingerprints(context: Context, packageName: String): List<String> {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val info = packageInfo(context, packageName, flags) ?: return emptyList()
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = info.signingInfo ?: return emptyList()
            if (signingInfo.hasMultipleSigners()) {
                signingInfo.apkContentsSigners
            } else {
                signingInfo.signingCertificateHistory
            }
        } else {
            info.signatures
        } ?: return emptyList()
        return signatures.map { signatureSha256(it) }.distinct()
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(context: Context, packageName: String, flags: Int): PackageInfo? =
        try {
            context.packageManager.getPackageInfo(packageName, flags)
        } catch (_: Throwable) {
            null
        }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo?): String {
        if (info == null) return ""
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode.toString()
        } else {
            info.versionCode.toString()
        }
    }

    private fun signatureSha256(signature: Signature): String =
        fingerprint(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()))

    private fun normalizeFingerprints(values: List<String>): List<String> =
        values.mapNotNull { normalizeFingerprint(it) }.distinct()

    private fun normalizeFingerprint(value: String): String? {
        val hex = value.trim().replace(Regex("[^a-fA-F0-9]"), "").uppercase()
        if (hex.length != 64) return null
        return hex.chunked(2).joinToString(":")
    }

    private fun containsRelation(array: JSONArray?): Boolean =
        stringArray(array).contains("delegate_permission/common.handle_all_urls")

    fun appLinksStateName(state: Int?): String =
        when (state) {
            null -> "MISSING"
            DomainVerificationUserState.DOMAIN_STATE_NONE -> "NONE"
            DomainVerificationUserState.DOMAIN_STATE_SELECTED -> "SELECTED"
            DomainVerificationUserState.DOMAIN_STATE_VERIFIED -> "VERIFIED"
            else -> "UNKNOWN_$state"
        }

    private fun stringArray(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            array.optString(index, "").trim().takeIf { it.isNotBlank() }
        }
    }

    private fun sha256First8(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).take(8).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun fingerprint(bytes: ByteArray): String =
        bytes.joinToString(":") { "%02X".format(it.toInt() and 0xff) }
}

data class AssetLinksInspection(
    val parseOk: Boolean,
    val packageEntryFound: Boolean,
    val relationFound: Boolean,
    val namespaceOk: Boolean,
    val fingerprintMatch: Boolean,
    val expectedFingerprints: List<String>,
    val assetLinksFingerprints: List<String>,
    val matchedFingerprints: List<String>,
    val error: String,
) {
    fun toLogMetadata(): Map<String, Any?> =
        mapOf(
            "assetlinksParseOk" to parseOk,
            "assetlinksPackageEntryFound" to packageEntryFound,
            "assetlinksRelationFound" to relationFound,
            "assetlinksNamespaceOk" to namespaceOk,
            "assetlinksFingerprintMatch" to fingerprintMatch,
            "assetlinksExpectedSha256" to expectedFingerprints.joinToString(";"),
            "assetlinksSha256" to assetLinksFingerprints.joinToString(";"),
            "assetlinksMatchedSha256" to matchedFingerprints.joinToString(";"),
            "assetlinksError" to error,
        )
}

data class AppLinksVerificationState(
    val supported: Boolean,
    val host: String,
    val linkHandlingAllowed: Boolean?,
    val hostState: Int?,
    val verifiedHosts: List<String>,
    val selectedHosts: List<String>,
    val noneHosts: List<String>,
    val error: String,
) {
    val shouldWarn: Boolean
        get() = supported &&
            (linkHandlingAllowed == false ||
                MwaIdentityPreflight.appLinksStateName(hostState) !in setOf("VERIFIED", "SELECTED"))

    fun toLogMetadata(): Map<String, Any?> =
        mapOf(
            "appLinksSupported" to supported,
            "appLinksHost" to host,
            "appLinksHandlingAllowed" to linkHandlingAllowed,
            "appLinksHostState" to MwaIdentityPreflight.appLinksStateName(hostState),
            "appLinksHostStateRaw" to hostState,
            "appLinksVerifiedHosts" to verifiedHosts.joinToString(";"),
            "appLinksSelectedHosts" to selectedHosts.joinToString(";"),
            "appLinksNoneHosts" to noneHosts.joinToString(";"),
            "appLinksError" to error,
        )

    companion object {
        fun unsupported(host: String, error: String): AppLinksVerificationState =
            AppLinksVerificationState(
                supported = false,
                host = host,
                linkHandlingAllowed = null,
                hostState = null,
                verifiedHosts = emptyList(),
                selectedHosts = emptyList(),
                noneHosts = emptyList(),
                error = error,
            )
    }
}
