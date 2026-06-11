package com.agentic.wallet.agent.bridge

import com.agentic.wallet.agent.provider.HttpResponse
import com.agentic.wallet.agent.provider.ProviderErrorCodes
import com.agentic.wallet.agent.provider.ProviderHttpException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * HTTP transport for the phone-pairing relay (apps/render-web bridgeAiRelayHandler.ts).
 *
 * Distinct from [com.agentic.wallet.agent.provider.HttpExecutor] because the relay needs GET
 * (poll result / status) in addition to POST, whereas the provider transport is POST-only.
 * Same hardening contract as [com.agentic.wallet.agent.provider.DefaultHttpExecutor]:
 *  - HTTPS only (the relay carries a Bearer token; never send it cleartext).
 *  - Returns non-2xx in [HttpResponse.status]; throws [ProviderHttpException] only for
 *    transport failures (timeout/network/oversize/non-https).
 *  - Cancellation aborts the in-flight request.
 *
 * v1 transport security: HTTPS-only + the relay-host allowlist (BridgeRelayPolicy). NOTE: certificate
 * PINNING is NOT yet in place (no res/xml/network_security_config.xml ships) — it's deferred GA
 * hardening that needs the production relay's SPKI hash + a backup pin. Until then a malicious CA on
 * the allowlisted host is not blocked; the bearer + one-time token are the primary trust anchors.
 */
internal interface BridgeRelayTransport {
    suspend fun request(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse
}

internal class DefaultBridgeRelayTransport(
    private val connectTimeoutMs: Int = 15_000,
    // Generous: a single poll returns fast, but a `forward` of a large plan body should not time out.
    private val readTimeoutMs: Int = 60_000,
) : BridgeRelayTransport {
    override suspend fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpResponse {
        if (!url.startsWith("https://", ignoreCase = true)) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_CONFIG,
                "Bridge relay URL must use https://; got \"$url\".",
            )
        }
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = connectTimeoutMs
                    readTimeout = readTimeoutMs
                    doInput = true
                    useCaches = false
                    instanceFollowRedirects = false
                    setRequestProperty("Accept", "application/json")
                    if (body != null) {
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    }
                    for ((name, value) in headers) {
                        setRequestProperty(name, value)
                    }
                }
                cont.invokeOnCancellation {
                    try {
                        connection.disconnect()
                    } catch (_: Throwable) {
                        // best-effort during cancellation
                    }
                }

                try {
                    if (body != null) {
                        val payloadBytes = body.toByteArray(Charsets.UTF_8)
                        connection.setFixedLengthStreamingMode(payloadBytes.size)
                        connection.outputStream.use { it.write(payloadBytes) }
                    }
                    val status = connection.responseCode
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val responseBody = stream?.let { readCapped(it) }.orEmpty()
                    cont.resume(HttpResponse(status = status, body = responseBody))
                } catch (cap: ResponseTooLargeException) {
                    cont.resumeWithException(
                        ProviderHttpException(
                            ProviderErrorCodes.INVALID_RESPONSE,
                            "Bridge relay response exceeded the ${MAX_RESPONSE_BYTES / 1024} KiB cap.",
                        ),
                    )
                } catch (timeout: SocketTimeoutException) {
                    cont.resumeWithException(
                        ProviderHttpException(ProviderErrorCodes.TIMEOUT, "Bridge relay request timed out."),
                    )
                } catch (io: IOException) {
                    if (!cont.isActive) return@suspendCancellableCoroutine
                    cont.resumeWithException(
                        ProviderHttpException(
                            ProviderErrorCodes.NETWORK,
                            io.message?.takeIf { it.isNotBlank() } ?: "Bridge relay network error.",
                        ),
                    )
                } finally {
                    try {
                        connection.disconnect()
                    } catch (_: Throwable) {
                        // ignore
                    }
                }
            }
        }
    }

    private fun readCapped(stream: java.io.InputStream): String {
        val reader = InputStreamReader(stream, Charsets.UTF_8)
        val buffer = CharArray(BUFFER_CHARS)
        val out = StringBuilder()
        while (true) {
            val read = reader.read(buffer)
            if (read == -1) break
            if (out.length + read > MAX_RESPONSE_BYTES) throw ResponseTooLargeException()
            out.append(buffer, 0, read)
        }
        return out.toString()
    }

    private class ResponseTooLargeException : IOException("response too large")

    companion object {
        const val MAX_RESPONSE_BYTES: Int = 1_048_576
        private const val BUFFER_CHARS: Int = 8 * 1024
    }
}
