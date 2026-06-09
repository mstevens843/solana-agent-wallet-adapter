import type { AgentPlan } from '@solana-agent-wallet-adapter/workflow';

import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest } from '../http/index.js';
import { select, input, badge, header } from '../tui/index.js';
import { promptSendTokensForm, type SendTokensDraft } from '../forms/sendTokens.js';
import { promptConnectorForm } from '../forms/connectorForm.js';
import { listRecurringConnectors, listActions, humanizeActionKind } from '../forms/connectorMeta.js';
import { composeNoteWithReview, maybeReviewWithAgent, reviewPreparedTransactionWithAgent, type AgentReviewOutcome } from '../forms/agentReview.js';
import { validatePositiveDecimal, validatePositiveInteger, validateClockTime } from '../forms/validators.js';
import { fetchWalletAddress, removeUndefined, printQueuedAction } from './_shared.js';
import { confirmHighStakes, estimateFromDraft } from './safetyGate.js';
import { connectorSecretsForRequest, enabledConnectorIds, loadConnectorState } from './connectorState.js';
import { runConnectorsMenu } from './connectors.js';
import { preparedActionFromPrepareResult } from './newApproval.js';

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
      { name: 'Connectors',                                value: 'connector',  description: 'Use a connected protocol with recurring actions' },
    ],
  });
  if (pick === 'scheduled') return runRepeatScheduled(options);
  if (pick === 'recurring') return runRepeatRecurring(options);
  return runRepeatConnector(options);
}

export interface ScheduledTransferPrefill extends Partial<SendTokensDraft> {
  cadence?: typeof CADENCE_CHOICES[number]['value'];
  localTime?: string;
}

export async function runRepeatScheduled(options: GlobalOptions): Promise<void> {
  return runRepeatScheduledWithPrefill(options);
}

export async function runRepeatScheduledWithPrefill(
  options: GlobalOptions,
  prefill: ScheduledTransferPrefill = {},
): Promise<void> {
  console.log(header('New scheduled transfer'));
  const draft = await promptSendTokensForm(options, prefill, { defaultToken: prefill.token ?? 'USDC' });
  const cadence = await select<typeof CADENCE_CHOICES[number]['value']>({
    message: 'Cadence',
    ...(prefill.cadence ? { default: prefill.cadence } : {}),
    choices: [...CADENCE_CHOICES],
  });
  const localTime = await input({
    message: 'Local time (HH:MM, 24h — blank to skip)',
    default: prefill.localTime ?? '09:00',
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
  const plan = buildScheduledTransferAgentPlan(draft, cadence, body);
  const review = await maybeReviewRepeatWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }
  body.note = noteForRepeatReview(draft.note, review);
  // Recurring transfers only run with per-occurrence approvals; still gate on
  // a single-occurrence USD threshold so users don't accidentally schedule
  // mainnet flows above $50/run without confirming.
  const ok = await confirmHighStakes(options, summary, estimateFromDraft(draft), null);
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

async function maybeReviewRepeatWithAgent(
  options: GlobalOptions,
  plan: AgentPlan,
): Promise<AgentReviewOutcome> {
  return maybeReviewWithAgent(options, plan, {
    enabledPrompt: 'Review with AI before creating this repeat?',
    instructionPrompt: 'Anything to ask or check? (ex: only create if SOL > $80, no outages, or token is verified)',
    nextStepLabels: {
      sendDefault: 'Create repeat now',
      sendDenied: 'Create repeat anyway (overrides agent denial)',
      sendNeedsInput: 'Create repeat anyway (overrides agent needs-input)',
      sendDescription: 'Creates the repeat setup or queues the recurring connector action.',
      save: 'Save/create without sending now',
      saveDescription: 'Keeps the repeat setup queued; approve occurrence transactions later.',
      delete: 'Delete repeat plan',
      deleteDescription: 'Stops this repeat setup. Nothing is queued.',
    },
  });
}

function buildScheduledTransferAgentPlan(
  draft: SendTokensDraft,
  cadence: typeof CADENCE_CHOICES[number]['value'],
  body: Record<string, unknown>,
): AgentPlan {
  return {
    source: 'template',
    category: 'recurring',
    actionType: 'recurring_payment',
    templateTitle: 'Scheduled transfer',
    intent: `Schedule ${draft.amount} ${draft.token} to ${draft.recipient}`,
    route: `${draft.token} -> ${draft.recipient}, ${cadence}`,
    risk: 'Medium',
    approval: 'Per-occurrence wallet approval required before signing',
    parameters: stringifyParams(body),
    fields: [
      { label: 'Token', value: draft.token },
      { label: 'Recipient', value: draft.recipient },
      { label: 'Amount', value: draft.amount },
      { label: 'Cadence', value: cadence },
    ],
    safeguards: ['Each occurrence requires wallet approval before signing.'],
    userNotes: draft.note ?? '',
  };
}

function buildConnectorRepeatAgentPlan(
  connectorId: string,
  actionKind: string,
  draft: { summary: string; params: Record<string, unknown>; reason?: string; note?: string },
): AgentPlan {
  const parameters = stringifyParams(draft.params);
  return {
    source: 'template',
    category: 'recurring',
    actionType: actionKind,
    templateTitle: draft.summary || `${connectorId}: ${actionKind}`,
    intent: draft.summary || `${connectorId}: ${actionKind}`,
    route: `${connectorId} -> ${actionKind}`,
    risk: 'Medium',
    approval: 'Wallet approval required before signing prepared occurrences',
    parameters,
    fields: Object.entries(parameters).map(([label, value]) => ({ label: humanizeParamLabel(label), value })),
    safeguards: ['Wallet approval is required before signing any prepared occurrence.'],
    userNotes: [draft.reason, draft.note].filter((part): part is string => Boolean(part?.trim())).join('\n'),
  };
}

function stringifyParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;
    out[key] = typeof raw === 'string'
      ? raw
      : typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : JSON.stringify(raw);
  }
  return out;
}

