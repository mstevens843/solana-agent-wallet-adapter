import {
  completedFromApproval,
  type ApprovalRequestRecord,
  type CompletedRecord,
} from '@solana-agent-wallet-adapter/workflow';

export function completedRecordFromApproval(approval: ApprovalRequestRecord): CompletedRecord {
  return completedFromApproval(approval);
}
