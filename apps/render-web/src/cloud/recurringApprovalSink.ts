import type {
  ApprovalSink,
  JsonObject,
  ApprovalStatusReader,
  RecurringOccurrenceApprovalSummary,
  RecurringOccurrenceCompletedSummary,
  RecurringOccurrenceHistoryHydrator,
  RecurringOccurrenceRecord,
  RecurringScheduleRecord,
} from './recurringService.js';
import type { WorkflowService, WorkflowStore } from './workflowService.js';

export function createRecurringApprovalStatusReader(
  workflowStore: WorkflowStore,
): ApprovalStatusReader {
  return async (walletAddress, approvalId) => {
    try {
      const approval = await workflowStore.getApproval(walletAddress, approvalId);
      return approval ? { status: approval.status } : undefined;
    } catch {
      return undefined;
    }
  };
}

export function createRecurringApprovalSink(workflowService: WorkflowService): ApprovalSink {
  return async ({ walletAddress, schedule, occurrence }) => {
    const isSwap = schedule.actionKind === 'swap' || Boolean(schedule.outputToken);
    const inputToken = schedule.inputToken || schedule.token;
    const outputToken = schedule.outputToken || 'USDC';
    const isSol = schedule.token.toUpperCase() === 'SOL';
    const summary = isSwap
      ? `${schedule.amount} ${inputToken} recurring swap to ${outputToken}`
      : `${schedule.amount} ${schedule.token} recurring approval`;
    const approval = await workflowService.createApproval(
      { walletAddress },
      {
        kind: isSwap ? 'swap' : isSol ? 'transfer_sol' : 'transfer_spl',
        summary,
        params: isSwap
          ? {
              recurringScheduleId: schedule.id,
              recurringOccurrenceId: occurrence.id,
              occurrenceKey: occurrence.occurrenceKey,
              inputToken,
              outputToken,
              amount: schedule.amount,
              slippageBps: String(schedule.slippageBps ?? 50),
              ...(schedule.memo ? { memo: schedule.memo } : {}),
            }
          : {
              recurringScheduleId: schedule.id,
              recurringOccurrenceId: occurrence.id,
              occurrenceKey: occurrence.occurrenceKey,
              recipient: schedule.recipient,
              ...(isSol ? { amountSol: schedule.amount } : { token: schedule.token, amount: schedule.amount }),
              ...(schedule.memo ? { memo: schedule.memo } : {}),
            },
        cluster: schedule.cluster,
        dueAt: occurrence.dueAt,
        amount: schedule.amount,
        token: inputToken,
        ...(isSwap ? {} : { recipient: schedule.recipient }),
        recurringScheduleId: schedule.id,
        recurringOccurrenceId: occurrence.id,
        occurrenceKey: occurrence.occurrenceKey,
        metadata: recurringApprovalMetadata(schedule, occurrence, isSwap ? 'swap' : 'transfer'),
        ...(schedule.note ? { note: schedule.note } : {}),
      },
    );
    return { approvalId: approval.id };
  };
}

