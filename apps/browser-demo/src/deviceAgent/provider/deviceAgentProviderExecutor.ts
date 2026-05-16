// TypeScript port of DeviceAgentProviderExecutor.kt. Routes by apiFormat,
// wraps every ProviderHttpError into ProviderFailedError with the API key
// redacted, and propagates AbortError verbatim so the runtime queue maps it
// to runtime_canceled. Unsupported formats fail with the RUNTIME-tier
// invalid_config code + unsupported_format subcode (NOT the provider tier).

import { canonicalApiFormat, type RuntimeConfig } from '../runtime/config.js';
import {
  ProviderFailedError,
  RUNTIME_CONFIG_SUBCODES,
  RUNTIME_ERROR_CODES,
} from '../runtime/errors.js';
import type { ProviderExecutor } from '../runtime/queue.js';

import { AnthropicProvider } from './anthropicProvider.js';
import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';
import { FetchHttpExecutor, type HttpExecutor } from './http.js';
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider.js';
import { redactSecret } from './secretRedactor.js';
import type { DeviceAgentProvider } from './types.js';

export class DeviceAgentProviderExecutor implements ProviderExecutor {
  private readonly http: HttpExecutor;

  constructor(http: HttpExecutor = new FetchHttpExecutor()) {
    this.http = http;
  }

  generatePlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, signal, (provider) => provider.generatePlan(payload, signal));
  }

  reviewPlan(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, signal, (provider) => provider.reviewPlan(payload, signal));
  }

  ask(config: RuntimeConfig, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.execute(config, signal, (provider) => provider.ask(payload, signal));
  }

  private async execute(
    config: RuntimeConfig,
    signal: AbortSignal | undefined,
    block: (provider: DeviceAgentProvider) => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const provider = this.providerFor(config);
    try {
      return await block(provider);
    } catch (err) {
      // AbortError propagates verbatim; the queue maps it to runtime_canceled.
      if (isAbortError(err) || signal?.aborted === true) {
        throw err;
      }
      if (err instanceof ProviderHttpError) {
        throw new ProviderFailedError({
          code: err.code,
          message: redactSecret(err.message, config.apiKey),
        });
      }
      const rawMessage =
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : 'Provider call failed.';
      const code = hasCauseName(err, 'TimeoutError')
        ? PROVIDER_ERROR_CODES.TIMEOUT
        : PROVIDER_ERROR_CODES.NETWORK;
      throw new ProviderFailedError({
        code,
        message: redactSecret(rawMessage, config.apiKey),
      });
    }
  }

  private providerFor(config: RuntimeConfig): DeviceAgentProvider {
    const format = canonicalApiFormat(config.apiFormat);
    switch (format) {
      case 'openai-compatible':
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
