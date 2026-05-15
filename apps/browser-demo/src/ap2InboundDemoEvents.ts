export const AP2_INBOUND_DEMO_CREATED_EVENT = 'agentic:ap2-inbound-demo-created';

export interface Ap2InboundDemoApproval {
  id: string;
  walletAddress: string;
  kind: string;
  status: string;
  summary: string;
  amount: string;
  token: string;
  recipient: string;
  cluster: string;
  params: Record<string, unknown>;
  metadata: Record<string, unknown>;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface Ap2InboundDemoCreatedDetail {
  source: 'ap2_inbound_demo';
  approvalId: string;
  approval: Ap2InboundDemoApproval;
}

export function isAp2InboundDemoCreatedDetail(value: unknown): value is Ap2InboundDemoCreatedDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<Ap2InboundDemoCreatedDetail>;
  return record.source === 'ap2_inbound_demo' &&
    typeof record.approvalId === 'string' &&
    record.approvalId.length > 0 &&
    record.approval !== undefined &&
    record.approval !== null &&
    typeof record.approval === 'object' &&
    !Array.isArray(record.approval);
}

export function dispatchAp2InboundDemoCreated(detail: Ap2InboundDemoCreatedDetail): boolean {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return false;
  window.dispatchEvent(new CustomEvent<Ap2InboundDemoCreatedDetail>(AP2_INBOUND_DEMO_CREATED_EVENT, { detail }));
  return true;
}

export function addAp2InboundDemoCreatedListener(
  handler: (detail: Ap2InboundDemoCreatedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isAp2InboundDemoCreatedDetail(detail)) handler(detail);
  };
  window.addEventListener(AP2_INBOUND_DEMO_CREATED_EVENT, listener);
  return () => window.removeEventListener(AP2_INBOUND_DEMO_CREATED_EVENT, listener);
}
