export const PAY_OUT_APPROVAL_CREATED_EVENT = 'agentic:pay-out-approval-created';

export interface PayOutApprovalCreatedDetail {
  source: 'acp_outbound';
  approvalId: string;
  cartId: string;
  cartHash?: string;
}

export function isPayOutApprovalCreatedDetail(value: unknown): value is PayOutApprovalCreatedDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<PayOutApprovalCreatedDetail>;
  return record.source === 'acp_outbound' &&
    typeof record.approvalId === 'string' &&
    record.approvalId.length > 0 &&
    typeof record.cartId === 'string' &&
    record.cartId.length > 0 &&
    (record.cartHash === undefined || typeof record.cartHash === 'string');
}

export function dispatchPayOutApprovalCreated(detail: PayOutApprovalCreatedDetail): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<PayOutApprovalCreatedDetail>(PAY_OUT_APPROVAL_CREATED_EVENT, { detail }));
  return true;
}

export function addPayOutApprovalCreatedListener(
  handler: (detail: PayOutApprovalCreatedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isPayOutApprovalCreatedDetail(detail)) handler(detail);
  };
  window.addEventListener(PAY_OUT_APPROVAL_CREATED_EVENT, listener);
  return () => window.removeEventListener(PAY_OUT_APPROVAL_CREATED_EVENT, listener);
}
