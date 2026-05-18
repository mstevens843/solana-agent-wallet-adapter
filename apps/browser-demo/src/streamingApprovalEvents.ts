import type { WorkflowCluster } from '@solana-agent-wallet-adapter/workflow';
import type { UnsignedStreamingTx } from './streamingClient.js';

export const STREAMING_APPROVAL_REQUESTED_EVENT = 'agentic:streaming-approval-requested';
export const STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT = 'agentic:streaming-approval-execute-requested';
export const STREAMING_APPROVAL_COMPLETED_EVENT = 'agentic:streaming-approval-completed';

export type StreamingApprovalOperation = 'grant' | 'revoke';

export interface StreamingApprovalRequestedDetail {
  source: 'streaming_session';
  operation: StreamingApprovalOperation;
  sessionId: string;
  tx: UnsignedStreamingTx;
  callbackPath: string;
  summary?: string;
  walletAddress?: string;
  cluster?: WorkflowCluster;
}

export interface StreamingApprovalExecuteRequestedDetail extends StreamingApprovalRequestedDetail {
  approvalId?: string;
  txid?: string;
}

export interface StreamingApprovalCompletedDetail {
  source: 'streaming_session';
  operation: StreamingApprovalOperation;
  sessionId: string;
  approvalId: string;
  status: 'queued' | 'submitted' | 'confirmed' | 'failed';
  txid?: string;
  error?: string;
}

export function streamingApprovalSignedBody(input: {
  operation: StreamingApprovalOperation;
  txid: string;
  approvalId: string;
  status: 'submitted' | 'confirmed';
  txStatus: string;
}): Record<string, string> {
  return {
    ...(input.operation === 'grant'
      ? { approveTxid: input.txid }
      : { revokeTxid: input.txid }),
    txid: input.txid,
    signature: input.txid,
    approvalId: input.approvalId,
    status: input.status,
    txStatus: input.txStatus,
  };
}

export function isStreamingApprovalRequestedDetail(value: unknown): value is StreamingApprovalRequestedDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StreamingApprovalRequestedDetail>;
  return record.source === 'streaming_session' &&
    (record.operation === 'grant' || record.operation === 'revoke') &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.callbackPath === 'string' &&
    record.callbackPath.length > 0 &&
    Boolean(record.tx && typeof record.tx === 'object' && typeof record.tx.txBase64 === 'string' && record.tx.txBase64.length > 0);
}

export function isStreamingApprovalExecuteRequestedDetail(value: unknown): value is StreamingApprovalExecuteRequestedDetail {
  const record = value as Partial<StreamingApprovalExecuteRequestedDetail>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    record.source !== 'streaming_session' ||
    (record.operation !== 'grant' && record.operation !== 'revoke') ||
    typeof record.sessionId !== 'string' ||
    record.sessionId.length === 0 ||
    typeof record.callbackPath !== 'string' ||
    record.callbackPath.length === 0 ||
    (record.approvalId !== undefined && typeof record.approvalId !== 'string') ||
    (record.txid !== undefined && typeof record.txid !== 'string')
  ) {
    return false;
  }
  if (record.txid && record.txid.length > 0) return true;
  return Boolean(record.tx && typeof record.tx === 'object' && typeof record.tx.txBase64 === 'string' && record.tx.txBase64.length > 0);
}

export function isStreamingApprovalCompletedDetail(value: unknown): value is StreamingApprovalCompletedDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StreamingApprovalCompletedDetail>;
  return record.source === 'streaming_session' &&
    (record.operation === 'grant' || record.operation === 'revoke') &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    typeof record.approvalId === 'string' &&
    record.approvalId.length > 0 &&
    (record.status === 'queued' || record.status === 'submitted' || record.status === 'confirmed' || record.status === 'failed');
}

export function dispatchStreamingApprovalRequested(detail: StreamingApprovalRequestedDetail): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<StreamingApprovalRequestedDetail>(STREAMING_APPROVAL_REQUESTED_EVENT, { detail }));
  return true;
}

export function dispatchStreamingApprovalExecuteRequested(detail: StreamingApprovalExecuteRequestedDetail): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<StreamingApprovalExecuteRequestedDetail>(STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT, { detail }));
  return true;
}

export function dispatchStreamingApprovalCompleted(detail: StreamingApprovalCompletedDetail): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<StreamingApprovalCompletedDetail>(STREAMING_APPROVAL_COMPLETED_EVENT, { detail }));
  return true;
}

export function addStreamingApprovalRequestedListener(
  handler: (detail: StreamingApprovalRequestedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isStreamingApprovalRequestedDetail(detail)) handler(detail);
  };
  window.addEventListener(STREAMING_APPROVAL_REQUESTED_EVENT, listener);
  return () => window.removeEventListener(STREAMING_APPROVAL_REQUESTED_EVENT, listener);
}

export function addStreamingApprovalExecuteRequestedListener(
  handler: (detail: StreamingApprovalExecuteRequestedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isStreamingApprovalExecuteRequestedDetail(detail)) handler(detail);
  };
  window.addEventListener(STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT, listener);
  return () => window.removeEventListener(STREAMING_APPROVAL_EXECUTE_REQUESTED_EVENT, listener);
}

export function addStreamingApprovalCompletedListener(
  handler: (detail: StreamingApprovalCompletedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isStreamingApprovalCompletedDetail(detail)) handler(detail);
  };
  window.addEventListener(STREAMING_APPROVAL_COMPLETED_EVENT, listener);
  return () => window.removeEventListener(STREAMING_APPROVAL_COMPLETED_EVENT, listener);
}
