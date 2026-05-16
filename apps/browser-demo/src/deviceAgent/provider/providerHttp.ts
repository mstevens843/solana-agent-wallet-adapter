// TypeScript port of ProviderHttp.kt. Preserves URL normalization regexes,
// HTTP status mapping, API-key header guard (ASCII printable only), and the
// composeErrorMessage no-double-period logic. Keep these byte-for-byte with
// the Kotlin runtime — the browser tests pin every branch.

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

const ANTHROPIC_VERSION_SEGMENT = /\/v\d+(\/|$)/i;
const OPENAI_VERSION_SEGMENT = /\/v\d+(beta)?(\/|$)/i;
const OPENAI_SUFFIX = /\/openai$/i;
const O_SERIES_PREFIX = /^o\d/;

export function mapHttpStatusToErrorCode(status: number): string | null {
  if (status >= 200 && status <= 299) return null;
  if (status === 401 || status === 403) return PROVIDER_ERROR_CODES.AUTH;
  if (status === 429) return PROVIDER_ERROR_CODES.RATE_LIMITED;
  if (status === 408 || status === 504) return PROVIDER_ERROR_CODES.TIMEOUT;
  if (status >= 500 && status <= 599) return PROVIDER_ERROR_CODES.UPSTREAM;
  return PROVIDER_ERROR_CODES.INVALID_RESPONSE;
}

export function normalizeBaseUrl(raw: string | null | undefined, apiFormat: string): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/u, '');
  if (trimmed.length === 0) {
    return apiFormat === 'anthropic' ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
  }
  if (apiFormat === 'anthropic') {
    return ANTHROPIC_VERSION_SEGMENT.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  if (OPENAI_VERSION_SEGMENT.test(trimmed) || OPENAI_SUFFIX.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

export function isDefaultTemperatureOnlyModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return (
    normalized.startsWith('gpt-5') ||
    normalized.includes('/gpt-5') ||
    O_SERIES_PREFIX.test(normalized) ||
    normalized.startsWith('o-') ||
    normalized.includes('/o1') ||
    normalized.includes('/o3') ||
    normalized.includes('/o4')
  );
}

export function assertApiKeyHeaderSafe(value: string): void {
  if (value.length === 0) {
    throw new ProviderHttpError(
      PROVIDER_ERROR_CODES.INVALID_CONFIG,
      'AI API key is empty. Re-enter the key from the provider dashboard.',
    );
  }
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      throw new ProviderHttpError(
        PROVIDER_ERROR_CODES.INVALID_CONFIG,
        'AI API key contains unsupported characters. Paste the key again as plain text and remove hidden separators or non-ASCII characters.',
      );
    }
    index += codePoint > 0xffff ? 2 : 1;
  }
}

export function composeErrorMessage(status: number, body: string): string {
  const rawMessage = extractProviderErrorMessage(body);
  const base = rawMessage.length > 0 ? rawMessage : `AI provider returned HTTP ${status}.`;
  const explanation = providerStatusExplanation(status);
  if (explanation.length === 0) return base.trim();
  const trimmedBase = base.trim();
  const endsTerminal = endsWithTerminal(trimmedBase);
  return endsTerminal ? `${trimmedBase} ${explanation}` : `${trimmedBase}. ${explanation}`;
}

function extractProviderErrorMessage(body: string): string {
  if (body.trim().length === 0) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (!isRecord(parsed)) return '';
  const errorField = parsed.error;
  if (typeof errorField === 'string') return errorField;
  if (isRecord(errorField)) {
    const message = errorField.message;
    if (typeof message === 'string') return message;
  }
  return '';
}

function endsWithTerminal(value: string): boolean {
  if (value.length === 0) return false;
  const last = value.charAt(value.length - 1);
  return last === '.' || last === '?' || last === '!';
}

export function providerStatusExplanation(status: number): string {
  switch (status) {
    case 400:
      return 'That means the provider rejected the request before drafting. Check the API key, selected model, API format, base URL, and whether this key can use that model.';
    case 401:
      return 'That means the key is missing, invalid, or not being sent correctly. Re-enter the API key and make sure it belongs to this provider.';
    case 403:
      return 'That means the key reached the provider but is not allowed to use this model or project. Check permissions, billing, and provider access.';
    case 404:
      return 'That usually means the model or endpoint was not found. Check the model name, API format, and base URL.';
    case 408:
      return 'That means the provider took too long to answer. Try again, or use a smaller or faster model.';
    case 409:
      return 'That means the provider reported a temporary conflict. Retry the draft in a moment.';
    case 422:
      return 'That means the provider could not accept part of the request. Check the model, response format, and request settings.';
    case 429:
      return 'That means too many requests or quota is exhausted. Wait a minute, reduce retries, or check the provider quota and billing.';
    case 500:
      return 'That means the provider hit an internal error. Retry in a moment or switch models.';
    case 502:
      return 'That means a gateway between Agentic and the provider failed. Retry in a moment.';
    case 503:
      return 'That means the provider is temporarily unavailable or overloaded. Wait a little and retry; the API key is usually not the problem.';
    case 504:
      return 'That means the provider timed out before finishing. Retry, or choose a faster model.';
    default:
      if (status >= 400 && status <= 499) {
        return 'That means the provider rejected the request. Check key permissions, model name, base URL, and provider settings.';
      }
      if (status >= 500 && status <= 599) {
        return 'That means the provider had a temporary server-side problem. Retry in a moment or switch models.';
      }
      return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
