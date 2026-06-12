package com.agentic.wallet.system

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.agentic.wallet.R
import com.agentic.wallet.mwa.AgentMwaLog
import org.json.JSONObject
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicInteger

/**
 * Generic Android primitives exposed to the JS bridge. Everything here is intent-free
 * and stateless — wire from MainActivity's @JavascriptInterface methods.
 *
 * Rationale (see plan file): keep the native method *surface* maximal so that future
 * features built into the web bundle can call into the device without requiring a new
 * APK release through the Solana dApp Store.
 */
class SystemBridge(private val activity: Activity) {

    /**
     * Open a URL via [Intent.ACTION_VIEW]. Returns true on success, false on rejected
     * scheme or dispatch failure.
     *
     * SECURITY: scheme allowlist applied defensively even though the bridge is
     * origin-guarded (`checkTrustedOrigin`). If the trusted-origin JS is ever
     * compromised (XSS, supply chain), an attacker could otherwise dispatch
     * `intent://`, custom schemes, `data:`, or `javascript:` to reach phishing
     * handlers on the device, exfiltrate via `mailto:?body=<secrets>`, or invoke
     * sensitive system actions. Only schemes the user-facing flow actually needs
     * are accepted: https/http for browsers, mailto for support email, tel for
     * "call support" links, sms for SMS-based 2FA. If a future feature legitimately
     * needs another scheme, add it here AND ship a new APK.
     */
    fun openExternal(url: String): Boolean {
        if (url.isBlank()) return false
        val parsed = runCatching { Uri.parse(url) }.getOrNull()
        if (parsed == null) {
            AgentMwaLog.warn(
                "SystemBridge",
                "openExternal",
                "FAIL_UNPARSEABLE",
                "URL did not parse",
                mapOf("url" to url),
            )
            return false
        }
        val scheme = parsed.scheme?.lowercase().orEmpty()
        if (scheme !in ALLOWED_EXTERNAL_SCHEMES) {
            AgentMwaLog.warn(
                "SystemBridge",
                "openExternal",
                "FAIL_SCHEME_REJECTED",
                "URL scheme not in allowlist",
                mapOf("scheme" to scheme, "url" to url),
            )
            return false
        }
        return try {
            val intent = Intent(Intent.ACTION_VIEW, parsed).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            true
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "SystemBridge",
                "openExternal",
                "FAIL",
                "external intent dispatch failed",
                mapOf("url" to url, "class" to err.javaClass.simpleName, "message" to err.message),
            )
            false
        }
    }

    /**
     * Snapshot of device info useful for diagnostics, telemetry, and JS-side tier
     * detection (e.g., "this device is low-battery, defer the long-running plan").
     * No user-identifying data — model/manufacturer/SDK/locale only.
     */
    fun systemInfo(): JSONObject {
        val batteryPct = batteryPercent()
        val net = networkType()
        return JSONObject()
            .put("manufacturer", Build.MANUFACTURER ?: "")
            .put("model", Build.MODEL ?: "")
            .put("device", Build.DEVICE ?: "")
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("release", Build.VERSION.RELEASE ?: "")
            .put("locale", Locale.getDefault().toLanguageTag())
            .put("timezone", TimeZone.getDefault().id)
            .put("batteryPercent", batteryPct)
            .put("networkType", net)
            .put("packageName", activity.packageName)
    }

    private fun batteryPercent(): Int {
        return try {
            val bm = activity.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
                ?: return -1
            bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        } catch (_: Throwable) {
            -1
        }
    }

    private fun networkType(): String {
        return try {
            val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return "unknown"
            val network = cm.activeNetwork ?: return "offline"
            val caps = cm.getNetworkCapabilities(network) ?: return "offline"
            when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
        } catch (_: Throwable) {
            "unknown"
        }
    }

    /**
     * Write text to the system clipboard. The label is shown in some OEM clipboard
     * UIs as the source of the clipped item; default "Agentic". Returns true on
     * success.
     */
    fun clipboardWrite(text: String, label: String = "Agentic"): Boolean {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: return false
            cm.setPrimaryClip(ClipData.newPlainText(label, text))
            true
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "SystemBridge",
                "clipboardWrite",
                "FAIL",
                "clipboard write failed",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
            false
        }
    }

    /**
     * Read the current clipboard text. Android WebView denies the async
     * navigator.clipboard.readText() API (no permission UI), so the WebView UI
     * routes the "Paste key" affordance through this native method instead.
     * Returns the coerced primary-clip text, or "" when the clipboard is empty
     * or unreadable.
     */
    fun clipboardRead(): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: return ""
            val clip = cm.primaryClip ?: return ""
            if (clip.itemCount == 0) return ""
            clip.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "SystemBridge",
                "clipboardRead",
                "FAIL",
                "clipboard read failed",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
            ""
        }
    }

    /**
     * Fire a haptic pulse. [pattern] accepts "light", "medium", "heavy" — anything
     * else falls back to "light". On Android 12+ uses VibratorManager; on older
     * APIs uses the legacy Vibrator service. Requires the VIBRATE permission
     * (declared in the manifest).
     */
    fun haptic(pattern: String): Boolean {
        val durationMs = when (pattern.lowercase()) {
            "medium" -> 25L
            "heavy" -> 60L
            else -> 10L
        }
        return try {
            val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val manager = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)
                    as? VibratorManager
                manager?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
            if (vibrator == null || !vibrator.hasVibrator()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(durationMs)
            }
            true
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "SystemBridge",
                "haptic",
                "FAIL",
                "haptic feedback failed",
                mapOf("pattern" to pattern, "class" to err.javaClass.simpleName, "message" to err.message),
            )
            false
        }
    }

    /**
     * Post a system notification. Payload is JSON: { title, body, tag?, channelId? }.
     * Returns JSON: { ok, id?, error? }. Requires POST_NOTIFICATIONS permission on
     * Android 13+ (declared in the manifest; the user grant is asked separately
     * by the system the first time a notification is posted).
     */
    fun showNotification(payloadJson: String): JSONObject {
        return try {
            val parsed = JSONObject(payloadJson)
            val title = parsed.optString("title", "").trim()
            val body = parsed.optString("body", "").trim()
            val tag = parsed.optString("tag", "").trim().ifBlank { null }
            val channelId = parsed.optString("channelId", DEFAULT_CHANNEL_ID).ifBlank { DEFAULT_CHANNEL_ID }
            if (title.isBlank() && body.isBlank()) {
                return JSONObject().put("ok", false).put("error", "title_or_body_required")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val granted = activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    return JSONObject().put("ok", false).put("error", "permission_not_granted")
                }
            }
            ensureNotificationChannel(channelId)
            val id = nextNotificationId()
            val notification = NotificationCompat.Builder(activity, channelId)
                // White-silhouette vector icon. Android 5+ converts small icons to
                // single-channel using only the alpha channel — full-color
                // launcher icons (`applicationInfo.icon`) would render as gray
                // squares. Keep this pointing at `ic_agentic_notification`.
                .setSmallIcon(R.drawable.ic_agentic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build()
            NotificationManagerCompat.from(activity).notify(tag, id, notification)
            JSONObject().put("ok", true).put("id", id).put("tag", tag ?: JSONObject.NULL)
        } catch (err: Exception) {
            AgentMwaLog.warn(
                "SystemBridge",
                "showNotification",
                "FAIL",
                "notification post failed",
                mapOf("class" to err.javaClass.simpleName, "message" to err.message),
            )
            JSONObject().put("ok", false).put("error", err.javaClass.simpleName)
        }
    }

    private fun ensureNotificationChannel(channelId: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = activity.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (manager.getNotificationChannel(channelId) != null) return
        val channel = NotificationChannel(
            channelId,
            "Agentic notifications",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Agent activity, recurring payments, streaming session updates."
        }
        manager.createNotificationChannel(channel)
    }

    private fun nextNotificationId(): Int = NOTIFICATION_ID_COUNTER.incrementAndGet()

    companion object {
        const val DEFAULT_CHANNEL_ID = "agentic.default"
        private val NOTIFICATION_ID_COUNTER = AtomicInteger(1000)

        // Scheme allowlist for `openExternal`. Trim is conservative: every
        // additional scheme is a potential phishing vector if JS is compromised.
        // Add a scheme here ONLY when a user-facing feature legitimately needs
        // it, and remember that adding one means a new APK release.
        private val ALLOWED_EXTERNAL_SCHEMES = setOf("https", "http", "mailto", "tel", "sms")
    }
}
