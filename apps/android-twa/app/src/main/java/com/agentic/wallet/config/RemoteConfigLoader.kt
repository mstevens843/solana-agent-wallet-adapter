package com.agentic.wallet.config

import com.agentic.wallet.NativeSecureStore
import com.agentic.wallet.mwa.AgentMwaLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * Singleton remote-config loader. WalletRegistry and MemoProofRouter need synchronous
 * reads from the JS bridge dispatch path, so [current] always returns the in-memory
 * snapshot — either fresh from server, cached on disk, or hardcoded defaults.
 *
 * Lifecycle (driven from MainActivity):
 *   1. [initialize] is called in onCreate. Synchronous: loads disk cache → sets
 *      [current]. If no cache exists, [current] stays at [RemoteConfigDefaults.DEFAULT_CONFIG].
 *   2. [refresh] is called from onCreate (and onResume after a debounce) to fetch a
 *      fresh config from `${baseUrl}/api/android-config`. On success, writes the JSON
 *      back to disk and updates [current]. On failure, keeps the previous snapshot.
 *   3. Bridge consumers call [current] synchronously and never block.
 */
object RemoteConfigLoader {
    private const val CONFIG_PATH = "/api/android-config"
    private const val REFRESH_DEBOUNCE_MS = 60_000L
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000

    private val snapshot = AtomicReference(LoaderSnapshot.bundled())
    private val lastRefreshAttemptMs = AtomicReference(0L)

    @Volatile
    private var baseUrl: String = ""

    @Volatile
    private var secureStore: NativeSecureStore? = null

    /**
     * Synchronous initialization: hydrate [current] from the disk cache if present. Safe
     * to call multiple times — only the first call actually reads the store. Returns
     * the snapshot that was set.
     */
    @Synchronized
    fun initialize(baseUrl: String, secureStore: NativeSecureStore): LoaderSnapshot {
        this.baseUrl = baseUrl.trimEnd('/')
        this.secureStore = secureStore
        val cachedJson = secureStore.get(NativeSecureStore.REMOTE_CONFIG_KEY)
        if (cachedJson != null) {
            val parsed = RemoteConfigSchema.parse(cachedJson)
            if (parsed != null) {
                val next = LoaderSnapshot(config = parsed, source = ConfigSource.CACHE, fetchedAtMs = 0L)
                snapshot.set(next)
                AgentMwaLog.info(
                    "RemoteConfigLoader",
                    "initialize",
                    "DONE",
                    "remote config hydrated from cache",
                    mapOf("source" to "cache", "version" to parsed.version),
                )
                return next
            }
            AgentMwaLog.warn(
                "RemoteConfigLoader",
                "initialize",
                "FAIL_PARSE",
                "cached remote config did not parse; falling back to bundled defaults",
            )
        } else {
            AgentMwaLog.info(
                "RemoteConfigLoader",
                "initialize",
                "DONE",
                "no cached remote config; using bundled defaults",
                mapOf("source" to "bundled", "version" to RemoteConfigDefaults.VERSION),
            )
        }
        val bundled = LoaderSnapshot.bundled()
        snapshot.set(bundled)
        return bundled
    }

    /** Snapshot of the currently active config + provenance. Safe to call from any thread. */
    fun current(): LoaderSnapshot = snapshot.get()

    /** Convenience: just the config payload. */
    fun config(): RemoteConfig = snapshot.get().config