function noteForRepeatReview(baseNote: string | undefined, review: AgentReviewOutcome): string | undefined {
  if (!review.reviewed) return baseNote?.trim() || undefined;
  const decision = review.decision ?? '';
  const isOverride = review.choice !== 'delete' && (decision === 'deny' || decision === 'needs_input');
  const overrideLine = isOverride
    ? `Override: ${decision === 'deny' ? 'agent denied' : 'agent needed input'}`
    : undefined;
  return composeNoteWithReview(baseNote, review.reviewSummary, overrideLine);
}

function humanizeParamLabel(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function runRepeatRecurring(options: GlobalOptions): Promise<void> {
  console.log(header('Recurring swap / DCA (Jupiter)'));
  // Jupiter recurring uses the schema-driven connector form. The action kind is
  // jupiter_recurring_create_time_order — its required inputs are already in
  // the Jupiter spec.
  const draft = await promptConnectorForm('jupiter', 'jupiter_recurring_create_time_order', options);
  const plan = buildConnectorRepeatAgentPlan('jupiter', draft.actionKind, draft);
  const review = await maybeReviewRepeatWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const connectorSecrets = connectorSecretsForRequest('jupiter');
  const note = noteForRepeatReview(draft.note, review);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
    reason: draft.reason,
    note,
    connectorSecrets,
  });
  const result = await bridgeRequest(options, '/bridge/connector/prepare-action', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (await maybeReviewRepeatPreparedTransaction(options, plan, review, result) === 'deleted') return;
  printQueuedAction(draft.summary, result);
}

export async function runRepeatConnector(options: GlobalOptions): Promise<void> {
  const connectedIds = enabledConnectorIds(await loadConnectorState(options));
  const recurringConnectors = listRecurringConnectors().filter((connector) => connectedIds.has(connector.id));
  if (recurringConnectors.length === 0) {
    console.log(badge('No connected connectors currently support recurring actions.', 'warn'));
    const setup = await select<'connectors' | 'back'>({
      message: 'What next?',
      choices: [
        { name: 'Open /connectors', value: 'connectors' },
        { name: '← Back', value: 'back' },
      ],
    });
    if (setup === 'connectors') await runConnectorsMenu(options);
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
  const plan = buildConnectorRepeatAgentPlan(connectorId, actionKind, draft);
  const review = await maybeReviewRepeatWithAgent(options, plan);
  if (review.choice === 'delete') {
    console.log(badge('Discarded.', 'muted'));
    return;
  }

  const { address, cluster } = await fetchWalletAddress(options);
  const connectorSecrets = connectorSecretsForRequest(connectorId);
  const note = noteForRepeatReview(draft.note, review);
  const body = removeUndefined({
    kind: draft.actionKind,
    params: draft.params,
    walletAddress: address,
    cluster,
    summary: draft.summary,
    reason: draft.reason,
    note,
    connectorSecrets,
  });
  const result = await bridgeRequest(options, '/bridge/connector/prepare-action', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (await maybeReviewRepeatPreparedTransaction(options, plan, review, result) === 'deleted') return;
  printQueuedAction(draft.summary, result);
}

async function maybeReviewRepeatPreparedTransaction(
  options: GlobalOptions,
  plan: AgentPlan,
  review: AgentReviewOutcome,
  result: unknown,
): Promise<'ok' | 'deleted'> {
  if (!review.needsPreparedTxReview) return 'ok';
  const action = preparedActionFromPrepareResult(result);
  const transactionBase64 = typeof action?.params?.transactionBase64 === 'string'
    ? action.params.transactionBase64
    : undefined;
  if (!transactionBase64) return 'ok';
  const txReview = await reviewPreparedTransactionWithAgent(options, plan, review, transactionBase64);
  if (txReview?.choice !== 'delete' || !action?.id) return 'ok';
  await bridgeRequest(options, '/bridge/prepared-actions/delete', {
    method: 'POST',
    body: JSON.stringify({ actionId: action.id }),
  });
  console.log(badge('Deleted saved plan after transaction review.', 'muted'));
  return 'deleted';
}
