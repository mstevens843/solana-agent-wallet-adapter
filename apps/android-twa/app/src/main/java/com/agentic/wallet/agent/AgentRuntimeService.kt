package com.agentic.wallet.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import com.agentic.wallet.BuildConfig
import com.agentic.wallet.R
import com.agentic.wallet.agent.runtime.RuntimeRegistry
import com.agentic.wallet.agent.runtime.RuntimeState
import com.agentic.wallet.mwa.AgentMwaLog
import com.agentic.wallet.streaming.StreamingSessionController
import com.agentic.wallet.streaming.StreamingSessionException
import com.agentic.wallet.streaming.StreamingSessionNotificationState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import org.json.JSONObject

class AgentRuntimeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            ensureNotificationChannels()
            startForeground(NOTIFICATION_ID, notification())
            AgentMwaLog.info(
                "AgentRuntimeService",
                "start",
                "START",
                "device agent foreground service running",
                mapOf("action" to intent?.action.orEmpty(), "streamingSessions" to StreamingVoucherWorker.notificationState(this).activeCount),
            )
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "AgentRuntimeService",
                "start",
                "FAIL",
                "device agent foreground service failed",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
            stopSelf()
            return START_NOT_STICKY
        }
        return if (StreamingVoucherWorker.notificationState(this).activeCount > 0) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        AgentMwaLog.info(
            "AgentRuntimeService",
            "onDestroy",
            "DONE",
            "device agent foreground service stopped",
        )
        super.onDestroy()
    }

    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val deviceChannel = NotificationChannel(CHANNEL_ID, "Agentic Device Agent", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Keeps the gated Agentic Device Agent runtime active."
        }
        val streamingChannel = NotificationChannel(STREAMING_CHANNEL_ID, "Agentic Streaming Sessions", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Streaming session active while on-device vouchers are signed."
        }
        manager.createNotificationChannel(deviceChannel)
        manager.createNotificationChannel(streamingChannel)
    }

    private fun notification(): Notification {
        val streaming = StreamingVoucherWorker.notificationState(this)
        val isStreaming = streaming.activeCount > 0
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, if (isStreaming) STREAMING_CHANNEL_ID else CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(if (isStreaming) "Agentic Streaming" else "Agentic Device Agent")
            .setContentText(if (isStreaming) streaming.text else "Device Agent runtime is active.")
            .setSmallIcon(R.drawable.ic_agentic_notification)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        const val ACTION_STREAMING_REFRESH = "com.agentic.wallet.agent.STREAMING_REFRESH"
        const val NOTIFICATION_ID = 4802
        private const val CHANNEL_ID = "agentic_device_agent"
        private const val STREAMING_CHANNEL_ID = "agentic_streaming_sessions"
    }
}