export function createRecurringOccurrenceHistoryHydrator(
  workflowStore: WorkflowStore,
): RecurringOccurrenceHistoryHydrator {
  return async (walletAddress, occurrences) => {
    const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
    const approvalIds = new Set(
      occurrences
        .map((occurrence) => occurrence.approvalRequestId)
        .filter((id): id is string => Boolean(id)),
    );
    const completedIds = new Set(
      occurrences
        .map((occurrence) => occurrence.completedRecordId)
        .filter((id): id is string => Boolean(id)),
    );
    const [approvalsById, approvalsByOccurrence, completedById, completedByOccurrence] = await Promise.all([
      workflowStore.listApprovalsByIds
        ? workflowStore.listApprovalsByIds(walletAddress, [...approvalIds])
        : workflowStore.listApprovals(walletAddress),
      workflowStore.listApprovalsByRecurringOccurrenceIds
        ? workflowStore.listApprovalsByRecurringOccurrenceIds(walletAddress, [...occurrenceIds])
        : Promise.resolve([]),
      workflowStore.listCompletedByIds
        ? workflowStore.listCompletedByIds(walletAddress, [...completedIds])
        : workflowStore.listCompleted(walletAddress),
      workflowStore.listCompletedByRecurringOccurrenceIds
        ? workflowStore.listCompletedByRecurringOccurrenceIds(walletAddress, [...occurrenceIds])
        : Promise.resolve([]),
    ]);
    const approvals = uniqueById([...approvalsById, ...approvalsByOccurrence]);
    const completedRecords = uniqueById([...completedById, ...completedByOccurrence]);
    const hydration = new Map<string, {
      occurrenceId: string;
      approval?: RecurringOccurrenceApprovalSummary;
      completed?: RecurringOccurrenceCompletedSummary;
    }>();

    for (const approval of approvals) {
      const occurrenceId = approval.recurringOccurrenceId;
      if (!occurrenceId || !occurrenceIds.has(occurrenceId)) {
        if (!approvalIds.has(approval.id)) continue;
      }
      const id = occurrenceId ?? occurrences.find((entry) => entry.approvalRequestId === approval.id)?.id;
      if (!id) continue;
      const existing = hydration.get(id) ?? { occurrenceId: id };
      existing.approval = {
        id: approval.id,
        status: approval.status,
        ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
        ...(approval.txid ? { txid: approval.txid } : {}),
        ...(approval.txStatus ? { txStatus: approval.txStatus } : {}),
        ...(approval.explorerUrl ? { explorerUrl: approval.explorerUrl } : {}),
      };
      hydration.set(id, existing);
    }

    for (const completed of completedRecords) {
      const occurrenceId = completed.recurringOccurrenceId;
      if (!occurrenceId || !occurrenceIds.has(occurrenceId)) {
        if (!completedIds.has(completed.id)) continue;
      }
      const id = occurrenceId ?? occurrences.find((entry) => entry.completedRecordId === completed.id)?.id;
      if (!id) continue;
      const existing = hydration.get(id) ?? { occurrenceId: id };
      existing.completed = {
        id: completed.id,
        status: completed.status,
        completedAt: completed.completedAt,
        ...(completed.txid ? { txid: completed.txid } : {}),
        ...(completed.explorerUrl ? { explorerUrl: completed.explorerUrl } : {}),
      };
      hydration.set(id, existing);
    }

    return [...hydration.values()];
  };
}

function uniqueById<T extends { id: string }>(records: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    unique.push(record);
  }
  return unique;
}

function recurringApprovalMetadata(
  schedule: RecurringScheduleRecord,
  occurrence: RecurringOccurrenceRecord,
  actionKind: 'swap' | 'transfer',
): JsonObject {
  const metadata = schedule.metadata;
  return {
    recurringScheduleId: schedule.id,
    recurringOccurrenceId: occurrence.id,
    occurrenceKey: occurrence.occurrenceKey,
    actionKind,
    ...(stringValue(metadata?.connectorId) ? { connectorId: stringValue(metadata?.connectorId) } : {}),
    ...(stringValue(metadata?.connectorName) ? { connectorName: stringValue(metadata?.connectorName) } : {}),
    ...(stringValue(metadata?.operation) ? { operation: stringValue(metadata?.operation) } : {}),
    ...(stringValue(metadata?.capability) ? { capability: stringValue(metadata?.capability) } : {}),
    ...(stringValue(metadata?.agentReviewStatus) ? { agentReviewStatus: stringValue(metadata?.agentReviewStatus) } : {}),
    ...(stringValue(metadata?.agentReviewDecision) ? { agentReviewDecision: stringValue(metadata?.agentReviewDecision) } : {}),
    ...(reviewText(metadata, ['agentReviewSummary', 'reviewSummary', 'summary'])
      ? { agentReviewSummary: reviewText(metadata, ['agentReviewSummary', 'reviewSummary', 'summary']) }
      : {}),
    ...(reviewText(metadata, ['agentReviewReason', 'reason', 'decisionReason', 'denialReason'])
      ? { agentReviewReason: reviewText(metadata, ['agentReviewReason', 'reason', 'decisionReason', 'denialReason']) }
      : {}),
    ...(stringArray(metadata?.factLabels) ? { factLabels: stringArray(metadata?.factLabels) } : {}),
    approvalBoundary: stringValue(metadata?.approvalBoundary) ??
      'Wallet approval is required for every recurring occurrence; the agent does not sign or submit transactions.',
  };
}

function reviewText(metadata: JsonObject | undefined, keys: string[]): string | undefined {
  if (!metadata) return undefined;
  const review = jsonRecord(metadata.agentReview);
  for (const key of keys) {
    const value = stringValue(metadata[key]);
    if (value) return boundedString(value);
  }
  if (!review) return undefined;
  for (const key of keys) {
    const value = stringValue(review[key]);
    if (value) return boundedString(value);
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined;
  return value.slice(0, 12);
}

function jsonRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function boundedString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}
