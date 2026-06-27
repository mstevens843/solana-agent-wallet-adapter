import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, badge, header } from '../tui/index.js';

interface PreparedActionLite {
  id: string;
  kind: string;
  status: string;
  txStatus?: string;
  summary?: string;
  dueAt?: string;
  walletAddress?: string;
}

export type PickMode = 'inspect' | 'approve' | 'reject' | 'archive';

const MODE_LABELS: Record<PickMode, string> = {
  inspect: 'Inspect',
  approve: 'Approve',
  reject: 'Reject',
  archive: 'Archive',
};

const APPROVABLE = new Set(['ready', 'overdue']);
const REJECTABLE = new Set(['ready', 'overdue', 'scheduled', 'blocked', 'approval_pending']);

// Returns the action id, or undefined when the user cancels or has no actions
// available for the chosen mode. The caller passes this id straight to the
// existing approve / reject / inspect / archive handlers.
export async function pickPendingAction(options: GlobalOptions, mode: PickMode): Promise<string | undefined> {
  let actions: PreparedActionLite[] = [];
  try {
    const response = await bridgeRequest<{ actions?: PreparedActionLite[] }>(
      options,
      '/bridge/prepared-actions',
    );
    actions = Array.isArray(response.actions) ? response.actions : [];
  } catch (err) {
    console.log(badge(`Could not load inbox: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return undefined;
  }

  const filtered = actions.filter((a) => modeAccepts(mode, a));
  if (filtered.length === 0) {
    console.log(badge(`No actions available to ${mode}.`, 'muted'));
    return undefined;
  }

  console.log();
  console.log(header(`${MODE_LABELS[mode]} - pick an action`));

  return select<string>({
    message: `Which action?`,
    pageSize: Math.min(20, filtered.length + 1),
    choices: [
      ...filtered.map((a, i) => ({
        name: rowLabel(i + 1, a),
        value: a.id,
        description: a.summary?.slice(0, 80),
      })),
      { name: '← Cancel', value: '' },
    ],
  }).then((value) => (value ? value : undefined));
}

function modeAccepts(mode: PickMode, action: PreparedActionLite): boolean {
  if (action.txStatus === 'confirmed' || action.txStatus === 'failed') {
    return mode === 'inspect' || mode === 'archive';
  }
  if (mode === 'inspect') return true;
  if (mode === 'approve') return APPROVABLE.has(action.status);
  if (mode === 'reject') return REJECTABLE.has(action.status);
  if (mode === 'archive') return true;
  return false;
}

function rowLabel(n: number, a: PreparedActionLite): string {
  const row = String(n).padStart(2, ' ');
  const status = a.status === 'ready' ? badge('ready', 'ok')
    : a.status === 'overdue' ? badge('overdue', 'warn')
    : a.status === 'failed' ? badge('failed', 'err')
    : badge(a.status, 'muted');
  const summary = a.summary ? ` · ${a.summary.slice(0, 60)}` : '';
  return `${row}.  ${status}  ${a.kind}${summary}`;
}
