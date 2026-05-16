import { DEVICE_AGENT_ERROR_CODES } from '@solana-agent-wallet-adapter/workflow';

import type { RuntimeError } from './state.js';

export const RUNTIME_ERROR_CODES = DEVICE_AGENT_ERROR_CODES;

export const RUNTIME_CONFIG_SUBCODES = {
  MISSING_PROVIDER: 'missing_provider',
  MISSING_MODEL: 'missing_model',
  MISSING_API_KEY: 'missing_api_key',
  UNSUPPORTED_FORMAT: 'unsupported_format',
} as const;
export type RuntimeConfigSubcode = (typeof RUNTIME_CONFIG_SUBCODES)[keyof typeof RUNTIME_CONFIG_SUBCODES];

export class ProviderUnavailableError extends Error {
  readonly error: RuntimeError;

  constructor(error: RuntimeError) {
    super(error.message);
    this.name = 'ProviderUnavailableError';
    this.error = error;
  }
}

export class ProviderFailedError extends Error {
  readonly error: RuntimeError;

  constructor(error: RuntimeError) {
    super(error.message);
    this.name = 'ProviderFailedError';
    this.error = error;
  }
}
