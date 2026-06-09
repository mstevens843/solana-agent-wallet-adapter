// Shared OpenRouter attribution headers for every Device Agent provider that can route
// through OpenRouter (openai-compatible, Anthropic Messages, OpenAI Responses). OpenRouter
// expects HTTP-Referer + X-Title per
// https://openrouter.ai/docs/api-reference/overview#headers — without them requests are
// rate-limited more aggressively and excluded from the user's OpenRouter analytics. We only
// send them for OpenRouter so other gateways never see our origin.
const OPENROUTER_FALLBACK_REFERER = 'https://browser-device-agent.local';
export const OPENROUTER_X_TITLE = 'Agentic Browser Device Agent';

export function browserOriginForOpenRouter(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  const origin = loc?.origin?.trim();
  return origin && origin.length > 0 ? origin : OPENROUTER_FALLBACK_REFERER;
}

/**
 * Attribution headers every OpenRouter request must carry. Returns an empty object for
 * non-OpenRouter configs so callers can spread it unconditionally.
 */
export function openRouterAttributionHeaders(isOpenRouter: boolean): Record<string, string> {
  if (!isOpenRouter) return {};
  return {
    'HTTP-Referer': browserOriginForOpenRouter(),
    'X-Title': OPENROUTER_X_TITLE,
  };
}
