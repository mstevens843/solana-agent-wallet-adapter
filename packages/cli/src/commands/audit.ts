/**
 * Audit trail viewer.
 *
 * Endpoints (verified against apps/render-web/src/cloud/router.ts:944 +
 * handleListAuditEvents):
 *   GET /api/audit?recordType=&recordId=&limit=
 *
 * Server supports filters: `recordType`, `recordId`, `limit`. There is no
 * `since` filter and no `/api/audit/export` endpoint — `audit tail` returns
 * JSON the user can pipe through `jq` for local filtering.
 *
 * `--follow` polls the endpoint every `--poll-interval-ms` (default 2000) and
 * prints only newly-seen events (deduped by id). Ctrl+C exits cleanly.
 */
import process from 'node:process';

import type { GlobalOptions, ParsedArgs } from '../shared/types.js';
import { NO_OUTPUT } from '../shared/types.js';
import { optionValue, stableJson, sleep } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

interface AuditResponse {
  events?: Array<{ id?: string; createdAt?: string; [k: string]: unknown }>;
}

export async function dispatchAudit(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'tail';
  if (sub === 'tail' || sub === 'list') {
    if (parsed.positionals.includes('--follow') || parsed.positionals.includes('-f')) {
      await runAuditFollow(parsed);
      return NO_OUTPUT;
    }
    return fetchAudit(parsed.options, buildAuditQuery(parsed));
  }
  throw new Error(`Unknown audit subcommand: ${sub}. Try: tail [--limit N] [--record-type T] [--record-id ID] [--follow]`);
}

function buildAuditQuery(parsed: ParsedArgs): string {
  const params = new URLSearchParams();
  const limit = optionValue(parsed.positionals, '--limit');
  if (limit) {
    if (!/^\d+$/.test(limit)) throw new Error('--limit must be a positive integer.');
    params.set('limit', limit);
  }
  const recordType = optionValue(parsed.positionals, '--record-type')
    ?? optionValue(parsed.positionals, '--type');
  if (recordType) params.set('recordType', recordType);
  const recordId = optionValue(parsed.positionals, '--record-id');
  if (recordId) params.set('recordId', recordId);
  const q = params.toString();
  return q ? `?${q}` : '';
}

async function fetchAudit(options: GlobalOptions, query: string): Promise<AuditResponse> {
  return renderWebRequest<AuditResponse>(options, `/api/audit${query}`, undefined, {
    label: 'Render-web audit',
    requireAuth: true,
  });
}

async function runAuditFollow(parsed: ParsedArgs): Promise<void> {
  const pollIntervalRaw = optionValue(parsed.positionals, '--poll-interval-ms');
  const pollIntervalMs = pollIntervalRaw ? Number(pollIntervalRaw) : 2000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 500) {
    throw new Error('--poll-interval-ms must be a number ≥ 500.');
  }
  const baseQuery = buildAuditQuery(parsed);
  const seen = new Set<string>();
  let aborted = false;
  const onSigint = () => {
    aborted = true;
  };
  process.once('SIGINT', onSigint);
  // Prime the seen set with the existing tail so --follow only prints NEW.
  try {
    const first = await fetchAudit(parsed.options, baseQuery);
    for (const ev of first.events ?? []) {
      if (ev.id) seen.add(ev.id);
    }
  } catch (err) {
    process.removeListener('SIGINT', onSigint);
    throw err;
  }
  if (!parsed.options.json) {
    console.error(`Following audit (poll ${pollIntervalMs}ms). Ctrl+C to exit.`);
  }
  while (!aborted) {
    await sleep(pollIntervalMs);
    if (aborted) break;
    try {
      const next = await fetchAudit(parsed.options, baseQuery);
      const newEvents = (next.events ?? []).filter((ev) => ev.id && !seen.has(ev.id));
      for (const ev of newEvents) {
        if (ev.id) seen.add(ev.id);
        console.log(parsed.options.json ? stableJson(ev) : formatAuditLine(ev));
      }
    } catch (err) {
      // Transient — print to stderr and keep going.
      console.error(`audit follow: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.removeListener('SIGINT', onSigint);
}

function formatAuditLine(ev: { createdAt?: string; recordType?: unknown; recordId?: unknown; [k: string]: unknown }): string {
  const ts = typeof ev.createdAt === 'string' ? ev.createdAt : '';
  const type = typeof ev.recordType === 'string' ? ev.recordType : String(ev.type ?? '');
  const id = typeof ev.recordId === 'string' ? ev.recordId : '';
  return `${ts}  ${type}  ${id}`.trim();
}
