package com.agentic.wallet.agent.provider

import java.util.ArrayDeque

internal class FakeHttpExecutor : HttpExecutor {
    data class Recorded(val url: String, val headers: Map<String, String>, val body: String)

    private val responses = ArrayDeque<Either>()
    val calls: MutableList<Recorded> = mutableListOf()

    fun queueResponse(status: Int, body: String) {
        responses.add(Either.Response(HttpResponse(status, body)))
    }

    fun queueFailure(throwable: Throwable) {
        responses.add(Either.Failure(throwable))
    }

    override suspend fun postJson(url: String, headers: Map<String, String>, body: String): HttpResponse {
        calls.add(Recorded(url, headers, body))
        val next = responses.pollFirst()
            ?: error("FakeHttpExecutor has no queued response for call ${calls.size}")
        return when (next) {
            is Either.Response -> next.response
            is Either.Failure -> throw next.throwable
        }
    }

    private sealed class Either {
        data class Response(val response: HttpResponse) : Either()
        data class Failure(val throwable: Throwable) : Either()
    }
}
