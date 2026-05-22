import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, confirm, header, kv, badge, divider } from '../tui/index.js';

interface RecurringLite {
  id: string;
  status: string;
  walletAddress?: string;
  cluster?: string;
  token?: string;
  recipient?: string;
  amount?: string;
  cadence?: string;
  localTime?: string;
  nextDueAt?: string;
  occurrencesCreated?: number;
  maxOccurrences?: number;
  note?: string;
  createdAt?: string;
}

type Action = 'inspect' | 'pause' | 'resume' | 'delete' | 'back';

// `/repeat-manage` umbrella. Lists active + paused schedules, picks one,
// then offers Inspect / Pause / Resume / Delete. Used by:
// - bare `/repeat-manage`
// - `/inbox-repeat` row-picker fallback (when a user wants to act on a row)
export async function runScheduleManage(options: GlobalOptions): Promise<void> {
  while (true) {
    const list = await loadSchedules(options);
    console.log();
    console.log(header('Active repeats'));
    if (list.length === 0) {
      console.log(badge('No recurring schedules yet. Run /repeat to create one.', 'muted'));
      return;
    }
    const summary = `${list.filter((r) => r.status === 'active').length} active · ${list.filter((r) => r.status === 'paused').length} paused`;
    console.log(badge(summary, 'muted'));

    const choice = await select<string>({
      message: 'Pick a schedule',
      pageSize: Math.min(20, list.length + 1),
      choices: [
        ...list.map((r, i) => ({ name: rowLabel(i + 1, r), value: r.id, description: r.note ?? undefined })),
        { name: '← Back to main menu', value: '__back__' },
      ],
    });
    if (choice === '__back__') return;

    const schedule = list.find((r) => r.id === choice);
    if (!schedule) continue;

    const action = await pickAction(schedule);
    if (action === 'back') continue;
    if (action === 'inspect') {
      inspectSchedule(schedule);
      continue;
    }
    if (action === 'pause' || action === 'resume') {
      await mutateSchedule(options, action, schedule.id);
      continue;
    }
    if (action === 'delete') {
      const yes = await confirm({
        message: `Delete schedule ${schedule.id.slice(0, 12)}…? This stops all future runs.`,
        default: false,
      });
      if (yes) await mutateSchedule(options, 'delete', schedule.id);
      continue;
    }
  }
}

async function loadSchedules(options: GlobalOptions): Promise<RecurringLite[]> {
  try {
    const response = await bridgeRequest<{ recurringPayments?: RecurringLite[] }>(
      options,
      '/bridge/recurring-payments',
    );
    return Array.isArray(response.recurringPayments) ? response.recurringPayments : [];
  } catch (err) {
    console.log(badge(`Could not load schedules: ${err instanceof Error ? err.message : String(err)}`, 'err'));
    return [];
  }
}

function rowLabel(n: number, r: RecurringLite): string {
  const row = String(n).padStart(2, ' ');
  const status = r.status === 'active' ? badge('active', 'ok') : badge('paused', 'warn');
  const amount = r.amount && r.token ? `${r.amount} ${r.token}` : (r.amount ?? '?');
  const cadence = r.cadence ?? '?';
  const next = r.nextDueAt ? ` · next ${shortDate(r.nextDueAt)}` : '';
  return `${row}.  ${status}  ${amount}  ${cadence}${next}`;
}

async function pickAction(schedule: RecurringLite): Promise<Action> {
  const isActive = schedule.status === 'active';
  const choices: Array<{ name: string; value: Action }> = [
    { name: 'Inspect',                  value: 'inspect' },
    ...(isActive ? [{ name: 'Pause',  value: 'pause' as Action }] : [{ name: 'Resume', value: 'resume' as Action }]),
    { name: 'Delete (permanent)',       value: 'delete' },
    { name: '← Back to schedule list',  value: 'back' },
  ];
  return select<Action>({ message: 'What next?', choices });
}

function inspectSchedule(r: RecurringLite): void {
  console.log();
  console.log(header(`Schedule ${r.id}`));
  const rows: Array<[string, string]> = [];
  rows.push(['Status', r.status === 'active' ? badge('active', 'ok') : badge('paused', 'warn')]);
  if (r.amount && r.token) rows.push(['Amount', `${r.amount} ${r.token}`]);
  if (r.recipient) rows.push(['Recipient', r.recipient]);
  if (r.cadence) rows.push(['Cadence', r.cadence + (r.localTime ? ` @ ${r.localTime}` : '')]);
  if (r.nextDueAt) rows.push(['Next due', shortDate(r.nextDueAt)]);
  const occ = r.occurrencesCreated ?? 0;
  const max = r.maxOccurrences;
  rows.push(['Occurrences', max ? `${occ} / ${max}` : `${occ} (unlimited)`]);
  if (r.walletAddress) rows.push(['Wallet', r.walletAddress]);
  if (r.cluster) rows.push(['Network', r.cluster]);
  if (r.note) rows.push(['Note', r.note]);
  if (r.createdAt) rows.push(['Created', shortDate(r.createdAt)]);
  console.log(kv(rows));
  console.log(divider());
}

async function mutateSchedule(
  options: GlobalOptions,
  op: 'pause' | 'resume' | 'delete',
  recurringId: string,
): Promise<void> {
  try {
    await bridgeRequest(options, `/bridge/recurring-payments/${op}`, {
      method: 'POST',
      body: JSON.stringify({ recurringId }),
    });
    console.log(badge(`Schedule ${op}d.`, 'ok'));
  } catch (err) {
    console.log(badge(`Failed to ${op}: ${err instanceof Error ? err.message : String(err)}`, 'err'));
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
