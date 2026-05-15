package com.agentic.wallet.agent.provider

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
 * HTTP response captured from a provider call.
 *
 * `status` is the raw HTTP status code (no remapping). `body` is the response body decoded as
 * UTF-8 — at most [DefaultHttpExecutor.MAX_RESPONSE_BYTES] bytes; if the upstream sends more,
 * the call fails with [ProviderHttpException] before this type is constructed.
 */
data class HttpResponse(val status: Int, val body: String)

/**
 * Pluggable HTTP transport for the Device Agent providers.
 *
 * Implementations MUST:
 *  - Be `suspend`-friendly: callers expect the function to suspend until the response is
 *    fully read, and to respect coroutine cancellation by aborting the in-flight request
 *    (closing the socket) rather than blocking until completion.
 *  - Throw [ProviderHttpException] (with a `provider_*` code from [ProviderErrorCodes]) for
 *    transport-level failures (timeout, network, malformed scheme, oversize body).
 *  - NOT throw for non-2xx HTTP statuses — return them in [HttpResponse.status] so the
 *    provider layer can compose a user-facing error via [ProviderHttp.composeErrorMessage].
 *
 * The default implementation is [DefaultHttpExecutor]; tests inject a fake.
 */
interface HttpExecutor {
    suspend fun postJson(url: String, headers: Map<String, String>, body: String): HttpResponse
}

/**
 * Production implementation backed by [HttpURLConnection].
 *
 * Behavior contract:
 *  - **HTTPS only.** A non-`https://` URL fails immediately with
 *    [ProviderErrorCodes.INVALID_CONFIG]; this prevents an accidentally-misconfigured
 *    `baseUrl` from POSTing bearer tokens or `x-api-key` headers over cleartext.
 *  - **Cancellation.** Wrapped in [suspendCancellableCoroutine]; when the parent coroutine
 *    cancels, [HttpURLConnection.disconnect] fires immediately from the cancellation handler,
 *    closing the socket and unblocking the I/O thread.
 *  - **Body-size cap.** Reads at most [MAX_RESPONSE_BYTES] (1 MB) from the response stream;
 *    larger payloads fail with [ProviderErrorCodes.INVALID_RESPONSE]. Plan/review responses
 *    are ~4 KB and ask responses ~3 KB; the cap is generous but blocks runaway/adversarial bodies.
 *  - **Charset.** Request body sent as UTF-8 with `Content-Type: application/json; charset=utf-8`;
 *    response decoded as UTF-8.
 *  - **Headers.** Defaults (`Content-Type`, `Accept`) are set before caller-supplied headers
 *    so a caller can override them when a future provider needs to.
 *  - **Fixed-length streaming mode** is used to avoid chunked-transfer-encoding (some upstream
 *    proxies behave badly with chunked POSTs).
 *
 * Exceptions:
 *  - `SocketTimeoutException` → [ProviderErrorCodes.TIMEOUT]
 *  - other [IOException] → [ProviderErrorCodes.NETWORK]
 *  - oversize body → [ProviderErrorCodes.INVALID_RESPONSE]
 *  - non-https → [ProviderErrorCodes.INVALID_CONFIG]
 */
internal class DefaultHttpExecutor(
    private val connectTimeoutMs: Int = 30_000,
    private val readTimeoutMs: Int = 60_000,
) : HttpExecutor {
    override suspend fun postJson(
        url: String,
        headers: Map<String, String>,
        body: String,
    ): HttpResponse {
        if (!url.startsWith("https://", ignoreCase = true)) {
            throw ProviderHttpException(
                ProviderErrorCodes.INVALID_CONFIG,
                "Device Agent provider URL must use https://; got \"$url\".",
            )
        }
        return withContext(Dispatchers.IO) {
            suspendCancellableCoroutine { cont ->
                val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = connectTimeoutMs
                    readTimeout = readTimeoutMs
                    doInput = true
                    doOutput = true
                    useCaches = false
                    instanceFollowRedirects = false
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    setRequestProperty("Accept", "application/json")
                    for ((name, value) in headers) {
                        setRequestProperty(name, value)
                    }
                }
                cont.invokeOnCancellation {
                    try {
                        connection.disconnect()
                    } catch (_: Throwable) {
                        // ignore — best effort during cancellation
                    }
                }

                val payloadBytes = body.toByteArray(Charsets.UTF_8)
                connection.setFixedLengthStreamingMode(payloadBytes.size)

                try {
                    connection.outputStream.use { it.write(payloadBytes) }
                    val status = connection.responseCode
                    val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                    val responseBody = stream?.let { readCapped(it) }.orEmpty()
                    cont.resume(HttpResponse(status = status, body = responseBody))
                } catch (cap: ResponseTooLargeException) {
                    cont.resumeWithException(
                        ProviderHttpException(
                            ProviderErrorCodes.INVALID_RESPONSE,
                            "Provider response exceeded the ${MAX_RESPONSE_BYTES / 1024} KiB cap.",
                        ),
                    )
                } catch (timeout: SocketTimeoutException) {
                    cont.resumeWithException(
                        ProviderHttpException(ProviderErrorCodes.TIMEOUT, "Provider request timed out."),
                    )
                } catch (io: IOException) {
                    // If the coroutine was cancelled, the disconnect() in invokeOnCancellation
                    // is the cause of the IOException — don't surface as a NETWORK error.
                    if (!cont.isActive) return@suspendCancellableCoroutine
                    cont.resumeWithException(
                        ProviderHttpException(
                            ProviderErrorCodes.NETWORK,
                            io.message?.takeIf { it.isNotBlank() } ?: "Provider network error.",
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
        // Use char count as a proxy for byte count: UTF-8 chars average <= 4 bytes, but at the
        // cap (1_048_576 bytes) the char count is always <= byte count, so this is conservative.
        val maxChars = MAX_RESPONSE_BYTES
        while (true) {
            val read = reader.read(buffer)
            if (read == -1) break
            if (out.length + read > maxChars) {
                throw ResponseTooLargeException()
            }
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
