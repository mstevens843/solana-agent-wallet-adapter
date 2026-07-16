package com.agentic.wallet.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.agentic.wallet.MainActivity
import com.agentic.wallet.R
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.atomic.AtomicInteger

/**
 * Receives server-sent FCM pushes and posts them as OS notifications while the app is closed.
 *
 * The server sends a `notification` block (title/body, so the OS displays it even with the app dead)
 * PLUS a `data` block carrying the routing hint (tab/section) and the collapse key. A tap opens
 * MainActivity with that route as an intent extra; the web layer reads it and navigates.
 */
class AgenticPushMessagingService : FirebaseMessagingService() {

    /**
     * A rotated FCM token must reach the server or push silently dies. We can't call our own
     * authenticated /api/push/register-device from here (no wallet session in a background service),
     * so persist the pending token; MainActivity re-registers it on next foreground when the JS layer
     * has a session. (JS also re-registers proactively on sign-in, so this is the safety net.)
     */
    override fun onNewToken(token: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_PENDING_TOKEN, token).apply()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = message.notification?.title ?: data["title"] ?: "Agentic"
        val body = message.notification?.body ?: data["body"] ?: ""
        if (title.isBlank() && body.isBlank()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        postNotification(title, body, data)
    }

    private fun postNotification(title: String, body: String, data: Map<String, String>) {
        ensureChannel()
        // Route the tap: carry the server's data (tab/section/signature) into MainActivity so the web
        // layer can navigate. FLAG_IMMUTABLE is required on Android 12+.
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_PUSH_ROUTE, org.json.JSONObject(data as Map<*, *>).toString())
        }
        val pending = PendingIntent.getActivity(
            this,
            NOTIFICATION_ID.incrementAndGet(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agentic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
        // Collapse repeats of the same event (server sends type:dedupeKey as the collapse tag).
        val tag = data["dedupeKey"] ?: data["type"]
        NotificationManagerCompat.from(this).notify(tag, NOTIFICATION_ID.incrementAndGet(), builder.build())
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Order fills, transaction confirmations, and payment reminders."
            },
        )
    }

    companion object {
        const val CHANNEL_ID = "agentic.alerts"
        const val EXTRA_PUSH_ROUTE = "agentic.push.route"
        private const val PREFS = "agentic.push"
        private const val KEY_PENDING_TOKEN = "pending_token"
        private val NOTIFICATION_ID = AtomicInteger(2000)

        /** Latest token FCM handed us in the background but couldn't register (no session then). */
        fun consumePendingToken(context: Context): String? {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val token = prefs.getString(KEY_PENDING_TOKEN, null)
            if (token != null) prefs.edit().remove(KEY_PENDING_TOKEN).apply()
            return token
        }

        /** Async fetch of the current FCM token for registerForPush; resolves null on failure. */
        fun fetchToken(callback: (String?) -> Unit) {
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                callback(if (task.isSuccessful) task.result else null)
            }
        }
    }
}
