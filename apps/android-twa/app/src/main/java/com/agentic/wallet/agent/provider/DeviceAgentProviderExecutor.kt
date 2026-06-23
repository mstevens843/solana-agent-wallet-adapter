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
class DeviceAgentProviderExecutor internal constructor(
    private val httpExecutor: HttpExecutor = DefaultHttpExecutor(),
    /** Set on Android to route paired-bridge ("use your plan from your computer") configs to the
     *  relay instead of an on-device API-key provider. Null on builds without the feature. The
     *  constructor is `internal` because this param exposes the internal DeviceAgentProvider type. */
    private val bridgeRelayProvider: DeviceAgentProvider? = null,
) : ProviderExecutor {

    override suspend fun generatePlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.generatePlan(payload) }

    override suspend fun reviewPlan(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.reviewPlan(payload) }

    override suspend fun ask(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.ask(payload) }

    override suspend fun localize(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.localize(payload) }

    // Chat is paired-bridge only: providerFor() returns the bridge relay provider for
    // a paired config (which forwards /bridge/ai/chat); on-device providers inherit
    // DeviceAgentProvider.chat's default-throw.
    override suspend fun chat(config: RuntimeConfig, payload: JSONObject): JSONObject =
        execute(config) { it.chat(payload) }

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
        if (config.isPairedBridge()) {
            return bridgeRelayProvider ?: throw ProviderFailedException(
                RuntimeError(
                    code = RuntimeErrorCodes.INVALID_CONFIG,
                    subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                    message = "Paired-bridge AI isn't available on this build. Update the app or pair again.",
                ),
            )
        }
        val format = RuntimeConfig.canonicalApiFormat(config.apiFormat)
        val provider = config.provider.trim().lowercase()
        return when (format) {
            "openai-compatible" -> when (provider) {
                "openai" -> OpenAiNativeProvider(config, httpExecutor)
                "gemini" -> GeminiNativeProvider(config, httpExecutor)
                "openrouter" -> {
                    val model = config.model.trim().lowercase()
                    when {
                        model == "openrouter/auto" -> throw ProviderFailedException(
                            RuntimeError(
                                code = RuntimeErrorCodes.INVALID_CONFIG,
                                subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                                message = "OpenRouter Auto Router is disabled for Device Agent reviews. Choose a specific OpenRouter model.",
                            ),
                        )
                        model.startsWith("anthropic/") -> AnthropicProvider(config, httpExecutor)
                        model.startsWith("openai/") -> OpenAiNativeProvider(config, httpExecutor)
                        model.startsWith("google/") || model.contains("gemini") -> throw ProviderFailedException(
                            RuntimeError(
                                code = RuntimeErrorCodes.INVALID_CONFIG,
                                subcode = RuntimeConfigSubcodes.UNSUPPORTED_FORMAT,
                                message = "OpenRouter Gemini models are disabled for Device Agent reviews. Use the direct Gemini provider.",
                            ),
                        )
                        else -> OpenAiCompatibleProvider(config, httpExecutor)
                    }
                }
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
