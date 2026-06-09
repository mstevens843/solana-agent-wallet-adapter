export function isCustomOpenAiCompatibleProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === 'custom-openai-compatible';
}

export function assertCustomOpenAiCompatibleBaseUrl(provider: string, baseUrl: string | null | undefined): void {
  if (!isCustomOpenAiCompatibleProvider(provider)) return;
  const message = customOpenAiCompatibleBaseUrlError(baseUrl);
  if (message) throw new Error(message);
}

export function customOpenAiCompatibleBaseUrlError(baseUrl: string | null | undefined): string | null {
  const trimmed = (baseUrl ?? '').trim();
  if (!trimmed) {
    return 'Custom OpenAI-compatible gateway URL is required.';
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Custom OpenAI-compatible gateway URL must be a valid https:// URL.';
  }
  if (url.protocol !== 'https:') {
    return 'Custom OpenAI-compatible gateway URL must use https://.';
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    return 'Use the OpenRouter preset for deterministic agent review routing; do not enter openrouter.ai under Custom OpenAI-compatible.';
  }
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return 'Use the Claude / Anthropic preset for Anthropic URLs; Custom OpenAI-compatible expects an endpoint that implements OpenAI-compatible chat completions.';
  }
  if ((host === 'generativelanguage.googleapis.com' || host.endsWith('.generativelanguage.googleapis.com')) && !/(^|\/)openai(\/|$)/i.test(path)) {
    return 'Use the Gemini preset for native Gemini URLs; Custom OpenAI-compatible expects an OpenAI-compatible /openai endpoint.';
  }
  return null;
}
