package com.agentic.wallet.mwa

import android.content.Context
import org.json.JSONObject
import java.io.File

class AuthCache(context: Context) {
    private val cacheFile = File(File(context.filesDir, "AgentAndroidMWA"), "AuthCache.json")
    private val records = LinkedHashMap<String, AgentMwaAuthRecord>()
    private val blacklist = mutableSetOf<String>()
    private var latestPubkey: String = ""
    private var loaded = false

    @Synchronized
    fun get(pubkeyBase58: String): AgentMwaAuthRecord? {
        ensureLoaded()
        return records[pubkeyBase58]
    }

    @Synchronized
    fun latest(): AgentMwaAuthRecord? {
        ensureLoaded()
        latestPubkey.takeIf { it.isNotBlank() && !blacklist.contains(it) }?.let { latest ->
            records[latest]?.let { return it }
        }
        return records.values
            .filterNot { blacklist.contains(it.publicKeyBase58) }
            .maxByOrNull { it.timestampUnixSeconds }
    }

    @Synchronized
    fun all(): List<AgentMwaAuthRecord> {
        ensureLoaded()
        return records.values.toList()
    }

    @Synchronized
    fun set(record: AgentMwaAuthRecord) {
        ensureLoaded()
        if (record.publicKeyBase58.isBlank()) return
        records[record.publicKeyBase58] = record
        latestPubkey = record.publicKeyBase58
        save()
    }

    @Synchronized
    fun clear(pubkeyBase58: String, blacklistForSession: Boolean = true) {
        ensureLoaded()
        if (pubkeyBase58.isBlank()) return
        records.remove(pubkeyBase58)
        if (latestPubkey == pubkeyBase58) {
            latestPubkey = records.values.maxByOrNull { it.timestampUnixSeconds }?.publicKeyBase58 ?: ""
        }
        if (blacklistForSession) {
            blacklist.add(pubkeyBase58)
        }
        save()
    }

    @Synchronized
    fun clearAll() {
        ensureLoaded()
        records.clear()
        latestPubkey = ""
        save()
    }

    @Synchronized
    fun clearBlacklist() {
        blacklist.clear()
    }

    @Synchronized
    fun latestPubkey(): String {
        ensureLoaded()
        return latestPubkey
    }

    private fun ensureLoaded() {
        if (loaded) return
        loaded = true
        if (!cacheFile.exists()) {
            AgentMwaLog.info("AuthCache", "load", "SKIP", "cache file missing", mapOf("path" to cacheFile.absolutePath))
            return
        }
        try {
            val root = JSONObject(cacheFile.readText(Charsets.UTF_8))
            latestPubkey = root.optString("latest", "")
            val objectRecords = root.optJSONObject("records") ?: JSONObject()
            for (key in objectRecords.keys()) {
                val record = recordFromJson(objectRecords.getJSONObject(key))
                if (record.publicKeyBase58.isNotBlank()) {
                    records[record.publicKeyBase58] = record
                }
            }
            AgentMwaLog.info("AuthCache", "load", "DONE", "cache loaded", mapOf("count" to records.size, "latest" to latestPubkey))
        } catch (err: Exception) {
            AgentMwaLog.warn("AuthCache", "load", "FAIL", "cache parse failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
            records.clear()
            latestPubkey = ""
        }
    }

    private fun save() {
        try {
            cacheFile.parentFile?.mkdirs()
            val root = JSONObject()
                .put("schema", 1)
                .put("latest", latestPubkey)
            val objectRecords = JSONObject()
            for ((pubkey, record) in records) {
                objectRecords.put(pubkey, recordToJson(record))
            }
            root.put("records", objectRecords)
            cacheFile.writeText("${root.toString(2)}\n", Charsets.UTF_8)
            AgentMwaLog.info("AuthCache", "save", "DONE", "cache saved", mapOf("count" to records.size, "latest" to latestPubkey))
        } catch (err: Exception) {
            AgentMwaLog.warn("AuthCache", "save", "FAIL", "cache save failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
    }

    private fun recordToJson(record: AgentMwaAuthRecord): JSONObject =
        JSONObject()
            .put("publicKeyBase58", record.publicKeyBase58)
            .put("publicKeyBytesBase58", Base58.encode(record.publicKeyBytes))
            .put("authToken", record.authToken)
            .put("walletUriBase", record.walletUriBase)
            .put("walletPackage", record.walletPackage)
            .put("walletType", record.walletType)
            .put("accountLabel", record.accountLabel)
            .put("cluster", record.cluster.id)
            .put("timestampUnixSeconds", record.timestampUnixSeconds)
            .put("authenticated", record.authenticated)
            .put("capabilitiesCsv", record.capabilitiesCsv)

    private fun recordFromJson(json: JSONObject): AgentMwaAuthRecord {
        val pubkey = json.optString("publicKeyBase58", "")
        val pubkeyBytes = json.optString("publicKeyBytesBase58", "")
            .takeIf { it.isNotBlank() }
            ?.let { Base58.decode(it) }
            ?: Base58.decode(pubkey)
        val walletPackage = json.optString("walletPackage", "")
        val walletUriBase = json.optString("walletUriBase", "")
        return AgentMwaAuthRecord(
            publicKeyBase58 = pubkey,
            publicKeyBytes = pubkeyBytes,
            authToken = json.optString("authToken", ""),
            walletUriBase = walletUriBase,
            walletPackage = walletPackage,
            walletType = json.optInt("walletType", WalletRegistry.walletType(walletPackage, walletUriBase)),
            accountLabel = json.optString("accountLabel", ""),
            cluster = AgentCluster.fromId(json.optString("cluster", "devnet")),
            timestampUnixSeconds = json.optLong("timestampUnixSeconds", 0L),
            authenticated = json.optBoolean("authenticated", false),
            capabilitiesCsv = json.optString("capabilitiesCsv", ""),
        )
    }
}
