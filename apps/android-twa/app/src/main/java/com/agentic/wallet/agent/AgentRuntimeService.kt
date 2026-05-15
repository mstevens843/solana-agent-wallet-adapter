package com.agentic.wallet.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.agentic.wallet.BuildConfig
import com.agentic.wallet.R
import com.agentic.wallet.mwa.AgentMwaLog

class AgentRuntimeService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!BuildConfig.AGENTIC_ANDROID_DEVICE_AGENT) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(CHANNEL_ID, "Agentic Device Agent", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps the gated Agentic Device Agent runtime active."
                }
                getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
            }
            startForeground(NOTIFICATION_ID, notification())
            AgentMwaLog.info("AgentRuntimeService", "start", "START", "device agent foreground service running")
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
        return START_NOT_STICKY
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

    private fun notification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Agentic Device Agent")
            .setContentText("Device Agent runtime is active.")
            .setSmallIcon(R.drawable.ic_agentic_notification)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "agentic_device_agent"
        private const val NOTIFICATION_ID = 4802
    }
}
