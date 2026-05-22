/**
 * Spend envelopes (verified against apps/render-web/src/cloud/spendRoutes.ts).
 *
 *   GET /api/spend/envelopes  — list current envelopes for the signed-in wallet
 *
 * The server has no `POST /api/spend/envelopes` endpoint — envelopes are
 * derived from approvals + recurring schedules + streaming sessions. To create
 * spend limits, configure them via the wallet host UI under Settings → Spend
 * Limits, which writes to the appropriate underlying namespace. The CLI
 * exposes a read-only view here.
 */
import type { ParsedArgs } from '../shared/types.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchSpendLimits(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';
  if (sub === 'list' || sub === 'get') {
    return renderWebRequest(parsed.options, '/api/spend/envelopes', undefined, {
      label: 'Render-web spend envelopes',
      requireAuth: true,
    });
  }
  if (sub === 'set' || sub === 'create') {
    throw new Error(
      'spend-limits is read-only from the CLI. Configure spend limits via the wallet host UI (Settings → Spend Limits); the server derives /api/spend/envelopes from the underlying recurring / approval / streaming state.',
    );
  }
  throw new Error(`Unknown spend-limits subcommand: ${sub}. Try: list`);
}
