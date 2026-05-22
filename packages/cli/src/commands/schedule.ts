/**
 * `schedule create` — POST /bridge/recurring-payments (new in v1.0).
 * `schedule occurrences <id>` — GET /api/recurring/:id/occurrences
 * `schedule notifications <id>` — GET /api/recurring/:id/notifications
 * `schedule rotate-notifications <id>` — POST /api/recurring/:id/notifications/rotate
 *
 * The legacy list/pause/resume/delete subcommands stay in index.ts for
 * backwards compatibility; this module owns the v1.0 additions.
 */
import type { ParsedArgs } from '../shared/types.js';
import { commandValues, optionValue, removeUndefined, assertPositiveDecimal } from '../shared/util.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';

const VALUE_FLAGS = new Set([
  '--token',
  '--recipient',
  '--amount',
  '--cadence',
  '--day-of-week',
  '--day-of-month',
  '--interval-days',
  '--interval-hours',
  '--interval-minutes',
  '--local-time',
  '--start-at',
  '--max-occurrences',
  '--note',
]);

export async function dispatchScheduleCreate(parsed: ParsedArgs): Promise<unknown> {
  // Allow either positional `token recipient amount cadence` or flag-based.
  const rawArgs = commandValues(parsed.positionals.slice(2), VALUE_FLAGS);
  const token = optionValue(parsed.positionals, '--token') ?? rawArgs[0];
  const recipient = optionValue(parsed.positionals, '--recipient') ?? rawArgs[1];
  const amount = optionValue(parsed.positionals, '--amount') ?? rawArgs[2];
  const cadence = optionValue(parsed.positionals, '--cadence') ?? rawArgs[3];
  if (!token || !recipient || !amount || !cadence) {
    throw new Error(
      'Usage: solana-agent-wallet schedule create <token> <recipient> <amount> <cadence> [options]\n' +
      '  --cadence weekly|monthly|interval_days|interval_hours|interval_minutes\n' +
      '  --day-of-week 0..6  --day-of-month 1..31\n' +
      '  --interval-days|--interval-hours|--interval-minutes <n>\n' +
      '  --local-time HH:MM  --start-at <ISO8601>  --max-occurrences <n>  --note <text>',
    );
  }
  assertPositiveDecimal(amount, 'amount');
  const dayOfWeek = numericFlag(parsed.positionals, '--day-of-week');
  const dayOfMonth = numericFlag(parsed.positionals, '--day-of-month');
  const intervalDays = numericFlag(parsed.positionals, '--interval-days');
  const intervalHours = numericFlag(parsed.positionals, '--interval-hours');
  const intervalMinutes = numericFlag(parsed.positionals, '--interval-minutes');
  const maxOccurrences = numericFlag(parsed.positionals, '--max-occurrences');
  const body = removeUndefined({
    token,
    recipient,
    amount,
    cadence,
    dayOfWeek,
    dayOfMonth,
    intervalDays,
    intervalHours,
    intervalMinutes,
    localTime: optionValue(parsed.positionals, '--local-time'),
    startAt: optionValue(parsed.positionals, '--start-at'),
    maxOccurrences,
    note: optionValue(parsed.positionals, '--note'),
  });
  return bridgeRequest(parsed.options, '/bridge/recurring-payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function numericFlag(positionals: string[], flag: string): number | undefined {
  const raw = optionValue(positionals, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a number; got "${raw}"`);
  }
  return parsed;
}

/**
 * Cloud-side recurring metadata. Distinct from the bridge `recurring-payments`
 * endpoints handled by dispatchSchedule (list/pause/resume/delete/create).
 */
export async function dispatchScheduleOccurrences(parsed: ParsedArgs): Promise<unknown> {
  // Positionals: ['schedule', 'occurrences', <id>]
  const id = parsed.positionals[2];
  if (!id) throw new Error('Usage: solana-agent-wallet schedule occurrences <recurring-id>');
  return renderWebRequest(parsed.options, `/api/recurring/${encodeURIComponent(id)}/occurrences`, undefined, {
    label: 'Render-web recurring',
    requireAuth: true,
  });
}

export async function dispatchScheduleNotifications(parsed: ParsedArgs): Promise<unknown> {
  // Positionals: ['schedule', 'notifications', <id>]
  const id = parsed.positionals[2];
  if (!id) throw new Error('Usage: solana-agent-wallet schedule notifications <recurring-id>');
  return renderWebRequest(parsed.options, `/api/recurring/${encodeURIComponent(id)}/notifications`, undefined, {
    label: 'Render-web recurring',
    requireAuth: true,
  });
}

export async function dispatchScheduleRotateNotifications(parsed: ParsedArgs): Promise<unknown> {
  // Positionals: ['schedule', 'rotate-notifications', <id>]
  const id = parsed.positionals[2];
  if (!id) throw new Error('Usage: solana-agent-wallet schedule rotate-notifications <recurring-id>');
  return renderWebRequest(parsed.options, `/api/recurring/${encodeURIComponent(id)}/notifications/rotate`, {
    method: 'POST',
    body: '{}',
  }, { label: 'Render-web recurring', requireAuth: true });
}
