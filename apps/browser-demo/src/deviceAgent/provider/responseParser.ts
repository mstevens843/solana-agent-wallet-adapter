// TypeScript port of ProviderResponseParser.kt. Mirrors the candidate order
// (direct → code fence → balanced-brace extraction), the string-escape-aware
// balanced-brace scanner, and the OpenAI/Anthropic extraction precedence.

import { PROVIDER_ERROR_CODES, ProviderHttpError } from './errorCodes.js';

const CODE_FENCE_JSON = /```(?:json)?\s*([\s\S]*?)```/gi;

export function extractOpenAiText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const outputText = payload.output_text;
  if (typeof outputText === 'string' && outputText.length > 0) return outputText;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!isRecord(first)) return '';
  const message = first.message;
  if (isRecord(message)) {
    const content = message.content;
    if (typeof content === 'string') return content;
  }
  const direct = first.text;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return '';
}

export function extractAnthropicText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const text = entry.text;
    if (typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join('\n');
}

/**
 * Extract URL citations from an Anthropic response. Citations live inside content[i].citations
 * (web_search tool annotations) as `{ url, title, cited_text? }`. Dedupes by url.
 */
export function extractAnthropicCitations(payload: unknown): Array<{ url: string; title?: string; citedText?: string }> {
  if (!isRecord(payload)) return [];
  const content = payload.content;
  if (!Array.isArray(content)) return [];
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string; citedText?: string }> = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const citations = entry.citations;
    if (!Array.isArray(citations)) continue;
    for (const c of citations) {
      if (!isRecord(c)) continue;
      const url = typeof c.url === 'string' ? c.url.trim() : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = typeof c.title === 'string' ? c.title : undefined;
      const citedText = typeof c.cited_text === 'string'
        ? c.cited_text
        : typeof (c as Record<string, unknown>).citedText === 'string'
          ? (c as Record<string, unknown>).citedText as string
          : undefined;
      out.push({ url, ...(title ? { title } : {}), ...(citedText ? { citedText } : {}) });
    }
  }
  return out;
}

export function parseModelJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new ProviderHttpError(
      PROVIDER_ERROR_CODES.INVALID_RESPONSE,
      'Provider response was empty.',
    );
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  candidates.push(trimmed);
  // matchAll manages its own iterator state — does NOT pollute the regex's
  // lastIndex like a manual exec() loop would. Equivalent observable behavior.
  for (const fenceMatch of trimmed.matchAll(CODE_FENCE_JSON)) {
    candidates.push((fenceMatch[1] ?? '').trim());
  }
  for (const candidate of balancedJsonObjectCandidates(trimmed)) {
    candidates.push(candidate);
  }

  for (const candidate of candidates) {
    if (candidate.length === 0 || !seen.add(candidate)) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try next
    }
  }
  throw new ProviderHttpError(
    PROVIDER_ERROR_CODES.INVALID_RESPONSE,
    'Provider response was not valid JSON.',
  );
}

function balancedJsonObjectCandidates(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          results.push(text.substring(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
