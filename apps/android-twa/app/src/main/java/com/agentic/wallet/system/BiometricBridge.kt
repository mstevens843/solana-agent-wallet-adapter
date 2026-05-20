package com.agentic.wallet.system

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.agentic.wallet.mwa.AgentMwaLog
import org.json.JSONObject

/**
 * Thin wrapper around androidx.biometric. Exposed to JS as an async bridge call.
 *
 * Result envelope (returned via the JS callback):
 *   { ok: true, kind: "AUTH_SUCCEEDED" }
 *   { ok: false, kind: "USER_CANCELED" | "HARDWARE_UNAVAILABLE" | "NO_ENROLLED" | "ERROR", code, message }
 *
 * Payload schema:
 *   { title, subtitle?, description?, negativeButton?, allowDeviceCredential? }
 *
 * ## SECURITY: This is a UX gate, NOT a security boundary.
 *
 * The result envelope is delivered to JS via `window.__agenticAndroidBiometricBridge.resolve()`.
 * That global is JS-accessible — any code in the same realm (including an XSS payload,
 * a compromised dependency, or a malicious web bundle) can call `resolve()` synchronously
 * with a forged `{ok: true, kind: "AUTH_SUCCEEDED"}` envelope. There is no cryptographic
 * binding between the native hardware auth event and the result the caller observes.
 *
 * Acceptable uses:
 *   - Adding a confirmation step before high-friction actions (transaction review UI,
 *     toggling a sensitive preference).
 *   - Building a "soft" sign-in / unlock pattern for the SPA where the threat model
 *     assumes the JS side is trusted.
 *
 * Unacceptable uses without further work:
 *   - Gating release of secret material (wallet keys, API tokens, encrypted store reads).
 *   - Authorizing transaction signing where the threat model includes a compromised JS
 *     environment.
 *
 * To make biometric a true security boundary, redesign as challenge-response:
 *   1. Native side generates a random nonce and stores it server-side or in
 *      hardware-attested storage.
 *   2. After successful BiometricPrompt auth, native signs `(action_id, nonce, result)`
 *      with a key whose private half is inaccessible to JS (e.g., StrongBox / hardware
 *      keystore + setUserAuthenticationRequired(true)).
 *   3. JS receives the signature; the action consumer verifies it before proceeding.
 * That work is deferred until a flow needs it — keep this bridge UX-only for now.
 */
class BiometricBridge(private val activity: FragmentActivity) {

    /**
     * Returns true if the device can perform a biometric prompt right now (hardware
     * present, sensor enrolled, no lockout).
     */
    fun canAuthenticate(): JSONObject {
        val manager = BiometricManager.from(activity)
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val status = manager.canAuthenticate(authenticators)
        return JSONObject()
            .put("status", status)
            .put("kind", statusName(status))
    }

    /**
     * Show the biometric prompt and invoke [callback] when the user finishes (or the
     * sensor errors). Safe to call from any thread; routes UI work onto the main
     * executor.
     */
    fun prompt(payloadJson: String, callback: (JSONObject) -> Unit) {
        val parsed = try {
            JSONObject(payloadJson)
        } catch (err: Exception) {
            callback(
                JSONObject()
                    .put("ok", false)
                    .put("kind", "ERROR")
                    .put("code", "parse_failed")
                    .put("message", "biometric payload was not valid JSON"),
            )
            return
        }
        val title = parsed.optString("title", "Confirm with biometrics").ifBlank { "Confirm" }
        val subtitle = parsed.optString("subtitle", "").takeIf { it.isNotBlank() }
        val description = parsed.optString("description", "").takeIf { it.isNotBlank() }
        val negativeButton = parsed.optString("negativeButton", "Cancel").ifBlank { "Cancel" }
        val allowDeviceCredential = parsed.optBoolean("allowDeviceCredential", false)

        val infoBuilder = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
        subtitle?.let { infoBuilder.setSubtitle(it) }
        description?.let { infoBuilder.setDescription(it) }
        if (allowDeviceCredential) {
            infoBuilder.setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL,
            )
        } else {
            infoBuilder.setNegativeButtonText(negativeButton)
            infoBuilder.setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.BIOMETRIC_WEAK,
            )
        }
        val info = infoBuilder.build()

        activity.runOnUiThread {
            try {
                val executor = ContextCompat.getMainExecutor(activity)
                val prompt = BiometricPrompt(
                    activity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            callback(
                                JSONObject()
                                    .put("ok", true)
                                    .put("kind", "AUTH_SUCCEEDED")
                                    .put("authType", result.authenticationType),
                            )
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            val kind = errorKind(errorCode)
                            callback(
                                JSONObject()
                                    .put("ok", false)
                                    .put("kind", kind)
                                    .put("code", errorCode)
                                    .put("message", errString.toString()),
                            )
                        }

                        override fun onAuthenticationFailed() {
                            // Per-attempt failure (e.g., bad fingerprint). The prompt
                            // remains open so the user can retry; do not fire the
                            // callback yet — only fire on final SUCCESS or ERROR.
                        }
                    },
                )
                prompt.authenticate(info)
            } catch (err: Exception) {
                AgentMwaLog.failure(
                    "BiometricBridge",
                    "prompt",
                    "FAIL_DISPATCH",
                    "biometric prompt dispatch threw",
                    err,
                )
                callback(
                    JSONObject()
                        .put("ok", false)
                        .put("kind", "ERROR")
                        .put("code", "dispatch_failed")
                        .put("message", err.message ?: err.javaClass.simpleName),
                )
            }
        }
    }

    private fun statusName(status: Int): String = when (status) {
        BiometricManager.BIOMETRIC_SUCCESS -> "AVAILABLE"
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "NO_HARDWARE"
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "HARDWARE_UNAVAILABLE"
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "NO_ENROLLED"
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "SECURITY_UPDATE_REQUIRED"
        BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> "UNSUPPORTED"
        BiometricManager.BIOMETRIC_STATUS_UNKNOWN -> "UNKNOWN"
        else -> "OTHER"
    }

    private fun errorKind(errorCode: Int): String = when (errorCode) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED -> "USER_CANCELED"
        BiometricPrompt.ERROR_LOCKOUT,
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKED_OUT"
        BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_ENROLLED"
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE -> "HARDWARE_UNAVAILABLE"
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "NO_DEVICE_CREDENTIAL"
        else -> "ERROR"
    }
}
