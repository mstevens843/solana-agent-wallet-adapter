/**
 * `completed list [--limit N] [--since ISO]` → GET /api/completed
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchCompleted(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub !== 'list') {
    throw new Error(`Unknown completed subcommand: ${sub}. Try: list`);
  }
  const params = new URLSearchParams();
  const limit = optionValue(parsed.positionals, '--limit');
  if (limit) {
    if (!/^\d+$/.test(limit)) throw new Error('--limit must be a positive integer.');
    params.set('limit', limit);
  }
  const since = optionValue(parsed.positionals, '--since');
  if (since) params.set('since', since);
  const q = params.toString();
  return renderWebRequest(parsed.options, `/api/completed${q ? `?${q}` : ''}`, undefined, {
    label: 'Render-web completed',
    requireAuth: true,
  });
}
