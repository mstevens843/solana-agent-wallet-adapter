// Ported from
// apps/android-twa/app/src/test/java/com/agentic/wallet/agent/provider/ProviderHttpTest.kt.
// Pins URL normalization, HTTP status mapping, the gpt-5 / o-series temperature
// detection, the API-key header guard, and composeErrorMessage punctuation logic.

import { describe, expect, it } from 'vitest';

import { ProviderHttpError } from '../provider/errorCodes.js';
import {
  assertApiKeyHeaderSafe,
  composeErrorMessage,
  isDefaultTemperatureOnlyModel,
  mapHttpStatusToErrorCode,
  normalizeBaseUrl,
} from '../provider/providerHttp.js';

describe('mapHttpStatusToErrorCode', () => {
  it('maps statuses to provider_* codes', () => {
    expect(mapHttpStatusToErrorCode(200)).toBeNull();
    expect(mapHttpStatusToErrorCode(204)).toBeNull();
    expect(mapHttpStatusToErrorCode(401)).toBe('provider_auth');
    expect(mapHttpStatusToErrorCode(403)).toBe('provider_auth');
    expect(mapHttpStatusToErrorCode(429)).toBe('provider_rate_limited');
    expect(mapHttpStatusToErrorCode(408)).toBe('provider_timeout');
    expect(mapHttpStatusToErrorCode(504)).toBe('provider_timeout');
    expect(mapHttpStatusToErrorCode(500)).toBe('provider_upstream');
    expect(mapHttpStatusToErrorCode(503)).toBe('provider_upstream');
    expect(mapHttpStatusToErrorCode(418)).toBe('provider_invalid_response');
  });
});

describe('normalizeBaseUrl — openai-compatible', () => {
  it('appends /v1 to bare host', () => {
    expect(normalizeBaseUrl('https://api.openai.com', 'openai-compatible')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('strips trailing slash and appends /v1', () => {
    expect(normalizeBaseUrl('https://api.openai.com/', 'openai-compatible')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('leaves an already-versioned URL alone', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1', 'openai-compatible')).toBe(
      'https://api.openai.com/v1',
    );
  });

  it('leaves the Gemini /v1beta/openai suffix alone', () => {
    expect(
      normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'openai-compatible'),
    ).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
  });

  it('falls back to the OpenAI preset for blank / null / undefined input', () => {
    expect(normalizeBaseUrl('', 'openai-compatible')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl(null, 'openai-compatible')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl(undefined, 'openai-compatible')).toBe('https://api.openai.com/v1');
  });
});

describe('normalizeBaseUrl — anthropic', () => {
  it('appends /v1 to bare host', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com', 'anthropic')).toBe('https://api.anthropic.com/v1');
  });

  it('strips trailing slash and appends /v1', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com/v1');
  });

  it('leaves a /v2 (non-v1) version alone', () => {
    expect(normalizeBaseUrl('https://api.anthropic.com/v2', 'anthropic')).toBe('https://api.anthropic.com/v2');
  });

  it('falls back to the Anthropic preset for blank input', () => {
    expect(normalizeBaseUrl('', 'anthropic')).toBe('https://api.anthropic.com/v1');
  });
});

describe('isDefaultTemperatureOnlyModel', () => {
  it('returns true for gpt-5 family', () => {
    expect(isDefaultTemperatureOnlyModel('gpt-5')).toBe(true);
    expect(isDefaultTemperatureOnlyModel('gpt-5-turbo')).toBe(true);
    expect(isDefaultTemperatureOnlyModel('provider/gpt-5')).toBe(true);
  });

  it('returns true for o-series', () => {
    expect(isDefaultTemperatureOnlyModel('o1-preview')).toBe(true);
    expect(isDefaultTemperatureOnlyModel('o3-mini')).toBe(true);
    expect(isDefaultTemperatureOnlyModel('provider/o1')).toBe(true);
    expect(isDefaultTemperatureOnlyModel('provider/o4-mini')).toBe(true);
  });

  it('returns false for ordinary models and blank input', () => {
    expect(isDefaultTemperatureOnlyModel('gpt-4o')).toBe(false);
    expect(isDefaultTemperatureOnlyModel('claude-opus-4-5')).toBe(false);
    expect(isDefaultTemperatureOnlyModel('gemini-1.5-pro')).toBe(false);
    expect(isDefaultTemperatureOnlyModel('')).toBe(false);
  });
});

describe('assertApiKeyHeaderSafe', () => {
  it('accepts ASCII printable keys', () => {
    expect(() => assertApiKeyHeaderSafe('sk-ABCDEF1234567890')).not.toThrow();
    expect(() => assertApiKeyHeaderSafe('xoxp-1234567890abcdef')).not.toThrow();
  });

  it('rejects keys with a control character', () => {
    let captured: unknown = null;
    try {
      assertApiKeyHeaderSafe('sk-\nABCDEF');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_config');
  });

  it('rejects keys with a non-ASCII character', () => {
    let captured: unknown = null;
    try {
      assertApiKeyHeaderSafe('sk-ABCéDEF');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    expect((captured as ProviderHttpError).code).toBe('provider_invalid_config');
  });

  it('rejects an empty key with an "empty" message', () => {
    let captured: unknown = null;
    try {
      assertApiKeyHeaderSafe('');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ProviderHttpError);
    const err = captured as ProviderHttpError;
    expect(err.code).toBe('provider_invalid_config');
    expect(err.message.toLowerCase().includes('empty')).toBe(true);
  });
});

describe('composeErrorMessage', () => {
  it('formats {error:{message}} JSON with appended explanation', () => {
    const composed = composeErrorMessage(401, '{"error":{"message":"key invalid"}}');
    expect(composed.startsWith('key invalid.')).toBe(true);
    expect(composed.includes('belongs to this provider')).toBe(true);
  });

  it('accepts a raw string in the error field', () => {
    const composed = composeErrorMessage(429, '{"error":"limit reached"}');
    expect(composed.includes('limit reached')).toBe(true);
    expect(composed.includes('too many requests')).toBe(true);
  });

  it('falls back to "AI provider returned HTTP <status>." when body is blank', () => {
    const composed = composeErrorMessage(503, '');
    expect(composed.startsWith('AI provider returned HTTP 503.')).toBe(true);
    expect(composed.includes('temporarily unavailable')).toBe(true);
  });

  it('omits the explanation for status with no entry (200)', () => {
    expect(composeErrorMessage(200, '{"error":{"message":"weird"}}')).toBe('weird');
  });

  it('avoids double periods when the base message ends with a period', () => {
    const composed = composeErrorMessage(429, '{"error":{"message":"already a sentence."}}');
    expect(composed.includes('..')).toBe(false);
  });

  it('inserts ". " when the base message lacks terminal punctuation', () => {
    const composed = composeErrorMessage(500, '{"error":{"message":"backend exploded"}}');
    expect(composed.startsWith('backend exploded. ')).toBe(true);
  });

  it('handles malformed body by falling back to the HTTP status message', () => {
    const composed = composeErrorMessage(500, 'not even json');
    expect(composed.startsWith('AI provider returned HTTP 500.')).toBe(true);
  });
});