    /**
     * Kick off an async refresh from the server. Coalesces repeated calls inside
     * [REFRESH_DEBOUNCE_MS] (so onResume → onResume → onResume doesn't spam the network).
     * Pass force=true to bypass the debounce (e.g. for the bridge `remoteConfigRefresh()`
     * caller).
     */
    fun refresh(scope: CoroutineScope, force: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force) {
            val last = lastRefreshAttemptMs.get()
            if (last != 0L && (now - last) < REFRESH_DEBOUNCE_MS) {
                AgentMwaLog.debug(
                    "RemoteConfigLoader",
                    "refresh",
                    "SKIP_DEBOUNCED",
                    "refresh skipped under debounce",
                    mapOf("sinceLastMs" to (now - last)),
                )
                return
            }
        }
        lastRefreshAttemptMs.set(now)
        scope.launch { fetchAndStore() }
    }

    /**
     * Suspend variant used by the bridge: callers `await` the result to surface fetch
     * status back to JS. Always settles — on failure returns the previously cached
     * snapshot rather than throwing.
     */
    suspend fun refreshNow(): RefreshResult = withContext(Dispatchers.IO) {
        lastRefreshAttemptMs.set(System.currentTimeMillis())
        fetchAndStore()
    }

    private suspend fun fetchAndStore(): RefreshResult = withContext(Dispatchers.IO) {
        val base = baseUrl
        val store = secureStore
        if (base.isBlank() || store == null) {
            AgentMwaLog.warn(
                "RemoteConfigLoader",
                "fetch",
                "FAIL_NOT_INITIALIZED",
                "remote config loader not initialized; cannot fetch",
            )
            return@withContext RefreshResult(ok = false, snapshot = snapshot.get(), errorMessage = "loader_not_initialized")
        }
        val url = URL("$base$CONFIG_PATH")
        AgentMwaLog.info(
            "RemoteConfigLoader",
            "fetch",
            "START",
            "fetching remote config",
            mapOf("url" to url.toString()),
        )
        val conn = (url.openConnection() as HttpURLConnection)
        try {
            conn.apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/json")
                setRequestProperty("x-agentic-client", "android-bundled")
            }
            val status = conn.responseCode
            if (status !in 200..299) {
                AgentMwaLog.warn(
                    "RemoteConfigLoader",
                    "fetch",
                    "FAIL_HTTP_STATUS",
                    "remote config fetch failed",
                    mapOf("status" to status),
                )
                return@withContext RefreshResult(
                    ok = false,
                    snapshot = snapshot.get(),
                    errorMessage = "http_$status",
                )
            }
            val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val parsed = RemoteConfigSchema.parse(text)
            if (parsed == null) {
                AgentMwaLog.warn(
                    "RemoteConfigLoader",
                    "fetch",
                    "FAIL_PARSE",
                    "remote config response did not parse",
                )
                return@withContext RefreshResult(
                    ok = false,
                    snapshot = snapshot.get(),
                    errorMessage = "parse_failed",
                )
            }
            store.set(NativeSecureStore.REMOTE_CONFIG_KEY, text)
            val next = LoaderSnapshot(
                config = parsed,
                source = ConfigSource.SERVER,
                fetchedAtMs = System.currentTimeMillis(),
            )
            snapshot.set(next)
            AgentMwaLog.info(
                "RemoteConfigLoader",
                "fetch",
                "SUCCESS",
                "remote config refreshed",
                mapOf("version" to parsed.version, "walletCount" to parsed.walletRegistry.size),
            )
            RefreshResult(ok = true, snapshot = next, errorMessage = null)
        } catch (err: Exception) {
            AgentMwaLog.failure(
                "RemoteConfigLoader",
                "fetch",
                "FAIL_EXCEPTION",
                "remote config fetch threw",
                err,
            )
            RefreshResult(
                ok = false,
                snapshot = snapshot.get(),
                errorMessage = err.javaClass.simpleName,
            )
        } finally {
            conn.disconnect()
        }
    }

    fun statusJson(): JSONObject {
        val snap = snapshot.get()
        return JSONObject()
            .put("version", snap.config.version)
            .put("source", snap.source.id)
            .put("fetchedAtMs", snap.fetchedAtMs)
            .put("walletCount", snap.config.walletRegistry.size)
            .put("envelopeVersion", snap.config.memoProofRouter.envelopeVersion)
    }
}

enum class ConfigSource(val id: String) {
    SERVER("server"),
    CACHE("cache"),
    BUNDLED("bundled"),
}

data class LoaderSnapshot(
    val config: RemoteConfig,
    val source: ConfigSource,
    val fetchedAtMs: Long,
) {
    companion object {
        fun bundled(): LoaderSnapshot =
            LoaderSnapshot(
                config = RemoteConfigDefaults.DEFAULT_CONFIG,
                source = ConfigSource.BUNDLED,
                fetchedAtMs = 0L,
            )
    }
}

data class RefreshResult(
    val ok: Boolean,
    val snapshot: LoaderSnapshot,
    val errorMessage: String?,
)
