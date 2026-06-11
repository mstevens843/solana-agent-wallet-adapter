package com.agentic.wallet.agent.bridge

import com.agentic.wallet.agent.provider.HttpResponse
import java.util.ArrayDeque

internal class FakeBridgeRelayTransport : BridgeRelayTransport {
    data class Recorded(val method: String, val url: String, val headers: Map<String, String>, val body: String?)

    val calls: MutableList<Recorded> = mutableListOf()
    private val responses = ArrayDeque<() -> HttpResponse>()

    fun queueResponse(status: Int, body: String) {
        responses.add { HttpResponse(status, body) }
    }

    fun queueFailure(throwable: Throwable) {
        responses.add { throw throwable }
    }

    override suspend fun request(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpResponse {
        calls.add(Recorded(method, url, headers, body))
        val next = responses.pollFirst() ?: error("FakeBridgeRelayTransport has no queued response for call ${calls.size}")
        return next()
    }
}
