// TypeScript port of ProviderErrorCodes.kt + the ProviderHttpException class.
// Keep wire-format codes byte-for-byte identical with the Kotlin runtime so
// browser-native and android-native error envelopes are interchangeable.

export const PROVIDER_ERROR_CODES = {
  TIMEOUT: 'provider_timeout',
  AUTH: 'provider_auth',
  RATE_LIMITED: 'provider_rate_limited',
  INVALID_RESPONSE: 'provider_invalid_response',
  INVALID_CONFIG: 'provider_invalid_config',
  UPSTREAM: 'provider_upstream',
  NETWORK: 'provider_network',
} as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

export class ProviderHttpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.code = code;
  }
}
