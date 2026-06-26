// Shared pure helpers for connector-atom format() projections (no deps, browser-safe).
// Used by jupiter.ts and amm.ts so every projection coerces/compacts identically.

import { DEFAULT_CONNECTOR_FACT_MAX_CHARS } from './types.js';

export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}
export function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
// Lamports (string or number) -> SOL, rounded to 4dp. Undefined when not numeric.
export function solFromLamports(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return undefined;
  return Math.round((raw / 1e9) * 1e4) / 1e4;
}
export function shortMint(mint?: string): string | undefined {
  if (!mint) return undefined;
  return mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : mint;
}
// Drop undefined/null keys so the serialized block stays small.
export function compact(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}
// Final safety net: if a projection is still oversized, return a clamped preview rather
// than a huge blob the model would truncate mid-structure anyway.
export function clampConnectorFacts(value: Record<string, unknown>, maxChars = DEFAULT_CONNECTOR_FACT_MAX_CHARS): Record<string, unknown> {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  return { note: 'facts truncated for size; ask a narrower question', preview: json.slice(0, maxChars) };
}
// Strip the verbose connector capability view; keep everything else. Used by the
// defensive formatters whose nested shapes are less stable.
export function stripConnector(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'connector') continue;
    out[key] = value;
  }
  return out;
}
