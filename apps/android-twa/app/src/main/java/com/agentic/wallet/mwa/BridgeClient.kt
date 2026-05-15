package com.agentic.wallet.mwa

import com.agentic.wallet.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class BridgeClient(
    private val baseUrl: String,
    private val token: String,
) {
    private var configuredRpcUrl: String = ""

    suspend fun config(): Pair<AgentCluster, String> {
        AgentMwaLog.info("BridgeClient", "config", "START", "fetching bridge config", bridgeBaseMetadata())
        val json = request("GET", "/bridge/config")
        val cluster = AgentCluster.requireSupported(json.optString("cluster", "devnet"))
        configuredRpcUrl = json.optString("rpcUrl", "")
        AgentMwaLog.info("BridgeClient", "config", "SUCCESS", "bridge config loaded", bridgeBaseMetadata() + mapOf("cluster" to cluster.id, "rpcUrl" to json.optString("rpcUrl", ""), "response" to if (BuildConfig.DEBUG) json else "[debug-only]"))
        return cluster to configuredRpcUrl
    }

    suspend fun connect(address: String, capabilities: JSONObject) {
        AgentMwaLog.info("BridgeClient", "connect", "START", "connecting bridge host", bridgeBaseMetadata() + mapOf("address" to address, "capabilities" to if (BuildConfig.DEBUG) capabilities else "[debug-only]"))
        request(
            "POST",
            "/bridge/connect",
            JSONObject()
                .put("address", address)
                .put("capabilities", capabilities),
        )
        trace("android.bridge.connected", JSONObject().put("address", address).put("backend", "android-native-mwa"))
        AgentMwaLog.info("BridgeClient", "connect", "SUCCESS", "bridge host connected", bridgeBaseMetadata() + mapOf("address" to address))
    }

    suspend fun disconnect() {
        AgentMwaLog.info("BridgeClient", "disconnect", "START", "disconnecting bridge host", bridgeBaseMetadata())
        request("POST", "/bridge/disconnect", JSONObject())
        AgentMwaLog.info("BridgeClient", "disconnect", "SUCCESS", "bridge host disconnected", bridgeBaseMetadata())
    }

    suspend fun nextRequest(): AgentMwaBridgeRequest? {
        AgentMwaLog.info("BridgeClient", "nextRequest", "START", "polling bridge for next request", bridgeBaseMetadata())
        val json = request("GET", "/bridge/next")
        val request = json.optJSONObject("request")
        if (request == null) {
            AgentMwaLog.info("BridgeClient", "nextRequest", "DONE", "no bridge request pending", bridgeBaseMetadata() + mapOf("response" to if (BuildConfig.DEBUG) json else "[debug-only]"))
            return null
        }
        val payload = request.optJSONObject("payload") ?: JSONObject()
        val display = request.optJSONObject("display")
        val bridgeRequest = AgentMwaBridgeRequest(
            id = request.optString("id", ""),
            kind = request.optString("kind", ""),
            payloadData = payload.optString("data", ""),
            payloadEncoding = payload.optString("encoding", "base64"),
            cluster = AgentCluster.requireSupported(request.optString("cluster", "devnet")),
            rpcUrl = request.optString("rpcUrl", "").takeIf { it.isNotBlank() } ?: configuredRpcUrl.takeIf { it.isNotBlank() },
            summary = display?.optString("summary"),
        ).takeIf { it.id.isNotBlank() && it.kind.isNotBlank() }
        AgentMwaLog.info(
            "BridgeClient",
            "nextRequest",
            if (bridgeRequest == null) "FAIL_INVALID_REQUEST" else "SUCCESS",
            "bridge request decoded",
            bridgeBaseMetadata() + bridgeRequestMetadata(bridgeRequest, request),
        )
        return bridgeRequest
    }

    suspend fun resolve(requestId: String, result: AgentMwaSigningResult) {
        val body = JSONObject()
            .put("requestId", requestId)
            .put("signature", result.signature)
        if (result.txid != null) {
            body.put("txid", result.txid)
        }
        AgentMwaLog.info("BridgeClient", "resolve", "START", "resolving bridge request", bridgeBaseMetadata() + signingResultMetadata(requestId, result, body))
        request("POST", "/bridge/resolve", body)
        trace("android.approval.success", JSONObject().put("requestId", requestId).put("txid", result.txid ?: ""))
        AgentMwaLog.info("BridgeClient", "resolve", "SUCCESS", "bridge request resolved", bridgeBaseMetadata() + signingResultMetadata(requestId, result, body))
    }

    suspend fun reject(requestId: String, error: MwaOperationException) {
        val body = JSONObject()
            .put("requestId", requestId)
            .put(
                "error",
                JSONObject()
                    .put("code", protocolCode(error.code))
                    .put("message", error.message)
                    .put("recoverable", error.code in RECOVERABLE_CODES),
        )
        AgentMwaLog.info("BridgeClient", "reject", "START", "rejecting bridge request", bridgeBaseMetadata() + mapOf("requestId" to requestId, "code" to error.code, "message" to error.message, "body" to if (BuildConfig.DEBUG) body else "[debug-only]"))
        request("POST", "/bridge/reject", body)
        trace("android.approval.error", JSONObject().put("requestId", requestId).put("code", error.code))
        AgentMwaLog.info("BridgeClient", "reject", "SUCCESS", "bridge request rejected", bridgeBaseMetadata() + mapOf("requestId" to requestId, "code" to error.code, "message" to error.message, "body" to if (BuildConfig.DEBUG) body else "[debug-only]"))
    }

    suspend fun trace(event: String, payload: JSONObject) {
        AgentMwaLog.info("BridgeClient", "trace", "START", "posting bridge trace event", bridgeBaseMetadata() + mapOf("event" to event, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]"))
        request("POST", "/bridge/trace", JSONObject().put("event", event).put("payload", payload))
        AgentMwaLog.info("BridgeClient", "trace", "SUCCESS", "bridge trace event posted", bridgeBaseMetadata() + mapOf("event" to event, "payload" to if (BuildConfig.DEBUG) payload else "[debug-only]"))
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val url = URL(resolveUrl(path))
        val bodyText = body?.toString().orEmpty()
        AgentMwaLog.info(
            "BridgeClient",
            "request",
            "START",
            "bridge HTTP request starting",
            bridgeBaseMetadata() + mapOf(
                "method" to method,
                "path" to path,
                "url" to url,
                "body" to if (BuildConfig.DEBUG && body != null) bodyText else "[debug-only]",
                "bodyBytes" to bodyText.toByteArray(Charsets.UTF_8).size,
                "bodySha256_8" to sha256First8(bodyText.toByteArray(Charsets.UTF_8)),
            ),
        )
        val conn = (url.openConnection() as HttpURLConnection)
        try {
            conn.apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 30_000
                setRequestProperty("x-agent-wallet-token", token)
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) {
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(bodyText) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val error = runCatching { JSONObject(text).optString("error", text) }.getOrDefault(text)
                AgentMwaLog.warn(
                    "BridgeClient",
                    "request",
                    "FAIL_HTTP_STATUS",
                    "bridge HTTP request failed",
                    bridgeBaseMetadata() + mapOf("method" to method, "path" to path, "status" to status, "response" to if (BuildConfig.DEBUG) text else "[debug-only]", "responseBytes" to text.toByteArray(Charsets.UTF_8).size),
                )
                throw MwaOperationException(if (status == 401) "UNAUTHORIZED" else "WALLET_UNREACHABLE", error.ifBlank { "Bridge request failed with HTTP $status." })
            }
            AgentMwaLog.info(
                "BridgeClient",
                "request",
                "SUCCESS",
                "bridge HTTP request complete",
                bridgeBaseMetadata() + mapOf("method" to method, "path" to path, "status" to status, "response" to if (BuildConfig.DEBUG) text else "[debug-only]", "responseBytes" to text.toByteArray(Charsets.UTF_8).size, "responseSha256_8" to sha256First8(text.toByteArray(Charsets.UTF_8))),
            )
            if (text.isBlank()) JSONObject() else JSONObject(text)
        } catch (err: MwaOperationException) {
            throw err
        } catch (err: Exception) {
            AgentMwaLog.failure(
                "BridgeClient",
                "request",
                "FAIL_EXCEPTION",
                "bridge HTTP request threw",
                err,
                bridgeBaseMetadata() + mapOf("method" to method, "path" to path, "url" to url),
            )
            throw err
        } finally {
            conn.disconnect()
        }
    }

    private fun resolveUrl(path: String): String {
        val base = if (baseUrl.endsWith("/")) baseUrl.dropLast(1) else baseUrl
        return "$base$path"
    }

    private fun protocolCode(code: String): String = when (code) {
        "USER_REJECTED" -> "user_rejected"
        "NO_WALLET_FOUND", "WALLET_HUNG", "WALLET_ERROR", "WALLET_NATIVE_SIGN_AND_SEND_UNSUPPORTED" -> "wallet_unreachable"
        "UNAUTHORIZED", "WALLET_AUTH_MISMATCH", "WALLET_CHANGED" -> "unauthorized"
        "CLUSTER_MISMATCH" -> "cluster_mismatch"
        "UNSUPPORTED_METHOD", "WALLET_SIGN_MESSAGES_UNSUPPORTED", "JUPITER_SIGN_TRANSACTION_UNSUPPORTED" -> "unsupported_method"
        "INVALID_PAYLOADS", "INVALID_REQUEST" -> "invalid_request"
        "RPC_BROADCAST_FAILED" -> "wallet_unreachable"
        "INSUFFICIENT_FUNDS_FOR_RENT" -> "unauthorized"
        else -> "wallet_unreachable"
    }

    private fun bridgeBaseMetadata(): Map<String, Any?> =
        mapOf("baseUrl" to baseUrl, "bridgeAuthHeaderChars" to token.length)

    private fun bridgeRequestMetadata(request: AgentMwaBridgeRequest?, raw: JSONObject): Map<String, Any?> =
        if (request == null) {
            mapOf("rawRequest" to if (BuildConfig.DEBUG) raw else "[debug-only]")
        } else {
            mapOf(
                "requestId" to request.id,
                "kind" to request.kind,
                "cluster" to request.cluster.id,
                "rpcUrl" to request.rpcUrl.orEmpty(),
                "summary" to request.summary.orEmpty(),
                "payloadEncoding" to request.payloadEncoding,
                "payloadChars" to request.payloadData.length,
                "payloadSha256_8" to sha256First8(request.payloadData.toByteArray(Charsets.UTF_8)),
                "payloadData" to if (BuildConfig.DEBUG) request.payloadData else "[debug-only]",
                "rawRequest" to if (BuildConfig.DEBUG) raw else "[debug-only]",
            )
        }

    private fun signingResultMetadata(requestId: String, result: AgentMwaSigningResult, body: JSONObject): Map<String, Any?> =
        mapOf(
            "requestId" to requestId,
            "signature" to result.signature,
            "txid" to result.txid.orEmpty(),
            "body" to if (BuildConfig.DEBUG) body else "[debug-only]",
        )

    private fun sha256First8(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .take(8)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    companion object {
        private val RECOVERABLE_CODES = setOf(
            "NO_WALLET_FOUND",
            "WALLET_HUNG",
            "WALLET_AUTH_MISMATCH",
            "WALLET_CHANGED",
            "INSUFFICIENT_FUNDS_FOR_RENT",
        )
    }
}
