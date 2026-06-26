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

// Genuine OpenAI / OpenRouter support the `stream_options` field; arbitrary
// OpenAI-compatible gateways (Ollama, some LiteLLM) 400 on it. Used to gate it.
export function supportsStreamOptions(profile: ChatModelProfile): boolean {
  return profile.provider.trim().toLowerCase() === 'openai' || isOpenRouterProfile(profile);
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

const ANTHROPIC_VERSION = '2023-06-01';

// True in a browser/Tauri WebView (where CORS applies), false on the Node server. The
// native Android/iOS runtimes build their request headers in Kotlin/Swift and never
// reach this code, so this only ever distinguishes "browser" from "server".
function isBrowserRuntime(): boolean {
  const g = globalThis as { window?: { document?: unknown } };
  return typeof g.window !== 'undefined' && typeof g.window.document !== 'undefined';
}

export function bearerJsonHeaders(apiKey: string, openRouter: boolean): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    // `X-OpenRouter-Metadata` is undocumented and NOT on OpenRouter's browser CORS
    // allowlist, so a browser preflight rejects it (surfacing as a bare "Failed to
    // fetch"). Send it only off the browser (server) where there is no preflight.
    ...(openRouter && !isBrowserRuntime() ? { 'X-OpenRouter-Metadata': 'enabled' } : {}),
  };
}

export function anthropicHeaders(apiKey: string, openRouter: boolean): Record<string, string> {
  if (openRouter) {
    // OpenRouter's Anthropic skin speaks the native Messages API, so it still requires
    // the `anthropic-version` header even though auth is the OpenRouter bearer key.
    return { ...bearerJsonHeaders(apiKey, true), 'anthropic-version': ANTHROPIC_VERSION };
  }
  return {
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
    'x-api-key': apiKey,
    // A direct browser→api.anthropic.com call is CORS-gated behind this opt-in header
    // (Session + browser/Tauri Device Agent). Harmless on the server; native sets its own.
    ...(isBrowserRuntime() ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
  };
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
  if (Array.isArray(err) && typeof err[0] === 'string') return err[0];
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // OpenAI/Anthropic { error: { message } }; some gateways nest { error: { error: { message } } }.
    if (typeof e.message === 'string') return e.message;
    const nested = e.error && typeof e.error === 'object' ? (e.error as Record<string, unknown>).message : undefined;
    if (typeof nested === 'string') return nested;
    if (typeof e.code === 'string') return e.code;
  }
  if (typeof record.message === 'string') return record.message;
  if (typeof record.detail === 'string') return record.detail;
  if (typeof record.error_description === 'string') return record.error_description; // OAuth-style gateways
  return '';
}

export function providerFailureMessage(payload: unknown, status: number): string {
  const message = extractProviderError(payload) || `AI provider returned HTTP ${status}.`;
  return `AI provider error (${status}). ${message}`.slice(0, 400);
}
