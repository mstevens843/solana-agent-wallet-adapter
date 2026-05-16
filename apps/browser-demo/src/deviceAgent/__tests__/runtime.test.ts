import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_API_FORMATS,
  canonicalApiFormat,
  redactedSummary,
  validateRuntimeConfig,
  type RuntimeConfig,
} from '../runtime/config.js';
import {
  ProviderFailedError,
  ProviderUnavailableError,
  RUNTIME_CONFIG_SUBCODES,
  RUNTIME_ERROR_CODES,
} from '../runtime/errors.js';
import { RUNTIME_METHODS, isRuntimeMethodWire } from '../runtime/request.js';
import { RUNTIME_STATES, isRuntimeStateWire } from '../runtime/state.js';

const validConfig: RuntimeConfig = {
  provider: 'openai',
  apiFormat: 'openai-compatible',
  model: 'gpt-4.1-mini',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  walletAddress: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
};

describe('runtime state', () => {
  it('lists the four wire values', () => {
    expect(RUNTIME_STATES).toEqual(['stopped', 'starting', 'running', 'error']);
  });

  it('recognizes valid state wires', () => {
    expect(isRuntimeStateWire('running')).toBe(true);
    expect(isRuntimeStateWire('error')).toBe(true);
    expect(isRuntimeStateWire('paused')).toBe(false);
    expect(isRuntimeStateWire(undefined)).toBe(false);
    expect(isRuntimeStateWire(42)).toBe(false);
  });
});

describe('runtime errors', () => {
  it('reuses workflow error codes for the canonical wire strings', () => {
    expect(RUNTIME_ERROR_CODES.RUNTIME_BUSY).toBe('runtime_busy');
    expect(RUNTIME_ERROR_CODES.RUNTIME_CANCELED).toBe('runtime_canceled');
    expect(RUNTIME_ERROR_CODES.RUNTIME_INTERNAL).toBe('runtime_internal');
    expect(RUNTIME_ERROR_CODES.RUNTIME_NOT_RUNNING).toBe('runtime_not_running');
    expect(RUNTIME_ERROR_CODES.PROVIDER_UNAVAILABLE).toBe('provider_unavailable');
    expect(RUNTIME_ERROR_CODES.PROVIDER_FAILED).toBe('provider_failed');
    expect(RUNTIME_ERROR_CODES.INVALID_CONFIG).toBe('invalid_config');
  });

  it('exposes the four config validation subcodes', () => {
    expect(RUNTIME_CONFIG_SUBCODES).toEqual({
      MISSING_PROVIDER: 'missing_provider',
      MISSING_MODEL: 'missing_model',
      MISSING_API_KEY: 'missing_api_key',
      UNSUPPORTED_FORMAT: 'unsupported_format',
    });
  });

  it('wraps RuntimeError in ProviderUnavailableError', () => {
    const inner = { code: 'provider_unavailable', message: 'down' };
    const err = new ProviderUnavailableError(inner);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProviderUnavailableError');
    expect(err.message).toBe('down');
    expect(err.error).toBe(inner);
  });

  it('wraps RuntimeError in ProviderFailedError', () => {
    const inner = { code: 'provider_auth', subcode: 'unauthorized', message: 'bad key' };
    const err = new ProviderFailedError(inner);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProviderFailedError');
    expect(err.message).toBe('bad key');
    expect(err.error).toEqual(inner);
  });
});

describe('runtime config', () => {
  it('exposes the supported API formats', () => {
    expect(SUPPORTED_API_FORMATS.has('openai-compatible')).toBe(true);
    expect(SUPPORTED_API_FORMATS.has('anthropic')).toBe(true);
    expect(SUPPORTED_API_FORMATS.size).toBe(2);
  });

  it('canonicalizes the legacy openai alias', () => {
    expect(canonicalApiFormat('openai')).toBe('openai-compatible');
    expect(canonicalApiFormat('  openai  ')).toBe('openai-compatible');
    expect(canonicalApiFormat('openai-compatible')).toBe('openai-compatible');
    expect(canonicalApiFormat('anthropic')).toBe('anthropic');
    expect(canonicalApiFormat('  anthropic  ')).toBe('anthropic');
    expect(canonicalApiFormat('')).toBe('');
  });

  it('returns null when the config is valid', () => {
    expect(validateRuntimeConfig(validConfig)).toBeNull();
  });

  it('reports a missing provider for null or blank input', () => {
    expect(validateRuntimeConfig(null)).toMatchObject({
      code: 'invalid_config',
      subcode: 'missing_provider',
    });
    expect(validateRuntimeConfig(undefined)).toMatchObject({
      code: 'invalid_config',
      subcode: 'missing_provider',
    });
    expect(validateRuntimeConfig({ ...validConfig, provider: '   ' })).toMatchObject({
      subcode: 'missing_provider',
    });
  });

  it('reports an unsupported apiFormat', () => {
    expect(validateRuntimeConfig({ ...validConfig, apiFormat: 'gemini' })).toMatchObject({
      code: 'invalid_config',
      subcode: 'unsupported_format',
    });
    expect(validateRuntimeConfig({ ...validConfig, apiFormat: '' })).toMatchObject({
      subcode: 'unsupported_format',
    });
  });

  it('reports a missing model', () => {
    expect(validateRuntimeConfig({ ...validConfig, model: '' })).toMatchObject({
      subcode: 'missing_model',
    });
    expect(validateRuntimeConfig({ ...validConfig, model: '   ' })).toMatchObject({
      subcode: 'missing_model',
    });
  });

  it('reports a missing apiKey', () => {
    const noKey: RuntimeConfig = {
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4.1-mini',
    };
    expect(validateRuntimeConfig(noKey)).toMatchObject({
      subcode: 'missing_api_key',
    });
    expect(validateRuntimeConfig({ ...validConfig, apiKey: '   ' })).toMatchObject({
      subcode: 'missing_api_key',
    });
  });

  it('redacts the apiKey from the summary', () => {
    const summary = redactedSummary(validConfig);
    expect(summary).not.toHaveProperty('apiKey');
    expect(summary).toMatchObject({
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
      hasKey: true,
      walletShort: '4fTq',
    });
  });

  it('redactedSummary reports hasKey false when apiKey is missing', () => {
    const summary = redactedSummary({
      provider: 'openai',
      apiFormat: 'openai-compatible',
      model: 'gpt-4.1-mini',
    });
    expect(summary).not.toHaveProperty('apiKey');
    expect(summary.hasKey).toBe(false);
    expect(summary.baseUrl).toBe('');
    expect(summary.walletShort).toBeUndefined();
  });
});

describe('runtime request', () => {
  it('lists the three method wires', () => {
    expect(RUNTIME_METHODS).toEqual(['generatePlan', 'reviewPlan', 'ask']);
  });

  it('recognizes valid method wires', () => {
    expect(isRuntimeMethodWire('generatePlan')).toBe(true);
    expect(isRuntimeMethodWire('reviewPlan')).toBe(true);
    expect(isRuntimeMethodWire('ask')).toBe(true);
    expect(isRuntimeMethodWire('status')).toBe(false);
    expect(isRuntimeMethodWire(null)).toBe(false);
  });
});
