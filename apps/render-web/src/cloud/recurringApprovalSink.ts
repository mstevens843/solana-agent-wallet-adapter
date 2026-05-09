import type { ApprovalSink, ApprovalStatusReader } from './recurringService.js';
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
