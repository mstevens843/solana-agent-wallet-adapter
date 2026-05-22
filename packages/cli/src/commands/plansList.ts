/**
 * `plans list` → GET /api/plans  (saved cloud plans)
 *
 * Distinct from `ai plan generate` (which creates a NEW draft) and from
 * `plan generate` (the bridge AI helper). This command surfaces the user's
 * stored plan history in the cloud workspace.
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchPlans(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub !== 'list') {
    throw new Error(`Unknown plans subcommand: ${sub}. Try: list`);
  }
  const params = new URLSearchParams();
  const limit = optionValue(parsed.positionals, '--limit');
  if (limit) {
    if (!/^\d+$/.test(limit)) throw new Error('--limit must be a positive integer.');
    params.set('limit', limit);
  }
  const q = params.toString();
  return renderWebRequest(parsed.options, `/api/plans${q ? `?${q}` : ''}`, undefined, {
    label: 'Render-web plans',
    requireAuth: true,
  });
}
