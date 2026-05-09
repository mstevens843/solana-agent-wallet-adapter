import type {
  ApprovalSink,
  ApprovalStatusReader,
  RecurringOccurrenceApprovalSummary,
  RecurringOccurrenceCompletedSummary,
  RecurringOccurrenceHistoryHydrator,
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
    const isSol = schedule.token.toUpperCase() === 'SOL';
    const summary = `${schedule.amount} ${schedule.token} recurring approval`;
    const approval = await workflowService.createApproval(
      { walletAddress },
      {
        kind: isSol ? 'transfer_sol' : 'transfer_spl',
        summary,
        params: {
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
        token: schedule.token,
        recipient: schedule.recipient,
        recurringScheduleId: schedule.id,
        recurringOccurrenceId: occurrence.id,
        occurrenceKey: occurrence.occurrenceKey,
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
    const [approvals, completedRecords] = await Promise.all([
      workflowStore.listApprovals(walletAddress),
      workflowStore.listCompleted(walletAddress),
    ]);
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
