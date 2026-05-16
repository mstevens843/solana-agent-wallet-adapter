import { RUNTIME_CONFIG_SUBCODES, RUNTIME_ERROR_CODES } from './errors.js';
import type { RuntimeError } from './state.js';

export type RuntimeApiFormat = 'openai-compatible' | 'anthropic';

export const SUPPORTED_API_FORMATS: ReadonlySet<RuntimeApiFormat> = new Set<RuntimeApiFormat>([
  'openai-compatible',
  'anthropic',
]);

export interface RuntimeConfig {
  readonly provider: string;
  readonly apiFormat: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly walletAddress?: string;
}

export function canonicalApiFormat(value: string): string {
  const trimmed = value.trim();
  if (trimmed === 'openai') return 'openai-compatible';
  return trimmed;
}

export function validateRuntimeConfig(config: RuntimeConfig | null | undefined): RuntimeError | null {
  if (!config || !config.provider || !config.provider.trim()) {
    return {
      code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
      subcode: RUNTIME_CONFIG_SUBCODES.MISSING_PROVIDER,
      message: 'Device Agent config is missing provider.',
    };
  }
  const format = config.apiFormat ? config.apiFormat.trim() : '';
  if (!format || !(SUPPORTED_API_FORMATS as ReadonlySet<string>).has(format)) {
    const allowed = Array.from(SUPPORTED_API_FORMATS).join(', ');
    return {
      code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
      subcode: RUNTIME_CONFIG_SUBCODES.UNSUPPORTED_FORMAT,
      message: `Device Agent apiFormat must be one of ${allowed}.`,
    };
  }
  if (!config.model || !config.model.trim()) {
    return {
      code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
      subcode: RUNTIME_CONFIG_SUBCODES.MISSING_MODEL,
      message: 'Device Agent config is missing model.',
    };
  }
  if (!config.apiKey || !config.apiKey.trim()) {
    return {
      code: RUNTIME_ERROR_CODES.INVALID_CONFIG,
      subcode: RUNTIME_CONFIG_SUBCODES.MISSING_API_KEY,
      message: 'Device Agent config is missing apiKey.',
    };
  }
  return null;
}

export function redactedSummary(config: RuntimeConfig): Record<string, unknown> {
  const wallet = config.walletAddress;
  return {
    provider: config.provider,
    apiFormat: config.apiFormat,
    model: config.model,
    baseUrl: config.baseUrl ?? '',
    hasKey: Boolean(config.apiKey && config.apiKey.trim()),
    walletShort: wallet ? wallet.slice(0, 4) : undefined,
  };
}
