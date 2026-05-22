/**
 * MPP inbound list + session-pay.
 *
 * Endpoints (verified against apps/render-web/src/cloud/mppRoutes.ts):
 *   GET  /api/mpp/inbound                 — list pending inbound approvals
 *   POST /api/mpp/session-pay {approvalId, sessionId?}
 *
 * Server only consumes {approvalId, sessionId?}; amount/recipient are derived
 * from the approval the server already tracks, so don't expose them as flags.
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, removeUndefined } from '../shared/util.js';
import { mppRenderWebRequest } from '../http/index.js';

export async function dispatchMppExtra(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1];

  if (sub === 'inbound') {
    const op = parsed.positionals[2] ?? 'list';
    if (op === 'list') {
      return mppRenderWebRequest(parsed.options, '/api/mpp/inbound');
    }
    throw new Error(`Unknown mpp inbound subcommand: ${op}. Try: list`);
  }

  if (sub === 'pay') {
    const approvalId = parsed.positionals[2];
    if (!approvalId) {
      throw new Error('Usage: solana-agent-wallet mpp pay <approval-id> [--session-id <id>]');
    }
    const body = removeUndefined({
      approvalId,
      sessionId: optionValue(parsed.positionals, '--session-id'),
    });
    return mppRenderWebRequest(parsed.options, '/api/mpp/session-pay', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  throw new Error(`Unknown mpp subcommand: ${sub}. Try: config | challenge | inbound | pay`);
}
