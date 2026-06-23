package com.agentic.wallet.agent.runtime

import com.agentic.wallet.mwa.AgentMwaLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Single-coroutine, serial request queue for Device Agent provider calls.
 *
 * Invariants:
 * - Every submitted request's `CompletableDeferred` is completed exactly once, with one of:
 *   `Ok` (provider success), `Failed(runtime_busy)` (overflow), `Failed(runtime_canceled)`
 *   (stop while pending or in-flight), or `Failed(provider_unavailable | provider_failed | runtime_internal)`
 *   (provider exception path).
 * - Single-use lifecycle: one `start()`, then one `stop()`. The owning [RuntimeRegistry]
 *   constructs a fresh queue per `transitionStart` rather than reusing one.
 * - Provider exceptions (`ProviderUnavailableException`, `ProviderFailedException`, generic
 *   `Exception`) become `Failed` results without crashing the consumer or stopping the queue.
 *   Only structural cancellation (via `stop()` or scope cancel) ends the consumer loop.
 */
class RequestQueue(
    private val scope: CoroutineScope,
    private val executorProvider: () -> ProviderExecutor,
    private val configProvider: () -> RuntimeConfig?,
) {
    private val channel = Channel<Pair<RuntimeRequest, CompletableDeferred<RuntimeResult>>>(capacity = CAPACITY)
    private var consumerJob: Job? = null

    fun start() {
        if (consumerJob?.isActive == true) return
        consumerJob = scope.launch(Dispatchers.IO) {
            for ((request, deferred) in channel) {
                try {
                    deferred.complete(runRequest(request))
                } catch (cancel: CancellationException) {
                    if (!deferred.isCompleted) {
                        deferred.complete(canceledResult(request))
                    }
                    AgentMwaLog.info(
                        "AgentRuntimeQueue",
                        "run",
                        "CANCEL",
                        "in-flight request canceled by queue stop",
                        mapOf("requestId" to request.requestId, "method" to request.method.wire),
                    )
                    throw cancel
                }
            }
        }
        AgentMwaLog.info(
            "AgentRuntimeQueue",
            "start",
            "DONE",
            "request queue consumer started",
            mapOf("capacity" to CAPACITY),
        )
    }

    suspend fun submit(request: RuntimeRequest): RuntimeResult {
        val deferred = CompletableDeferred<RuntimeResult>()
        val sendResult = channel.trySend(request to deferred)
        if (!sendResult.isSuccess) {
            val (code, message) = if (sendResult.isClosed) {
                RuntimeErrorCodes.RUNTIME_NOT_RUNNING to
                    "Device Agent runtime queue is closed."
            } else {
                RuntimeErrorCodes.RUNTIME_BUSY to
                    "Device Agent runtime queue is full; retry shortly."
            }
            AgentMwaLog.warn(
                "AgentRuntimeQueue",
                "submit",
                "FAIL",
                message,
                mapOf(
                    "requestId" to request.requestId,
                    "method" to request.method.wire,
                    "code" to code,
                ),
            )
            return RuntimeResult.Failed(
                requestId = request.requestId,
                method = request.method,
                error = RuntimeError(code = code, message = message),
                completedAtMs = System.currentTimeMillis(),
            )
        }
        AgentMwaLog.info(
            "AgentRuntimeQueue",
            "submit",
            "ENQUEUE",
            "request enqueued",
            mapOf("requestId" to request.requestId, "method" to request.method.wire),
        )
        return deferred.await()
    }

    fun stop() {
        val job = consumerJob
        consumerJob = null
        job?.cancel()
        channel.close()
        var drained = 0
        while (true) {
            val polled = channel.tryReceive()
            if (!polled.isSuccess) break
            val (request, deferred) = polled.getOrThrow()
            if (!deferred.isCompleted) {
                deferred.complete(canceledResult(request))
            }
            drained++
        }
        AgentMwaLog.info(
            "AgentRuntimeQueue",
            "stop",
            "DONE",
            "request queue stopped",
            mapOf("drained" to drained),
        )
    }

    private suspend fun runRequest(request: RuntimeRequest): RuntimeResult {
        val nowFailed: (RuntimeError) -> RuntimeResult.Failed = { err ->
            RuntimeResult.Failed(
                requestId = request.requestId,
                method = request.method,
                error = err,
                completedAtMs = System.currentTimeMillis(),
            )
        }
        val config = configProvider() ?: return nowFailed(
            RuntimeError(
                code = RuntimeErrorCodes.INVALID_CONFIG,
                subcode = RuntimeConfigSubcodes.MISSING_PROVIDER,
                message = "Device Agent config disappeared while runtime was running.",
            ),
        )
        val executor = executorProvider()
        return try {
            val rawData = when (request.method) {
                RuntimeMethod.GENERATE_PLAN -> executor.generatePlan(config, request.payload)
                RuntimeMethod.REVIEW_PLAN -> executor.reviewPlan(config, request.payload)
                RuntimeMethod.ASK -> executor.ask(config, request.payload)
                RuntimeMethod.LOCALIZE -> executor.localize(config, request.payload)
                RuntimeMethod.CHAT -> executor.chat(config, request.payload)
            }
            // Mirror cloud-side aiPlanner.applyServerSideReviewSafety: enforce
            // policyBundle.hasBlockingFailure on BYOK paths where the LLM call
            // bypasses the cloud's safety net. Same logic lives in
            // packages/ios-capacitor-bridge/.../AgenticPolicyBundleEnforcer.swift
            // and apps/browser-demo/src/policyEnrichClient.ts (enforceBlockingFailure).
            val data = if (request.method == RuntimeMethod.REVIEW_PLAN) {
                PolicyBundleEnforcer.enforce(rawData, request.payload)
            } else rawData
            AgentMwaLog.info(
                "AgentRuntimeQueue",
                "run",
                "DONE",
                "request completed",
                mapOf("requestId" to request.requestId, "method" to request.method.wire),
            )
            RuntimeResult.Ok(
                requestId = request.requestId,
                method = request.method,
                data = data,
                completedAtMs = System.currentTimeMillis(),
            )
        } catch (err: ProviderUnavailableException) {
            AgentMwaLog.warn(
                "AgentRuntimeQueue",
                "run",
                "PROVIDER_UNAVAILABLE",
                err.error.message,
                mapOf("requestId" to request.requestId, "method" to request.method.wire),
            )
            nowFailed(err.error)
        } catch (err: ProviderFailedException) {
            AgentMwaLog.warn(
                "AgentRuntimeQueue",
                "run",
                "PROVIDER_FAILED",
                err.error.message,
                mapOf(
                    "requestId" to request.requestId,
                    "method" to request.method.wire,
                    "subcode" to (err.error.subcode ?: ""),
                ),
            )
            nowFailed(err.error)
        } catch (err: Exception) {
            AgentMwaLog.failure(
                "AgentRuntimeQueue",
                "run",
                "FAIL",
                "request execution failed",
                err,
                mapOf("requestId" to request.requestId, "method" to request.method.wire),
            )
            nowFailed(
                RuntimeError(
                    code = RuntimeErrorCodes.RUNTIME_INTERNAL,
                    message = err.message ?: err.javaClass.simpleName,
                ),
            )
        }
    }

    private fun canceledResult(request: RuntimeRequest): RuntimeResult.Failed =
        RuntimeResult.Failed(
            requestId = request.requestId,
            method = request.method,
            error = RuntimeError(
                code = RuntimeErrorCodes.RUNTIME_CANCELED,
                message = "Device Agent runtime stopped before this request executed.",
            ),
            completedAtMs = System.currentTimeMillis(),
        )

    companion object {
        private const val CAPACITY = 64
    }
}
