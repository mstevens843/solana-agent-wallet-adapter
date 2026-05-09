package com.agentic.wallet.mwa

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import com.agentic.wallet.R

class MwaKeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(CHANNEL_ID, "Agentic wallet approval", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps Agentic active while your wallet approval sheet is open."
                }
                getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
            }
            startForeground(NOTIFICATION_ID, notification())
            AgentMwaLog.info("KeepAlive", "start", "START", "foreground service running", mapOf("sdk" to Build.VERSION.SDK_INT))
        } catch (err: Exception) {
            AgentMwaLog.warn("KeepAlive", "start", "FAIL", "foreground service failed", mapOf("class" to err.javaClass.simpleName, "message" to err.message))
        }
        return START_NOT_STICKY
    }

    private fun notification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Agentic wallet approval")
            .setContentText("Approve or reject the pending wallet request.")
            .setSmallIcon(R.drawable.ic_agentic_notification)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "agentic_mwa_approval"
        private const val NOTIFICATION_ID = 4801
    }
}
