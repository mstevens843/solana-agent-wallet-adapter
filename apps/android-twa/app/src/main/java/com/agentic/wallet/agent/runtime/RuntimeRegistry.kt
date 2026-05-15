package com.agentic.wallet.agent.runtime

import com.agentic.wallet.mwa.AgentMwaLog
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Process-level home for Device Agent runtime state. A singleton so the queue and
 * state machine survive Activity recreation (rotation); a process restart correctly
 * resets in-memory state and downgrades any persisted "running" to "stopped".
 *
 * State transitions are mutex-guarded. The `submit` fast path reads the volatile
 * state without the mutex — worst-case race is a `runtime_not_running` failure
 * that the caller can retry, which is preferable to serializing every submit.
 */
object RuntimeRegistry {
    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.Default + supervisor + CoroutineName("AgentRuntime"))
    private val stateMutex = Mutex()

    @Volatile private var hydrated = false
    @Volatile private var state: RuntimeState = RuntimeState.STOPPED
    @Volatile private var lastError: RuntimeError? = null
    @Volatile private var lastTransitionAtMs: Long = 0L
    @Volatile private var executor: ProviderExecutor = ScaffoldProviderExecutor()
    @Volatile private var activeConfig: RuntimeConfig? = null
    @Volatile private var queue: RequestQueue? = null

    data class Snapshot(
        val state: RuntimeState,
        val lastError: RuntimeError?,
        val config: RuntimeConfig?,
        val lastTransitionAtMs: Long,
    )

    fun hydrateFromPersistence(persistence: RuntimeStatePersistence) {
        if (hydrated) return
        synchronized(this) {
            if (hydrated) return
            val snap = persistence.load()
            val resolved = when (snap.state) {
                RuntimeState.RUNNING, RuntimeState.STARTING -> RuntimeState.STOPPED
                else -> snap.state
            }
            state = resolved
            lastError = if (resolved == RuntimeState.ERROR) snap.error else null
            lastTransitionAtMs = snap.lastTransitionAtMs
            if (resolved != snap.state) {
                persistAndStamp(persistence, resolved, lastError)
                AgentMwaLog.info(
                    "AgentRuntimeRegistry",
                    "hydrate",
                    "DOWNGRADE",
                    "persisted runtime state downgraded after process restart",
                    mapOf("persisted" to snap.state.wire, "resolved" to resolved.wire),
                )
            } else {
                AgentMwaLog.info(
                    "AgentRuntimeRegistry",
                    "hydrate",
                    "DONE",
                    "runtime state hydrated",
                    mapOf("state" to resolved.wire, "hasError" to (lastError != null)),
                )
            }
            hydrated = true
        }
    }

    fun currentSnapshot(): Snapshot =
        Snapshot(state, lastError, activeConfig, lastTransitionAtMs)

    fun setExecutor(provider: ProviderExecutor) {
        executor = provider
        AgentMwaLog.info(
            "AgentRuntimeRegistry",
            "setExecutor",
            "DONE",
            "provider executor updated",
            mapOf("class" to provider.javaClass.simpleName),
        )
    }

    suspend fun transitionStart(
        config: RuntimeConfig?,
        persistence: RuntimeStatePersistence,
    ): RuntimeState = stateMutex.withLock {
        teardownLocked()

        val validationError = if (config == null) {
            RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_PROVIDER,
                message = "Device Agent config is missing.",
            )
        } else {
            config.validate()
        }

        if (validationError != null) {
            state = RuntimeState.ERROR
            lastError = validationError
            activeConfig = null
            persistAndStamp(persistence, state, lastError)
            AgentMwaLog.warn(
                "AgentRuntimeRegistry",
                "transitionStart",
                "INVALID_CONFIG",
                validationError.message,
                mapOf("subcode" to (validationError.subcode ?: "")),
            )
            return@withLock RuntimeState.ERROR
        }

        val resolvedConfig = config!!
        state = RuntimeState.STARTING
        lastError = null
        activeConfig = resolvedConfig
        persistAndStamp(persistence, state, lastError)

        val nextQueue = RequestQueue(
            scope = scope,
            executorProvider = { executor },
            configProvider = { activeConfig },
        )
        nextQueue.start()
        queue = nextQueue
        state = RuntimeState.RUNNING
        persistAndStamp(persistence, state, null)
        AgentMwaLog.info(
            "AgentRuntimeRegistry",
            "transitionStart",
            "RUNNING",
            "device agent runtime running",
            resolvedConfig.redactedSummary(),
        )
        RuntimeState.RUNNING
    }

    suspend fun transitionStop(persistence: RuntimeStatePersistence): RuntimeState = stateMutex.withLock {
        teardownLocked()
        state = RuntimeState.STOPPED
        lastError = null
        activeConfig = null
        persistAndStamp(persistence, state, null)
        AgentMwaLog.info(
            "AgentRuntimeRegistry",
            "transitionStop",
            "STOPPED",
            "device agent runtime stopped",
        )
        RuntimeState.STOPPED
    }

    /**
     * Force the runtime into [RuntimeState.ERROR] with the given error. Used when an external
     * operation (e.g., `startForegroundService`) fails after `transitionStart` already returned
     * RUNNING — the queue is torn down so it doesn't keep accepting requests against a runtime
     * the OS is rejecting.
     */
    suspend fun recordError(
        error: RuntimeError,
        persistence: RuntimeStatePersistence,
    ): RuntimeState = stateMutex.withLock {
        teardownLocked()
        state = RuntimeState.ERROR
        lastError = error
        activeConfig = null
        persistAndStamp(persistence, state, lastError)
        AgentMwaLog.warn(
            "AgentRuntimeRegistry",
            "recordError",
            "ERROR",
            error.message,
            mapOf("code" to error.code, "subcode" to (error.subcode ?: "")),
        )
        RuntimeState.ERROR
    }

    suspend fun submit(request: RuntimeRequest): RuntimeResult {
        val activeQueue = queue
        if (state != RuntimeState.RUNNING || activeQueue == null) {
            return RuntimeResult.Failed(
                requestId = request.requestId,
                method = request.method,
                error = RuntimeError(
                    code = RuntimeErrorCodes.RUNTIME_NOT_RUNNING,
                    message = "Device Agent runtime is not running.",
                ),
                completedAtMs = System.currentTimeMillis(),
            )
        }
        return activeQueue.submit(request)
    }

    private fun persistAndStamp(
        persistence: RuntimeStatePersistence,
        state: RuntimeState,
        error: RuntimeError?,
    ) {
        lastTransitionAtMs = System.currentTimeMillis()
        persistence.save(state, error)
    }

    private fun teardownLocked() {
        queue?.stop()
        queue = null
    }
}
