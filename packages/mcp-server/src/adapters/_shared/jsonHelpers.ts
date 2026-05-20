/**
 * Shared JSON parsing helpers used by REST-style adapter clients
 * (Phoenix, Tensor, Magic Eden, …). Pure functions, no I/O.
 *
 * The signatures are deliberately tight: callers pass `unknown` from
 * `JSON.parse` and these helpers do the narrowing + extraction without
 * throwing. Anything adapter-specific (e.g. unwrapping known wrapper
 * fields, mapping rows to typed shapes) stays in the adapter file.
 */

/** Type guard for plain JSON object records. Arrays return `false`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip trailing slashes from a base URL so callers can safely append `/path`. */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Parse a possibly-empty, possibly-malformed response body.
 *  - empty / whitespace → `{}`
 *  - valid JSON → parsed value
 *  - invalid JSON → `{ message: text }` so error handlers can still surface the body text
 */
export function parseJson(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

/**
 * Extract a human-readable error string from an error-shaped JSON body.
 * Checks `message`, `error`, then `detail` in order; returns `undefined`
 * for non-records or when none of the keys hold a non-empty string.
 */
export function responseErrorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['message', 'error', 'detail']) {
    const item = value[key];
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Normalize a response into an array of record rows.
 *  - array input → records only
 *  - object input → unwrap the first matching `candidateKeys` entry that holds an array
 *  - object input with no matching key → `[value]` (single-record fallback)
 *  - anything else → `[]`
 *
 * Callers pass their adapter-specific key list (e.g. `['markets', 'positions', ...]`)
 * so behavior stays disjoint across adapters.
 */
export function extractRows(
  value: unknown,
  candidateKeys: readonly string[],
): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of candidateKeys) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return [value];
}

/**
 * Read a string-shaped field from a record. Returns the trimmed string
 * when present, the stringified number when the field holds a finite number,
 * or `undefined` otherwise (including for whitespace-only strings).
 */
export function optionalString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (trimmed) return trimmed;
  }
  if (typeof item === 'number' && Number.isFinite(item)) return String(item);
  return undefined;
}

/**
 * Read a number-shaped field from a record. Accepts finite numbers directly
 * and finite numeric strings (with whitespace tolerated). Returns `undefined`
 * for NaN/Infinity, non-numeric strings, missing keys, or non-records.
 */
export function optionalNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  if (typeof item === 'number' && Number.isFinite(item)) return item;
  if (typeof item === 'string' && item.trim()) {
    const parsed = Number(item);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
