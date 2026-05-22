/**
 * `evidence list [--connector <id>] [--limit N]` → GET /api/evidence
 *
 * Evidence records are the facts agents collected when drafting plans (e.g.
 * "Kamino reserve APY at 7.2% as of <ts>"). They're what `plan review` is
 * scored against on the server side.
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchEvidence(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub !== 'list') {
    throw new Error(`Unknown evidence subcommand: ${sub}. Try: list`);
  }
  const params = new URLSearchParams();
  const connector = optionValue(parsed.positionals, '--connector');
  if (connector) params.set('connector', connector);
  const limit = optionValue(parsed.positionals, '--limit');
  if (limit) {
    if (!/^\d+$/.test(limit)) throw new Error('--limit must be a positive integer.');
    params.set('limit', limit);
  }
  const q = params.toString();
  return renderWebRequest(parsed.options, `/api/evidence${q ? `?${q}` : ''}`, undefined, {
    label: 'Render-web evidence',
    requireAuth: true,
  });
}
