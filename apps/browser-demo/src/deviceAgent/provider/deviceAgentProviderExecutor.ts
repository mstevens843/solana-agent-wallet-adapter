// TypeScript port of DeviceAgentProviderExecutor.kt. Routes by apiFormat,
// wraps every ProviderHttpError into ProviderFailedError with the API key
// redacted, and propagates AbortError verbatim so the runtime queue maps it
// to runtime_canceled. Unsupported formats fail with the RUNTIME-tier
// invalid_config code + unsupported_format subcode (NOT the provider tier).

import { canonicalApiFormat, type RuntimeConfig } from '../runtime/config.js';
import { diagNow, logDeviceAgentDiag } from '../runtime/diagnosticLog.js';
import {
  ProviderFailedError,
  RUNTIME_CONFIG_SUBCODES,
  RUNTIME_ERROR_CODES,
} from '../runtime/errors.js';
import type { ProviderExecutor } from '../runtime/queue.js';

import { AnthropicProvider } from './anthropicProvider.js';
import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import { GeminiNativeProvider } from './geminiNativeProvider.js';
import { FetchHttpExecutor, type HttpExecutor } from './http.js';
import { browserNetworkErrorGuidance } from './providerHttp.js';
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider.js';
import { OpenAiNativeProvider } from './openAiNativeProvider.js';
import { redactSecret } from './secretRedactor.js';
import type { DeviceAgentProvider } from './types.js';

export class DeviceAgentProviderExecutor implements ProviderExecutor {
  private readonly http: HttpExecutor;

  constructor(http: HttpExecutor = new FetchHttpExecutor()) {
    this.http = http;
  }

  generatePlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, 'generate-plan', signal, (provider) => provider.generatePlan(payload, signal));
  }

  reviewPlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, 'review-plan', signal, (provider) => provider.reviewPlan(payload, signal));
  }

  ask(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, 'ask', signal, (provider) => provider.ask(payload, signal));
  }

  private async execute(
    config: RuntimeConfig,
    op: string,
    signal: AbortSignal | undefined,
    block: (provider: DeviceAgentProvider) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const provider = this.providerFor(config);
    // Deterministic routing log: which concrete provider (and therefore which endpoint family)
    // handled this op for the configured provider/model. Pairs with the http.ts request log,
    // whose URL is the source of truth for the endpoint (/messages, /responses, /chat/completions).
    logDeviceAgentDiag('info', 'op.route', {
      op,
      provider: config.provider,
      apiFormat: config.apiFormat,
      model: config.model,
      handler: provider.constructor.name,
    });
    const startedAt = diagNow();
    try {
      const result = await block(provider);
      logDeviceAgentDiag('info', 'op.ok', { op, model: config.model, ms: Math.round(diagNow() - startedAt) });
      return result;
    } catch (err) {
      // AbortError propagates verbatim; the queue maps it to runtime_canceled.
      if (isAbortError(err) || signal?.aborted === true) {
        logDeviceAgentDiag('warn', 'op.canceled', { op, ms: Math.round(diagNow() - startedAt) });
        throw err;
      }
      let failed: ProviderFailedError;
      if (err instanceof ProviderHttpError) {
        // A browser network failure is almost always CORS/CSP, not an outage — enrich the bare
        // "Failed to fetch" with host-aware, actionable guidance. Other codes pass through.
        const message = err.code === PROVIDER_ERROR_CODES.NETWORK
          ? browserNetworkErrorGuidance(config.provider, config.baseUrl, err.message)
          : err.message;
        failed = new ProviderFailedError({
          code: err.code,
          message: redactSecret(message, config.apiKey),
        });
      } else {
        const rawMessage =
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : 'Provider call failed.';
        const code = hasCauseName(err, 'TimeoutError')
          ? PROVIDER_ERROR_CODES.TIMEOUT
          : PROVIDER_ERROR_CODES.NETWORK;
        failed = new ProviderFailedError({
          code,
          message: redactSecret(rawMessage, config.apiKey),
        });
      }
      logDeviceAgentDiag('error', 'op.error', {
        op,
        provider: config.provider,
        model: config.model,
        code: failed.error.code,
        ms: Math.round(diagNow() - startedAt),
      });
      throw failed;
    }
  }

  private providerFor(config: RuntimeConfig): DeviceAgentProvider {
    const format = canonicalApiFormat(config.apiFormat);
    const provider = (config.provider ?? '').trim().toLowerCase();
    switch (format) {
      case 'openai-compatible':
        // Native providers route by `config.provider`: OpenAI gets the Responses API +
        // web_search_preview, Gemini gets :generateContent + google_search grounding.
        if (provider === 'openai') return new OpenAiNativeProvider(config, this.http);
        if (provider === 'gemini') return new GeminiNativeProvider(config, this.http);
        if (provider === 'openrouter') {
          const model = config.model.trim().toLowerCase();
          if (model === 'openrouter/auto') {
            throw new ProviderFailedError({
              code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
              subcode: RUNTIME_CONFIG_SUBCODES.UNSUPPORTED_FORMAT,
              message: 'OpenRouter Auto Router is disabled for Device Agent reviews. Choose a specific OpenRouter model.',
            });
          }
          if (model.startsWith('anthropic/')) return new AnthropicProvider(config, this.http);
          if (model.startsWith('openai/')) return new OpenAiNativeProvider(config, this.http);
          if (model.startsWith('google/') || model.includes('gemini')) {
            throw new ProviderFailedError({
              code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
              subcode: RUNTIME_CONFIG_SUBCODES.UNSUPPORTED_FORMAT,
              message: 'OpenRouter Gemini models are disabled for Device Agent reviews. Use the direct Gemini provider.',
            });
          }
        }
        return new OpenAiCompatibleProvider(config, this.http);
      case 'anthropic':
        return new AnthropicProvider(config, this.http);
      default:
        throw new ProviderFailedError({
          code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
          subcode: RUNTIME_CONFIG_SUBCODES.UNSUPPORTED_FORMAT,
          message: `Device Agent does not support apiFormat "${config.apiFormat}".`,
        });
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

function hasCauseName(err: unknown, name: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.name === name) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
