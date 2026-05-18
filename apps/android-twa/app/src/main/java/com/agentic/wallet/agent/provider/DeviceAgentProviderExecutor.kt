package com.agentic.wallet.agent.provider

import com.agentic.wallet.agent.runtime.ProviderExecutor
import com.agentic.wallet.agent.runtime.ProviderFailedException
import com.agentic.wallet.agent.runtime.RuntimeConfig
import com.agentic.wallet.agent.runtime.RuntimeConfigSubcodes
import com.agentic.wallet.agent.runtime.RuntimeError
import com.agentic.wallet.agent.runtime.RuntimeErrorCodes
import kotlinx.coroutines.CancellationException
import org.json.JSONObject
import java.net.SocketTimeoutException

/**
 * Phase 3 entry point. Phase 6 swaps `ScaffoldProviderExecutor` for this class so the runtime
 * request queue routes `generatePlan` / `reviewPlan` / `ask` through the on-device Anthropic and
 * OpenAI-compatible providers.
 *
 * Contract:
 *  - Returns the **raw parsed model JSON** for `generatePlan` / `reviewPlan` (the browser's
 *    `normalizeAi*` will fill `checkedAt`, `source`, and template merge); returns raw answer
 *    text as `{"output_text": "..."}` for `ask`.
 *  - On error throws [ProviderFailedException] wrapping a [RuntimeError] whose `code` is one
 *    of the `provider_*` constants in [ProviderErrorCodes], or one of [RuntimeErrorCodes]
 *    (e.g. `invalid_config` with subcode `unsupported_format`).
 *  - Redacts the configured API key from every outgoing error message (both
 *    [ProviderHttpException.message] and unexpected `Throwable.message`).
 *  - **Cooperates with structured concurrency.** Coroutine cancellation propagates verbatim;
 *    [CancellationException] is never converted to [ProviderFailedException]. The underlying
 *    HTTP call ([DefaultHttpExecutor]) closes the socket on cancellation.
 *  - Thread-safe: a single instance may serve concurrent requests. Each call constructs its
 *    own provider implementation and HTTP connection; no shared mutable state.
 */
class DeviceAgentProviderExecutor(
    private val httpExecutor: HttpExecutor = DefaultHttpExecutor(),
) : ProviderExecutor {

    override suspend fun generatePlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.generatePlan(payload) }

    override suspend fun reviewPlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.reviewPlan(payload) }

    override suspend fun ask(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.ask(payload) }

    private suspend fun execute(
        config: RuntimeConfig,
        block: suspend (DeviceAgentProvider) -> JSONObject,
    ): JSONObject {
        val provider = providerFor(config)
        return try {
            block(provider)
        } catch (cancel: CancellationException) {
            // Structured-concurrency cancellation must propagate unchanged so the runtime
            // queue and the WebView bridge tear down cleanly. Never wrap as ProviderFailed.
            throw cancel
        } catch (failure: ProviderHttpException) {
            throw ProviderFailedException(
                RuntimeError(
                    code = failure.code,
                    message = SecretRedactor.redact(failure.message, config.apiKey),
                ),
            )
        } catch (failure: Throwable) {
            val raw = failure.message?.takeIf { it.isNotBlank() } ?: "Provider call failed."
            val code = if (failure.hasCause<SocketTimeoutException>()) {
                ProviderErrorCodes.TIMEOUT
            } else {
                ProviderErrorCodes.NETWORK
            }
            throw ProviderFailedException(
                RuntimeError(
                    code = code,
                    message = SecretRedactor.redact(raw, config.apiKey),
                ),
            )
        }
    }

    private fun providerFor(config: RuntimeConfig): DeviceAgentProvider {
        val format = RuntimeConfig.canonicalApiFormat(config.apiFormat)
        val provider = config.provider.trim().lowercase()
        return when (format) {
            "openai-compatible" -> when (provider) {
                "openai" -> OpenAiNativeProvider(config, httpExecutor)
                "gemini" -> GeminiNativeProvider(config, httpExecutor)
                else -> OpenAiCompatibleProvider(config, httpExecutor)
            }
            "anthropic" -> AnthropicProvider(config, httpExecutor)
            else -> throw ProviderFailedException(
                RuntimeError(
                    code = RuntimeErrorCodes.INVALID_CONFIG,
                    subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                    message = "Device Agent does not support apiFormat \"${config.apiFormat}\".",
                ),
            )
        }
    }

    private inline fun <reified T : Throwable> Throwable.hasCause(): Boolean {
        var current: Throwable? = this
        val seen = mutableSetOf<Throwable>()
        while (current != null && seen.add(current)) {
            if (current is T) return true
            current = current.cause
        }
        return false
    }
}
