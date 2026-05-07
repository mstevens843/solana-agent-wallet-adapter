package com.agentic.wallet.mwa

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class BridgeClient(
    private val baseUrl: String,
    private val token: String,
) {
    suspend fun config(): Pair<AgentCluster, String> {
        AgentMwaLog.info("BridgeClient", "config", "START", "fetching bridge config", mapOf("baseUrl" to baseUrl))
        val json = request("GET", "/bridge/config")
        val cluster = AgentCluster.requireSupported(json.optString("cluster", "devnet"))
        AgentMwaLog.info("BridgeClient", "config", "SUCCESS", "bridge config loaded", mapOf("cluster" to cluster.id))
        return cluster to json.optString("rpcUrl", "")
    }

    suspend fun connect(address: String, capabilities: JSONObject) {
        AgentMwaLog.info("BridgeClient", "connect", "START", "connecting bridge host", mapOf("address" to short(address)))
        request(
            "POST",
            "/bridge/connect",
            JSONObject()
                .put("address", address)
                .put("capabilities", capabilities),
        )
        trace("android.bridge.connected", JSONObject().put("address", address).put("backend", "android-native-mwa"))
        AgentMwaLog.info("BridgeClient", "connect", "SUCCESS", "bridge host connected", mapOf("address" to short(address)))
    }

    suspend fun disconnect() {
        AgentMwaLog.info("BridgeClient", "disconnect", "START", "disconnecting bridge host")
        request("POST", "/bridge/disconnect", JSONObject())
        AgentMwaLog.info("BridgeClient", "disconnect", "SUCCESS", "bridge host disconnected")
    }

    suspend fun nextRequest(): AgentMwaBridgeRequest? {
        val json = request("GET", "/bridge/next")
        val request = json.optJSONObject("request") ?: return null
        val payload = request.optJSONObject("payload") ?: JSONObject()
        val display = request.optJSONObject("display")
        return AgentMwaBridgeRequest(
            id = request.optString("id", ""),
            kind = request.optString("kind", ""),
            payloadData = payload.optString("data", ""),
            payloadEncoding = payload.optString("encoding", "base64"),
            cluster = AgentCluster.requireSupported(request.optString("cluster", "devnet")),
            summary = display?.optString("summary"),
        ).takeIf { it.id.isNotBlank() && it.kind.isNotBlank() }
    }

    suspend fun resolve(requestId: String, result: AgentMwaSigningResult) {
        val body = JSONObject()
            .put("requestId", requestId)
            .put("signature", result.signature)
        if (result.txid != null) {
            body.put("txid", result.txid)
        }
        request("POST", "/bridge/resolve", body)
        trace("android.approval.success", JSONObject().put("requestId", requestId).put("txid", result.txid ?: ""))
        AgentMwaLog.info("BridgeClient", "resolve", "SUCCESS", "bridge request resolved", mapOf("requestId" to requestId, "txid" to short(result.txid ?: "")))
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
        request("POST", "/bridge/reject", body)
        trace("android.approval.error", JSONObject().put("requestId", requestId).put("code", error.code))
        AgentMwaLog.warn("BridgeClient", "reject", "FAIL", "bridge request rejected", mapOf("requestId" to requestId, "code" to error.code))
    }

    suspend fun trace(event: String, payload: JSONObject) {
        request("POST", "/bridge/trace", JSONObject().put("event", event).put("payload", payload))
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val url = URL(resolveUrl(path))
        val conn = (url.openConnection() as HttpURLConnection).apply {
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
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body.toString()) }
        }
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
        conn.disconnect()
        if (status !in 200..299) {
            val error = runCatching { JSONObject(text).optString("error", text) }.getOrDefault(text)
            AgentMwaLog.warn("BridgeClient", "request", "FAIL", "bridge HTTP request failed", mapOf("method" to method, "path" to path, "status" to status))
            throw MwaOperationException(if (status == 401) "UNAUTHORIZED" else "WALLET_UNREACHABLE", error.ifBlank { "Bridge request failed with HTTP $status." })
        }
        AgentMwaLog.info("BridgeClient", "request", "SUCCESS", "bridge HTTP request complete", mapOf("method" to method, "path" to path, "status" to status))
        if (text.isBlank()) JSONObject() else JSONObject(text)
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

    private fun short(value: String, head: Int = 8, tail: Int = 8): String =
        if (value.length <= head + tail + 3) value else "${value.take(head)}...${value.takeLast(tail)}"

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