object StreamingVoucherWorker {
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob() + CoroutineName("StreamingVoucherWorker"))
    private val channel = Channel<StreamingWorkerRequest>(capacity = REQUEST_CAPACITY)
    private val startLock = Any()

    @Volatile private var started = false
    @Volatile private var controller: StreamingSessionController? = null
    @Volatile private var lastServiceRefreshAtMs = 0L

    suspend fun submit(context: Context, method: String, payload: JSONObject): JSONObject {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            throw StreamingSessionException("streaming_unavailable", "Android Device Agent is disabled for this build.")
        }
        val appContext = context.applicationContext
        ensureStarted(appContext)
        val deferred = CompletableDeferred<JSONObject>()
        val request = StreamingWorkerRequest(method, payload, deferred)
        val sent = channel.trySend(request)
        if (!sent.isSuccess) {
            throw StreamingSessionException("streaming_busy", "Streaming voucher worker is busy; retry shortly.")
        }
        return deferred.await()
    }

    fun statusJson(context: Context): JSONObject =
        controllerFor(context.applicationContext).statusJson()

    fun notificationState(context: Context): StreamingSessionNotificationState =
        controllerFor(context.applicationContext).notificationState()

    private fun ensureStarted(context: Context) {
        controllerFor(context)
        if (started) return
        synchronized(startLock) {
            if (started) return
            scope.launch {
                for (request in channel) {
                    try {
                        request.deferred.complete(handle(context, request.method, request.payload))
                    } catch (err: Throwable) {
                        request.deferred.completeExceptionally(err)
                    } finally {
                        refreshForegroundService(context)
                    }
                }
            }
            started = true
            AgentMwaLog.info(
                "StreamingVoucherWorker",
                "start",
                "DONE",
                "streaming voucher worker started",
                mapOf("capacity" to REQUEST_CAPACITY),
            )
        }
    }

    private fun handle(context: Context, method: String, payload: JSONObject): JSONObject {
        val controller = controllerFor(context)
        return when (method) {
            "createSession" -> {
                val sessionId = requireString(payload, "sessionId")
                val privateKey = payload.optString("ephemeralPrivkeyBase64")
                    .ifBlank { payload.optString("ephemeralPrivateKeyBase64") }
                    .ifBlank { payload.optString("privateKeyBase64") }
                if (privateKey.isBlank()) {
                    throw StreamingSessionException("invalid_payload", "createSession requires ephemeralPrivkeyBase64.")
                }
                val metadata = JSONObject(payload.toString()).apply {
                    remove("ephemeralPrivkeyBase64")
                    remove("ephemeralPrivateKeyBase64")
                    remove("privateKeyBase64")
                }
                controller.createSession(sessionId, privateKey, metadata)
            }
            "signVoucher" -> {
                val sessionId = requireString(payload, "sessionId")
                val voucherJson = payload.optString("voucherJson")
                    .ifBlank {
                        payload.optJSONObject("voucher")?.toString().orEmpty()
                    }
                if (voucherJson.isBlank()) {
                    throw StreamingSessionException("invalid_payload", "signVoucher requires voucherJson or voucher.")
                }
                controller.signVoucher(sessionId, voucherJson)
            }
            "revokeLocalSession" -> controller.revokeLocalSession(requireString(payload, "sessionId"))
            else -> throw StreamingSessionException("unsupported_method", "Unsupported streaming bridge method: $method")
        }
    }

    private fun refreshForegroundService(context: Context) {
        val activeCount = notificationState(context).activeCount
        val runtimeRunning = RuntimeRegistry.currentSnapshot().state == RuntimeState.RUNNING
        val now = System.currentTimeMillis()
        if (activeCount > 0 && now - lastServiceRefreshAtMs < SERVICE_REFRESH_MIN_INTERVAL_MS) {
            return
        }
        lastServiceRefreshAtMs = now
        try {
            if (activeCount > 0 || runtimeRunning) {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, AgentRuntimeService::class.java).setAction(AgentRuntimeService.ACTION_STREAMING_REFRESH),
                )
            } else {
                context.stopService(Intent(context, AgentRuntimeService::class.java))
            }
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "StreamingVoucherWorker",
                "refreshForegroundService",
                "FAIL",
                "failed to refresh streaming foreground service",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message, "activeSessions" to activeCount),
            )
        }
    }

    private fun controllerFor(context: Context): StreamingSessionController {
        val existing = controller
        if (existing != null) return existing
        synchronized(startLock) {
            val again = controller
            if (again != null) return again
            val created = StreamingSessionController(context.applicationContext)
            controller = created
            return created
        }
    }

    private fun requireString(payload: JSONObject, field: String): String {
        val value = payload.optString(field, "")
        if (value.isBlank()) {
            throw StreamingSessionException("invalid_payload", "$field must be a non-empty string.")
        }
        return value
    }

    private data class StreamingWorkerRequest(
        val method: String,
        val payload: JSONObject,
        val deferred: CompletableDeferred<JSONObject>,
    )

    private const val REQUEST_CAPACITY = 512
    private const val SERVICE_REFRESH_MIN_INTERVAL_MS = 1_000L
}
