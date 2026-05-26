import type { GlobalOptions } from '../shared/types.js';
import { bridgeRequest, renderWebRequest } from '../http/index.js';
import { header, kv, badge, divider } from '../tui/index.js';
import { countEnabledConnectors } from './connectorState.js';

interface PreparedActionLike {
  id?: string;
  status?: string;
  recurringId?: string;
  recurringScheduleId?: string;
}

interface RecurringLike {
  id?: string;
  status?: string;
}

interface CompletedLike {
  id?: string;
  actionId?: string;
}

interface ArtifactLike {
  id?: string;
}

interface PreferencesResponse {
  payload?: unknown;
}

export interface WorkspaceSummary {
  oneTime: number;
  repeats: number;
  inbox: number;
  connectors: number;
  done: number;
  cloudAvailable: boolean;
  localAvailable: boolean;
}

// Keep the workspace summary snappy in the REPL. Any single upstream that
// takes longer than this is treated as "unavailable" so /inbox and /sign-in
// never freeze the prompt waiting on a slow endpoint.
const SUMMARY_CALL_TIMEOUT_MS = 4_000;

export async function loadWorkspaceSummary(options: GlobalOptions): Promise<WorkspaceSummary> {
  const [
    localActions,
    localRepeats,
    localReceipts,
    localArtifacts,
    cloudApprovals,
    cloudRepeats,
    cloudCompleted,
    cloudConnectors,
  ] = await Promise.all([
    safeWithTimeout(bridgeRequest<{ actions?: PreparedActionLike[] }>(options, '/bridge/prepared-actions')),
    safeWithTimeout(bridgeRequest<{ recurringPayments?: RecurringLike[] }>(options, '/bridge/recurring-payments')),
    safeWithTimeout(bridgeRequest<{ receipts?: CompletedLike[] }>(options, '/bridge/receipts')),
    safeWithTimeout(bridgeRequest<{ artifacts?: ArtifactLike[] }>(options, '/bridge/lab-artifacts')),
    safeWithTimeout(renderWebRequest<{ approvals?: PreparedActionLike[] }>(options, '/api/approvals', undefined, {
      label: 'Render-web approvals',
      requireAuth: true,
    })),
    safeWithTimeout(renderWebRequest<{ schedules?: RecurringLike[]; recurringPayments?: RecurringLike[] }>(options, '/api/recurring', undefined, {
      label: 'Render-web recurring',
      requireAuth: true,
    })),
    safeWithTimeout(renderWebRequest<{ completed?: CompletedLike[]; items?: CompletedLike[] }>(options, '/api/completed', undefined, {
      label: 'Render-web completed',
      requireAuth: true,
    })),
    safeWithTimeout(renderWebRequest<PreferencesResponse | Record<string, unknown>>(options, '/api/preferences/protocol-connectors', undefined, {
      label: 'Render-web preferences',
      requireAuth: true,
    })),
  ]);

  const pendingActionIds = new Set<string>();
  let oneTime = 0;
  let repeatsFromApprovals = 0;
  for (const action of [
    ...(localActions?.actions ?? []),
    ...(cloudApprovals?.approvals ?? []),
  ]) {
    if (!isPendingAction(action)) continue;
    const id = action.id ?? `pending_${pendingActionIds.size}`;
    if (pendingActionIds.has(id)) continue;
    pendingActionIds.add(id);
    if (action.recurringId || action.recurringScheduleId) repeatsFromApprovals += 1;
    else oneTime += 1;
  }

  const repeatIds = new Set<string>();
  for (const schedule of [
    ...(localRepeats?.recurringPayments ?? []),
    ...(cloudRepeats?.schedules ?? []),
    ...(cloudRepeats?.recurringPayments ?? []),
  ]) {
    if (!isActiveRepeat(schedule)) continue;
    const id = schedule.id ?? `repeat_${repeatIds.size}`;
    repeatIds.add(id);
  }
  const repeats = repeatIds.size + repeatsFromApprovals;

  const doneIds = new Set<string>();
  for (const row of [
    ...(localReceipts?.receipts ?? []),
    ...(localArtifacts?.artifacts ?? []),
    ...(cloudCompleted?.completed ?? []),
    ...(cloudCompleted?.items ?? []),
  ]) {
    const maybeActionId = 'actionId' in row && typeof row.actionId === 'string' ? row.actionId : undefined;
    const id = typeof row.id === 'string' ? row.id : maybeActionId;
    if (id) doneIds.add(id);
  }

  const cloudAvailable = Boolean(cloudApprovals || cloudRepeats || cloudCompleted || cloudConnectors);
  const localAvailable = Boolean(localActions || localRepeats || localReceipts || localArtifacts);
  const connectors = countEnabledConnectors(cloudConnectors);

  return {
    oneTime,
    repeats,
    inbox: oneTime + repeats,
    connectors,
    done: doneIds.size,
    cloudAvailable,
    localAvailable,
  };
}

export function renderWorkspaceSummary(summary: WorkspaceSummary): void {
  console.log();
  console.log(header('Workspace'));
  console.log(kv([
    ['Inbox', `${summary.inbox}`],
    ['One-time', `${summary.oneTime}`],
    ['Repeats', `${summary.repeats}`],
    ['Connectors', `${summary.connectors}`],
    ['Done', `${summary.done}`],
  ]));
  console.log(divider());
  const source = summary.cloudAvailable
    ? 'Cloud Storage synced'
    : summary.localAvailable
      ? 'Local workspace loaded; cloud stats unavailable'
      : 'Workspace stats unavailable';
  console.log(badge(source, summary.cloudAvailable ? 'ok' : 'warn'));
}

function isPendingAction(action: PreparedActionLike): boolean {
  return action.status === 'ready' || action.status === 'overdue' || action.status === 'blocked' || action.status === 'approval_pending';
}

function isActiveRepeat(schedule: RecurringLike): boolean {
  return schedule.status === 'active';
}

async function safeWithTimeout<T>(promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | null>([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SUMMARY_CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
