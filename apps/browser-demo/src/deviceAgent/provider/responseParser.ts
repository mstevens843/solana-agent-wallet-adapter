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

// True when a chat/completions response stopped because it hit the token ceiling
// (`choices[0].finish_reason === 'length'`). For reasoning models this is the signature of
// reasoning consuming the whole budget before any answer text was emitted.
export function chatCompletionTruncated(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const first = choices[0];
  if (!isRecord(first)) return false;
  return first.finish_reason === 'length';
}

// True when a Responses API payload was cut off by the output-token ceiling
// (`status === 'incomplete'` with `incomplete_details.reason === 'max_output_tokens'`).
// Mirrors the server's check in aiPlanner.ts (record.status === 'incomplete').
export function responsesApiTruncated(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.status !== 'incomplete') return false;
  const details = payload.incomplete_details;
  if (!isRecord(details)) return true;
  return details.reason === 'max_output_tokens' || details.reason === undefined;
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

/**
 * Extract text from an OpenAI Responses API payload (POST /v1/responses).
 *
 * Shape: `{ output_text?: string, output: [{ type: 'message', content: [{ type: 'output_text', text: string }] }, ...] }`.
 * Prefers the convenience `output_text` field when present, otherwise walks `output[].content[].text`.
 */
export function extractResponsesApiText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const direct = payload.output_text;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const output = payload.output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const entry of output) {
    if (!isRecord(entry)) continue;
    const content = entry.content;
    if (!Array.isArray(content)) continue;
    for (const piece of content) {
      if (!isRecord(piece)) continue;
      const text = piece.text;
      if (typeof text === 'string' && text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Extract URL citations from an OpenAI Responses API payload. Citations live in two places:
 *   - `output[i].content[j].annotations[k]` with `type: 'url_citation'` and `{ url, title? }`
 *   - `web_search_call.action.sources[k]` with `{ url, title? }` when `include: ['web_search_call.action.sources']` is set
 * Walks the payload tree to depth 10 (matches server-side extractor), dedupes by url, caps at 8.
 */
export function extractResponsesApiCitations(
  payload: unknown,
): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];

  function walk(value: unknown, depth: number): void {
    if (out.length >= 8 || depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const type = typeof value.type === 'string' ? value.type : '';
    const looksLikeCitation =
      type.toLowerCase().includes('citation') ||
      type.toLowerCase().includes('web_search') ||
      typeof value.url === 'string';
    if (looksLikeCitation && typeof value.url === 'string') {
      const url = value.url.trim();
      if (url.length > 0 && !seen.has(url)) {
        seen.add(url);
        const title = typeof value.title === 'string' ? value.title : undefined;
        out.push({ url, ...(title ? { title } : {}) });
      }
    }
    for (const key of Object.keys(value)) {
      walk(value[key], depth + 1);
      if (out.length >= 8) return;
    }
  }

  walk(payload, 0);
  return out;
}

/**
 * Extract text from a Gemini native API payload (POST :generateContent).
 *
 * Shape: `{ candidates: [{ content: { parts: [{ text: string }, ...] }, finishReason?: string }] }`.
 * Joins all text parts of the first candidate with newlines. Tolerates
 * `finishReason: 'MAX_TOKENS'` by returning whatever was produced.
 */
export function extractGeminiText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0];
  if (!isRecord(first)) return '';
  const content = first.content;
  if (!isRecord(content)) return '';
  const parts = content.parts;
  if (!Array.isArray(parts)) return '';
  const out: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const text = part.text;
    if (typeof text === 'string' && text.length > 0) out.push(text);
  }
  return out.join('\n');
}

/**
 * Extract URL citations from a Gemini native API payload.
 *
 * Shape: `candidates[0].groundingMetadata.groundingChunks[].web.{ uri, title }`.
 * Dedupes by uri, caps at 8.
 */
export function extractGeminiCitations(
  payload: unknown,
): Array<{ url: string; title?: string }> {
  if (!isRecord(payload)) return [];
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const first = candidates[0];
  if (!isRecord(first)) return [];
  const grounding = first.groundingMetadata;
  if (!isRecord(grounding)) return [];
  const chunks = grounding.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];
  for (const chunk of chunks) {
    if (out.length >= 8) break;
    if (!isRecord(chunk)) continue;
    const web = chunk.web;
    if (!isRecord(web)) continue;
    const uri = typeof web.uri === 'string' ? web.uri.trim() : '';
    if (uri.length === 0 || seen.has(uri)) continue;
    seen.add(uri);
    const title = typeof web.title === 'string' ? web.title : undefined;
    out.push({ url: uri, ...(title ? { title } : {}) });
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
