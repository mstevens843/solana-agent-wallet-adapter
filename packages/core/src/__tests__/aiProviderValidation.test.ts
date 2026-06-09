import { describe, expect, it } from 'vitest';

import {
  assertCustomOpenAiCompatibleBaseUrl,
  customOpenAiCompatibleBaseUrlError,
  isCustomOpenAiCompatibleProvider,
} from '../aiProviderValidation.js';

describe('custom OpenAI-compatible provider URL validation', () => {
  it('recognizes the custom provider case-insensitively', () => {
    expect(isCustomOpenAiCompatibleProvider('custom-openai-compatible')).toBe(true);
    expect(isCustomOpenAiCompatibleProvider(' CUSTOM-OPENAI-COMPATIBLE ')).toBe(true);
    expect(isCustomOpenAiCompatibleProvider('openrouter')).toBe(false);
  });

  it('allows generic HTTPS OpenAI-compatible gateways and Gemini OpenAI endpoints', () => {
    expect(customOpenAiCompatibleBaseUrlError('https://gateway.example/v1')).toBeNull();
    expect(customOpenAiCompatibleBaseUrlError('https://generativelanguage.googleapis.com/v1beta/openai')).toBeNull();
  });

  it('rejects known native provider URLs and invalid URLs', () => {
    expect(customOpenAiCompatibleBaseUrlError('')).toContain('required');
    expect(customOpenAiCompatibleBaseUrlError('gateway.example/v1')).toContain('valid https:// URL');
    expect(customOpenAiCompatibleBaseUrlError('http://gateway.example/v1')).toContain('https://');
    expect(customOpenAiCompatibleBaseUrlError('https://openrouter.ai/api/v1')).toContain('OpenRouter preset');
    expect(customOpenAiCompatibleBaseUrlError('https://api.anthropic.com/v1')).toContain('Claude / Anthropic preset');
    expect(customOpenAiCompatibleBaseUrlError('https://generativelanguage.googleapis.com/v1beta')).toContain('Gemini preset');
  });

  it('throws only for custom OpenAI-compatible provider settings', () => {
    expect(() => assertCustomOpenAiCompatibleBaseUrl('custom-openai-compatible', 'https://openrouter.ai/api/v1')).toThrow('OpenRouter preset');
    expect(() => assertCustomOpenAiCompatibleBaseUrl('openrouter', 'https://openrouter.ai/api/v1')).not.toThrow();
  });
});
