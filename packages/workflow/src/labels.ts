import type { RecurringOccurrenceStatus, RecurringScheduleStatus } from './index.js';

export type LabelTone = 'info' | 'success' | 'warning' | 'danger' | 'muted';

export interface StatusLabel {
  label: string;
  tone: LabelTone;
}

export interface ApprovalSummaryHint {
  status?: string;
  txStatus?: string;
}

export function formatOccurrenceStatus(
  status: RecurringOccurrenceStatus,
  approval?: ApprovalSummaryHint,
): StatusLabel {
  if (status === 'completed') {
    if (approval?.txStatus === 'confirmed') return { label: 'Executed', tone: 'success' };
    return { label: 'Approved', tone: 'success' };
  }
  if (status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
  if (status === 'skipped') return { label: 'Skipped', tone: 'warning' };
  if (status === 'approval_pending') return { label: 'Awaiting approval', tone: 'info' };
  if (status === 'ready') {
    return { label: 'Awaiting approval', tone: 'info' };
  }
  if (status === 'scheduled') return { label: 'Scheduled', tone: 'muted' };
  return { label: status, tone: 'muted' };
}

export function formatScheduleStatus(status: RecurringScheduleStatus): StatusLabel {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'success' };
    case 'paused':
      return { label: 'Paused', tone: 'warning' };
    case 'completed':
      return { label: 'Completed', tone: 'muted' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'muted' };
    default:
      return { label: status, tone: 'muted' };
  }
}
