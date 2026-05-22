import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, input, badge, header } from '../tui/index.js';
import { promptSendSplForm } from '../forms/sendSpl.js';
import { promptConnectorForm } from '../forms/connectorForm.js';
import { listRecurringConnectors, listActions, humanizeActionKind } from '../forms/connectorMeta.js';
import { maybeEnhanceWithAi } from '../forms/aiEnhance.js';
import { verdictBlocksQueue } from '../forms/policyBundleRender.js';
import { validatePositiveDecimal, validatePositiveInteger, validateClockTime } from '../forms/validators.js';
import { fetchWalletAddress, removeUndefined, printQueuedAction } from './_shared.js';
import { confirmHighStakes, estimateFromDraft } from './safetyGate.js';

export type RepeatSubcommand = 'scheduled' | 'recurring' | 'connector';

const CADENCE_CHOICES = [
  { name: 'Weekly',           value: 'weekly' },
  { name: 'Monthly',          value: 'monthly' },
  { name: 'Every N days',     value: 'interval_days' },
  { name: 'Every N hours',    value: 'interval_hours' },
  { name: 'Every N minutes',  value: 'interval_minutes' },
] as const;

const DAY_OF_WEEK_CHOICES = [
  { name: 'Sunday',    value: 0 },
  { name: 'Monday',    value: 1 },
  { name: 'Tuesday',   value: 2 },
  { name: 'Wednesday', value: 3 },
  { name: 'Thursday',  value: 4 },
  { name: 'Friday',    value: 5 },
  { name: 'Saturday',  value: 6 },
];

export async function runRepeatMenu(options: GlobalOptions): Promise<void> {
  const pick = await select<RepeatSubcommand>({
    message: 'What kind of repeat?',
    choices: [
      { name: 'Scheduled transfer (SOL/SPL on a cadence)', value: 'scheduled',  description: 'Weekly, monthly, or interval-based' },
      { name: 'Recurring swap / DCA (Jupiter)',            value: 'recurring',  description: 'Jupiter time-based recurring order' },
      { name: 'Recurring connector action',                value: 'connector',  description: 'Limited to connectors that support recurring' },
    ],
  });
  if (pick === 'scheduled') return runRepeatScheduled(options);
  if (pick === 'recurring') return runRepeatRecurring(options);
  return runRepeatConnector(options);
}

export async function runRepeatScheduled(options: GlobalOptions): Promise<void> {
  console.log(header('New scheduled transfer'));
  const draft = await promptSendSplForm(options);
  const cadence = await select<typeof CADENCE_CHOICES[number]['value']>({
    message: 'Cadence',
    choices: [...CADENCE_CHOICES],
  });
  const localTime = await input({
    message: 'Local time (HH:MM, 24h — blank to skip)',
    default: '09:00',
    validate: validateClockTime,
  });

  const body: Record<string, unknown> = removeUndefined({
    token: draft.token,
    recipient: draft.recipient,
    amount: draft.amount,
    cadence,
    note: draft.note,
    localTime: localTime.trim() || undefined,
  });

  if (cadence === 'weekly') {
    const dow = await select<number>({
      message: 'Day of week',
      choices: DAY_OF_WEEK_CHOICES,
    });
    body.dayOfWeek = dow;
  } else if (cadence === 'monthly') {
    const dom = await input({
      message: 'Day of month (1–31)',
      validate: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 31 || 'Must be 1–31.';
      },
    });
    body.dayOfMonth = Number(dom);
  } else if (cadence === 'interval_days') {
    const n = await input({ message: 'Every N days', validate: validatePositiveInteger });
    body.intervalDays = Number(n);
  } else if (cadence === 'interval_hours') {
    const n = await input({ message: 'Every N hours', validate: validatePositiveInteger });
    body.intervalHours = Number(n);
  } else if (cadence === 'interval_minutes') {
    const n = await input({ message: 'Every N minutes', validate: validatePositiveInteger });
    body.intervalMinutes = Number(n);
  }

  const maxOccRaw = await input({
    message: 'Max occurrences (blank = unlimited)',
    default: '',
    validate: (v) => !v.trim() || validatePositiveInteger(v),
  });
  if (maxOccRaw.trim()) body.maxOccurrences = Number(maxOccRaw);

  const summary = `Schedule ${draft.amount} ${draft.token} → ${draft.recipient} (${cadence})`;
  const enhanced = await maybeEnhanceWithAi(options, summary);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this schedule — not queueing.', 'err'));
    return;
  }
  const advice = enhanced?.advice ?? null;
  // Recurring transfers only run with per-occurrence approvals; we still gate
  // on high-risk AI advice and on a single-occurrence USD threshold so users
  // don't accidentally schedule mainnet flows above $50/run without confirming.
  const ok = await confirmHighStakes(options, summary, estimateFromDraft(draft), advice);
  if (!ok) {
    console.log(badge('Aborted.', 'muted'));
    return;
  }

  const result = await bridgeRequest(options, '/bridge/recurring-payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  printQueuedAction('Scheduled transfer', result);
}

export async function runRepeatRecurring(options: GlobalOptions): Promise<void> {
  console.log(header('Recurring swap / DCA (Jupiter)'));
  // Jupiter recurring uses the schema-driven connector form. The action kind is
  // jupiter_recurring_create_time_order — its required inputs are already in
  // the Jupiter spec.
  const draft = await promptConnectorForm('jupiter', 'jupiter_recurring_create_time_order', options);
  const enhanced = await maybeEnhanceWithAi(options, `Jupiter recurring: ${JSON.stringify(draft.params)}`);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this recurring order — not queueing.', 'err'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
  });
  const result = await bridgeRequest(options, '/bridge/connector/prepare-transaction', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  printQueuedAction(draft.summary, result);
}

export async function runRepeatConnector(options: GlobalOptions): Promise<void> {
  const recurringConnectors = listRecurringConnectors();
  if (recurringConnectors.length === 0) {
    console.log(badge('No connectors currently support recurring actions.', 'warn'));
    console.log(badge('Tip: /repeat-recurring for Jupiter DCA, or /repeat-scheduled for SOL/SPL.', 'muted'));
    return;
  }
  const connectorId = await select<string>({
    message: 'Which recurring-capable connector?',
    choices: recurringConnectors.map((c) => ({ name: c.name, value: c.id })),
  });
  const actions = listActions(connectorId).filter((a) => /recurring/i.test(a.actionKind));
  if (actions.length === 0) {
    console.log(badge(`No recurring actions found for ${connectorId}.`, 'warn'));
    return;
  }
  const actionKind = await select<string>({
    message: 'Which recurring action?',
    choices: actions.map((a) => ({
      name: humanizeActionKind(a.actionKind, connectorId),
      value: a.actionKind,
      description: a.summary?.slice(0, 80),
    })),
  });
  const draft = await promptConnectorForm(connectorId, actionKind, options);
  const enhanced = await maybeEnhanceWithAi(options, `${draft.summary} — ${JSON.stringify(draft.params)}`);
  if (verdictBlocksQueue(enhanced?.verdict)) {
    console.log(badge('AI denied this connector action — not queueing.', 'err'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
  });
  const result = await bridgeRequest(options, '/bridge/connector/prepare-transaction', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  printQueuedAction(draft.summary, result);
}
