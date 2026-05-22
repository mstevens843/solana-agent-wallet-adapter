/**
 * Cloud-side approvals + finalization flow (advanced ops).
 *
 * The normal user surface is `inbox approve/reject/archive` against the local
 * bridge. The `approvals` group exposes the render-web cloud equivalents:
 *   GET  /api/approvals
 *   POST /api/approvals/:id/prepare-transaction
 *   POST /api/approvals/:id/wallet-execution
 *   POST /api/approvals/:id/finalization/prepare
 *   POST /api/approvals/:id/finalization/:fid/submit
 *   POST /api/approvals/:id/finalization/:fid/confirm
 *   POST /api/approvals/:id/finalization/:fid/fail
 *   GET  /api/approvals/:id/finalization
 *   POST /api/approvals/cleanup-recurring-backlog
 */
import type { ParsedArgs } from '../shared/types.js';
import { optionValue, readJsonFile, removeUndefined } from '../shared/util.js';
import { renderWebRequest } from '../http/index.js';

export async function dispatchApprovals(parsed: ParsedArgs): Promise<unknown> {
  const sub = parsed.positionals[1] ?? 'list';

  if (sub === 'list') {
    const params = new URLSearchParams();
    const limit = optionValue(parsed.positionals, '--limit');
    if (limit) params.set('limit', limit);
    const q = params.toString();
    return renderWebRequest(parsed.options, `/api/approvals${q ? `?${q}` : ''}`, undefined, {
      label: 'Render-web approvals',
      requireAuth: true,
    });
  }

  if (sub === 'prepare-tx' || sub === 'prepare-transaction') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: solana-agent-wallet approvals prepare-tx <approval-id> [--body <file.json>]');
    return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/prepare-transaction`);
  }

  if (sub === 'execute' || sub === 'wallet-execution') {
    const id = parsed.positionals[2];
    if (!id) throw new Error('Usage: solana-agent-wallet approvals execute <approval-id> [--body <file.json>]');
    return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/wallet-execution`);
  }

  if (sub === 'finalize') {
    const op = parsed.positionals[2];
    const id = parsed.positionals[3];
    const fid = parsed.positionals[4];
    if (op === 'prepare') {
      if (!id) throw new Error('Usage: solana-agent-wallet approvals finalize prepare <approval-id> [--body <file.json>]');
      return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/finalization/prepare`);
    }
    if (op === 'submit') {
      if (!id || !fid) throw new Error('Usage: solana-agent-wallet approvals finalize submit <approval-id> <finalization-id> [--body <file.json>]');
      return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/finalization/${encodeURIComponent(fid)}/submit`);
    }
    if (op === 'confirm') {
      if (!id || !fid) throw new Error('Usage: solana-agent-wallet approvals finalize confirm <approval-id> <finalization-id> [--body <file.json>]');
      return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/finalization/${encodeURIComponent(fid)}/confirm`);
    }
    if (op === 'fail') {
      if (!id || !fid) throw new Error('Usage: solana-agent-wallet approvals finalize fail <approval-id> <finalization-id> [--body <file.json>]');
      return postWithOptionalBody(parsed, `/api/approvals/${encodeURIComponent(id)}/finalization/${encodeURIComponent(fid)}/fail`);
    }
    if (op === 'status') {
      if (!id) throw new Error('Usage: solana-agent-wallet approvals finalize status <approval-id>');
      return renderWebRequest(parsed.options, `/api/approvals/${encodeURIComponent(id)}/finalization`, undefined, {
        label: 'Render-web approvals',
        requireAuth: true,
      });
    }
    throw new Error('Usage: solana-agent-wallet approvals finalize <prepare|submit|confirm|fail|status> ...');
  }

  if (sub === 'cleanup-recurring' || sub === 'cleanup-recurring-backlog') {
    return renderWebRequest(parsed.options, '/api/approvals/cleanup-recurring-backlog', {
      method: 'POST',
      body: '{}',
    }, { label: 'Render-web approvals', requireAuth: true });
  }

  throw new Error(`Unknown approvals subcommand: ${sub}. Try: list | prepare-tx | execute | finalize <op> | cleanup-recurring`);
}

async function postWithOptionalBody(parsed: ParsedArgs, path: string): Promise<unknown> {
  const file = optionValue(parsed.positionals, '--body');
  const body = file ? await readJsonFile(file, 'body') : {};
  return renderWebRequest(parsed.options, path, {
    method: 'POST',
    body: JSON.stringify(removeUndefined(body as Record<string, unknown>)),
  }, { label: 'Render-web approvals', requireAuth: true });
}
