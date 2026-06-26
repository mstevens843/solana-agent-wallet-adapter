// Transport resolution + URL/header builders for the chat loop. The API key is a
// parameter (supplied by the injected completion transport), never stored here.

import type { ChatAiTransport, ChatModelProfile } from './types.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_OPENAI_COMPAT_SUFFIX = /\/openai\/?$/i;
const GEMINI_VERSION_SEGMENT = /\/v\d+(beta)?(\/|$)/i;

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

export function isOpenRouterProfile(profile: ChatModelProfile): boolean {
  return profile.provider.trim().toLowerCase() === 'openrouter' || /(^|\.)openrouter\.ai$/i.test(safeHost(profile.baseUrl));
}

// Pick the tool-calling transport. Note: for the CHAT loop, OpenAI's "responses"
// preset and any OpenAI-compatible gateway both use /chat/completions, so they
// collapse to 'openai-compatible'. Gemini keeps its native transport but DOES get a
// tool loop here (the adapter sends functionDeclarations) — fixing the old
// single-shot fallback.
export function resolveChatTransport(profile: ChatModelProfile): ChatAiTransport {
  if ((profile.engine ?? '').trim().toLowerCase() === 'connector') return 'cli-agent';
  const provider = profile.provider.trim().toLowerCase();
  const model = profile.model.trim().toLowerCase();
  if (provider === 'openrouter') {
    if (model.startsWith('anthropic/')) return 'anthropic-messages';
    return 'openai-compatible';
  }
  if (provider === 'gemini') return 'gemini-native';
  if (provider === 'openai') return 'openai-compatible';
  if (profile.apiFormat.trim().toLowerCase() === 'anthropic') return 'anthropic-messages';
  return 'openai-compatible';
}

function normalizeBaseUrl(baseUrl: string, format: 'anthropic' | 'openai-compatible'): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return format === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  if (format === 'anthropic') {
    return /\/v\d+(\/|$)/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  if (/\/v\d+(beta)?(\/|$)/i.test(trimmed) || /\/openai$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function normalizeGeminiNativeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, '');
  if (!trimmed) return DEFAULT_GEMINI_NATIVE_BASE_URL;
  const stripped = trimmed.replace(GEMINI_OPENAI_COMPAT_SUFFIX, '');
  if (GEMINI_VERSION_SEGMENT.test(stripped)) return stripped;
  return `${stripped}/v1beta`;
}

export function openAiChatCompletionsUrl(profile: ChatModelProfile): string {
  return `${normalizeBaseUrl(profile.baseUrl, 'openai-compatible')}/chat/completions`;
}

export function anthropicMessagesUrl(profile: ChatModelProfile): string {
  const format = isOpenRouterProfile(profile) ? 'openai-compatible' : 'anthropic';
  return `${normalizeBaseUrl(profile.baseUrl, format)}/messages`;
}

export function geminiStreamGenerateContentUrl(profile: ChatModelProfile): string {
  const base = normalizeGeminiNativeBaseUrl(profile.baseUrl);
  const model = encodeURIComponent(profile.model.trim());
  const path = /\/models\/[^/]+$/i.test(base) ? base : `${base}/models/${model}`;
  return `${path.replace(/:streamGenerateContent$|:generateContent$/i, '')}:streamGenerateContent?alt=sse`;
}

export function bearerJsonHeaders(apiKey: string, openRouter: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...(openRouter ? { 'X-OpenRouter-Metadata': 'enabled' } : {}),
  };
}

export function anthropicHeaders(apiKey: string, openRouter: boolean): Record<string, string> {
  if (openRouter) return bearerJsonHeaders(apiKey, true);
  return { 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-api-key': apiKey };
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-goog-api-key': apiKey };
}

// OpenRouter attribution headers (https://openrouter.ai/docs#headers). Only emitted
// when the values are present, so it's a no-op for non-OpenRouter or when the caller
// has no origin/title to declare.
export function openRouterAttributionHeaders(referer?: string, title?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (referer) out['HTTP-Referer'] = referer;
  if (title) out['X-Title'] = title;
  return out;
}

function extractProviderError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const err = record.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  if (typeof record.message === 'string') return record.message;
  if (typeof record.detail === 'string') return record.detail;
  return '';
}

export function providerFailureMessage(payload: unknown, status: number): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  return `AI provider error (${status}). ${message}`.slice(0, 400);
}
