export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export const WORKFLOW_MODES = ['agentic_cloud', 'browser_fallback', 'local_bridge'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export const WORKFLOW_STORES = ['cloud', 'browser', 'local_bridge'] as const;
export type WorkflowStoreKind = (typeof WORKFLOW_STORES)[number];

export const WORKFLOW_CLUSTERS = ['mainnet-beta', 'testnet', 'devnet', 'localnet'] as const;
export type WorkflowCluster = (typeof WORKFLOW_CLUSTERS)[number];

export const WORKFLOW_ACTION_KINDS = [
  'transfer_sol',
  'transfer_spl',
  'swap',
  'manual_review',
  'read_only',
  'recurring_payment',
  'custom_transaction',
  'custom',
] as const;
export type WorkflowActionKind = (typeof WORKFLOW_ACTION_KINDS)[number];

export const WORKFLOW_RISK_LEVELS = ['low', 'medium', 'high', 'unknown'] as const;
export type WorkflowRiskLevel = (typeof WORKFLOW_RISK_LEVELS)[number];

export const PLAN_DRAFT_SOURCES = ['template', 'ai'] as const;
export type PlanDraftSource = (typeof PLAN_DRAFT_SOURCES)[number];

export const PLAN_DRAFT_STATUSES = ['draft', 'signed', 'queued', 'archived'] as const;
export type PlanDraftStatus = (typeof PLAN_DRAFT_STATUSES)[number];

export const APPROVAL_STATUSES = [
  'pending',
  'scheduled',
  'ready',
  'overdue',
  'approval_pending',
  'approved',
  'denied',
  'rejected',
  'blocked',
  'failed',
  'expired',
  'cancelled',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApprovalDecision = Extract<ApprovalStatus, 'approved' | 'rejected' | 'cancelled'>;

export const TX_STATUSES = ['pending', 'confirmed', 'failed'] as const;
export type TxStatus = (typeof TX_STATUSES)[number];

export const RECURRING_CADENCES = ['weekly', 'monthly', 'interval_days', 'interval_hours', 'interval_minutes'] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

export const RECURRING_SCHEDULE_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type RecurringScheduleStatus = (typeof RECURRING_SCHEDULE_STATUSES)[number];

export const RECURRING_OCCURRENCE_STATUSES = [
  'scheduled',
  'ready',
  'approval_pending',
  'completed',
  'skipped',
  'failed',
  'cancelled',
] as const;
export type RecurringOccurrenceStatus = (typeof RECURRING_OCCURRENCE_STATUSES)[number];

export const COMPLETED_KINDS = ['one_time', 'recurring_occurrence', 'recurring_schedule', 'evidence_receipt'] as const;
export type CompletedKind = (typeof COMPLETED_KINDS)[number] | 'one-time';

export const EVIDENCE_RECEIPT_STATUSES = ['approved', 'blocked', 'warn', 'observed'] as const;
export type EvidenceReceiptStatus = (typeof EVIDENCE_RECEIPT_STATUSES)[number];

export const EVIDENCE_RECEIPT_KINDS = [
  'review_proof',
  'intent_receipt',
  'policy_receipt',
  'risk_review_receipt',
  'rejection_receipt',
  'tool_trace_receipt',
] as const;
export type EvidenceReceiptKind = (typeof EVIDENCE_RECEIPT_KINDS)[number];

export const AUDIT_ACTORS = ['user', 'wallet', 'server', 'system'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export interface WorkflowCapabilities {
  mode: WorkflowMode;
  storage: WorkflowStoreKind;
  persistent: boolean;
  availableOffline: boolean;
  requiresWalletSession: boolean;
  requiresLocalhost: boolean;
  supportsCloudSync: boolean;
  supportsPrivateLocalMode: boolean;
  supportsPlanDrafts: boolean;
  supportsApprovalRequests: boolean;
  supportsRecurringSchedules: boolean;
  supportsCompletedHistory: boolean;
  supportsEvidenceReceipts: boolean;
  supportsAuditEvents: boolean;
}

export interface WalletSession {
  id: string;
  walletAddress: string;
  createdAt: string;
  expiresAt: string;
  userId?: string;
  lastSeenAt?: string;
}

export interface WorkflowUser {
  walletAddress: string;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}

export interface WorkflowSession {
  walletAddress: string;
  sessionId?: string;
}

export interface PlanDraftField {
  label: string;
  value: string;
}

export interface PlanDraftRecord {
  id: string;
  walletAddress: string;
  plan: JsonObject;
  title: string;
  intent: string;
  route: string;
  risk: string;
  approval: string;
  source: PlanDraftSource;
  category: string;
  actionType: string;
  parameters: Record<string, string>;
  fields: PlanDraftField[];
  safeguards: string[];
  status: PlanDraftStatus;
  createdAt: string;
  updatedAt: string;
  templateId: string;
  templateTitle: string;
  prompt: string;
  cluster: WorkflowCluster;
  userNotes?: string;
  riskLevel?: WorkflowRiskLevel;
  signature?: string;
  approvalRequestId?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface ApprovalRequestRecord {
  id: string;
  walletAddress: string;
  planId?: string;
  planDraftId?: string;
  plan?: JsonObject;
  kind: string;
  status: ApprovalStatus;
  summary: string;
  params: JsonObject;
  cluster?: WorkflowCluster;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  recurringScheduleId?: string;
  recurringOccurrenceId?: string;
  occurrenceKey?: string;
  activeRequestId?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  txid?: string;
  txStatus?: TxStatus;
  explorerUrl?: string;
  confirmedAt?: string;
  decidedAt?: string;
  txError?: string;
  error?: string;
  note?: string;
  decisionNote?: string;
  proofSignature?: string;
  decisionProofSignature?: string;
  decisionProofMessage?: string;
  decisionProofVerified?: boolean;
  archived?: boolean;
  archivedAt?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface RecurringScheduleRecord {
  id: string;
  status: RecurringScheduleStatus;
  walletAddress: string;
  cluster: WorkflowCluster;
  token: string;
  recipient: string;
  amount: string;
  cadence: RecurringCadence;
  createdAt: string;
  updatedAt: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  occurrencesCreated?: number;
  nextDueAt?: string;
  lastMaterializedAt?: string;
  slippageBps?: number;
  memo?: string;
  note?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface RecurringOccurrenceRecord {
  id: string;
  recurringScheduleId: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  status: RecurringOccurrenceStatus;
  occurrenceKey: string;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  approvalRequestId?: string;
  completedRecordId?: string;
  error?: string;
  metadata?: JsonObject;
}

export interface CompletedRecord {
  id: string;
  kind: CompletedKind;
  status: string;
  title: string;
  summary: string;
  walletAddress: string;
  createdAt: string;
  completedAt: string;
  cluster?: WorkflowCluster;
  amount?: string;
  token?: string;
  recipient?: string;
  signature?: string;
  proofSignature?: string;
  txid?: string;
  explorerUrl?: string;
  planId?: string;
  planDraftId?: string;
  approvalId?: string;
  approvalRequestId?: string;
  recurringScheduleId?: string;
  recurringOccurrenceId?: string;
  occurrenceKey?: string;
  evidenceReceiptId?: string;
  error?: string;
  copyPayload: JsonObject;
  detailRows: Array<[string, string]>;
  payload?: JsonObject;
  metadata?: JsonObject;
}

export interface EvidenceReceiptRecord {
  id: string;
  walletAddress: string;
  cluster?: WorkflowCluster | string;
  title: string;
  kind: EvidenceReceiptKind;
  status: EvidenceReceiptStatus;
  payload: JsonObject;
  preSignatureHash: string;
  signingMessage: string;
  signature: string;
  verified: boolean;
  artifactHash: string;
  createdAt: string;
  updatedAt: string;
  receiptType?: string;
  summary?: string;
  verdict?: string;
  effect?: string;
  metadata?: JsonObject;
}

export interface AuditEventRecord {
  id: string;
  walletAddress: string;
  type: string;
  createdAt: string;
  actor?: AuditActor;
  eventType?: string;
  recordType?: 'plan' | 'approval' | 'completed' | 'evidence';
  recordId?: string;
  subjectType?: string;
  subjectId?: string;
  outcome?: string;
  metadata: JsonObject;
}

export interface AuthNonceResponse {
  nonce: string;
  message: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  walletAddress?: string;
}

export interface VerifyWalletRequest {
  walletAddress: string;
  message: string;
  signature: string;
  nonce: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  signatureEncoding?: 'base58' | 'base64';
}

export interface SessionResponse {
  signedIn: boolean;
  capabilities?: WorkflowCapabilities;
  session?: WalletSession;
  user?: WorkflowUser;
  expiresAt?: string;
}

export interface CreatePlanRequest {
  plan: JsonObject;
  title: string;
  intent: string;
  route: string;
  risk: string;
  approval: string;
  source: PlanDraftSource;
  category: string;
  actionType: string;
  parameters: Record<string, string>;
  fields: PlanDraftField[];
  safeguards: string[];
  templateId: string;
  templateTitle: string;
  prompt: string;
  cluster: WorkflowCluster;
  userNotes?: string;
  status?: PlanDraftStatus;
  signature?: string;
  riskLevel?: WorkflowRiskLevel;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}
export type CreatePlanInput = CreatePlanRequest;

export interface UpdatePlanInput {
  plan?: JsonObject;
  title?: string;
  intent?: string;
  route?: string;
  risk?: string;
  approval?: string;
  source?: PlanDraftSource;
  category?: string;
  actionType?: string;
  parameters?: Record<string, string>;
  fields?: PlanDraftField[];
  safeguards?: string[];
  templateId?: string;
  templateTitle?: string;
  prompt?: string;
  cluster?: WorkflowCluster;
  userNotes?: string;
  riskLevel?: WorkflowRiskLevel;
  status?: PlanDraftStatus;
  signature?: string;
  approvalRequestId?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface PlanListResponse {
  plans: PlanDraftRecord[];
}

export interface CreateApprovalRequest {
  planId?: string;
  planDraftId?: string;
  plan?: JsonObject;
  kind?: string;
  summary?: string;
  params?: JsonObject;
  cluster?: WorkflowCluster;
  dueAt?: string;
  recurringScheduleId?: string;
  recurringOccurrenceId?: string;
  occurrenceKey?: string;
  note?: string;
  amount?: string;
  token?: string;
  recipient?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}
export type CreateApprovalInput = CreateApprovalRequest;

export interface ApprovalDecisionInput {
  proofSignature?: string;
  decisionProofSignature?: string;
  decisionProofMessage?: string;
  signatureEncoding?: 'base58' | 'base64';
  note?: string;
  txid?: string;
  explorerUrl?: string;
  error?: string;
}

export interface ApprovalListResponse {
  approvals: ApprovalRequestRecord[];
}

export interface CreateRecurringRequest {
  cluster: WorkflowCluster;
  token: string;
  recipient: string;
  amount: string;
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  slippageBps?: number;
  memo?: string;
  note?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface UpdateRecurringRequest {
  status?: RecurringScheduleStatus;
  cluster?: WorkflowCluster;
  token?: string;
  recipient?: string;
  amount?: string;
  cadence?: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  slippageBps?: number;
  memo?: string;
  note?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface RecurringListResponse {
  schedules: RecurringScheduleRecord[];
  occurrences: RecurringOccurrenceRecord[];
}

export interface MaterializeResult {
  scheduleId: string;
  occurrenceKey?: string;
  occurrenceId?: string;
  reason: 'created' | 'duplicate' | 'paused' | 'completed' | 'cancelled' | 'not_due' | 'invalid';
}

export interface MaterializeResponse {
  results: MaterializeResult[];
}

export interface CompletedListResponse {
  completed: CompletedRecord[];
}

export interface CreateEvidenceReceiptRequest {
  title: string;
  kind: EvidenceReceiptKind;
  status: EvidenceReceiptStatus;
  payload: JsonObject;
  preSignatureHash: string;
  signingMessage: string;
  signature: string;
  cluster: WorkflowCluster;
  artifactHash?: string;
  receiptType?: string;
  summary?: string;
  verdict?: string;
  effect?: string;
  metadata?: JsonObject;
}

export interface EvidenceReceiptListResponse {
  receipts: EvidenceReceiptRecord[];
}

export class WorkflowValidationError extends Error {
  readonly path: string | undefined;

  constructor(readonly code: string, message: string, path?: string) {
    super(message);
    this.name = 'WorkflowValidationError';
    this.path = path;
  }
}

export class RecurringValidationError extends WorkflowValidationError {
  constructor(code: string, message: string, path?: string) {
    super(code, message, path);
    this.name = 'RecurringValidationError';
  }
}

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return (
    status === 'approved' ||
    status === 'denied' ||
    status === 'rejected' ||
    status === 'blocked' ||
    status === 'failed' ||
    status === 'expired' ||
    status === 'cancelled'
  );
}

export function isActiveApprovalStatus(status: ApprovalStatus): boolean {
  return status === 'pending' || status === 'scheduled' || status === 'ready' || status === 'overdue' || status === 'approval_pending';
}

export function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === 'approved' || value === 'rejected' || value === 'cancelled';
}

export interface CompletedReceiptOptions {
  id: string;
  completedAt: string;
}

export function completedRecordFromApproval(
  approval: ApprovalRequestRecord,
  options: CompletedReceiptOptions,
): CompletedRecord {
  if (!isTerminalApprovalStatus(approval.status)) {
    throw new WorkflowValidationError(
      'approval_not_terminal',
      'Approval must be terminal before it can become completed history.',
      'approval.status',
    );
  }
  const recurring = Boolean(approval.recurringScheduleId || approval.recurringOccurrenceId || approval.occurrenceKey);
  const amount = approval.amount ?? firstStringParam(approval.params, ['amountSol', 'amount', 'inputAmount']);
  const recipient = approval.recipient ?? firstStringParam(approval.params, ['recipient', 'recipientAddress']);
  const token = approval.token ?? (approval.kind === 'transfer_sol'
    ? 'SOL'
    : firstStringParam(approval.params, ['token', 'inputToken', 'outputToken']));
  const proofSignature = approval.proofSignature ?? approval.decisionProofSignature;
  const planDraftId = approval.planDraftId ?? approval.planId;
  const copyPayload: JsonObject = {
    type: recurring ? 'completed_recurring_occurrence' : 'completed_one_time_approval',
    approvalRequestId: approval.id,
    status: approval.status,
    summary: approval.summary,
    walletAddress: approval.walletAddress,
    completedAt: options.completedAt,
    ...(planDraftId ? { planDraftId } : {}),
    ...(approval.recurringScheduleId ? { recurringScheduleId: approval.recurringScheduleId } : {}),
    ...(approval.recurringOccurrenceId ? { recurringOccurrenceId: approval.recurringOccurrenceId } : {}),
    ...(approval.occurrenceKey ? { occurrenceKey: approval.occurrenceKey } : {}),
    ...(approval.txid ? { txid: approval.txid } : {}),
    ...(proofSignature ? { proofSignature } : {}),
    ...(approval.decisionProofMessage ? { decisionProofMessage: approval.decisionProofMessage } : {}),
    ...(approval.decisionProofVerified !== undefined ? { decisionProofVerified: approval.decisionProofVerified } : {}),
  };

  return {
    id: options.id,
    kind: recurring ? 'recurring_occurrence' : 'one_time',
    status: approval.status,
    title: approval.summary,
    summary: approval.decisionNote ?? approval.note ?? approval.summary,
    walletAddress: approval.walletAddress,
    createdAt: approval.createdAt,
    completedAt: options.completedAt,
    ...(approval.cluster !== undefined && { cluster: approval.cluster }),
    ...(amount !== undefined && { amount }),
    ...(token !== undefined && { token }),
    ...(recipient !== undefined && { recipient }),
    ...(proofSignature !== undefined && { proofSignature, signature: proofSignature }),
    ...(approval.decisionProofMessage !== undefined && {
      metadata: {
        decisionProofMessage: approval.decisionProofMessage,
        ...(approval.decisionProofVerified !== undefined && { decisionProofVerified: approval.decisionProofVerified }),
      },
    }),
    ...(approval.txid !== undefined && { txid: approval.txid }),
    ...(approval.explorerUrl !== undefined
      ? { explorerUrl: approval.explorerUrl }
      : approval.txid !== undefined && approval.cluster !== undefined
        ? { explorerUrl: explorerUrl(approval.txid, approval.cluster) }
        : {}),
    ...(planDraftId !== undefined && { planDraftId }),
    approvalRequestId: approval.id,
    ...(approval.recurringScheduleId !== undefined && { recurringScheduleId: approval.recurringScheduleId }),
    ...(approval.recurringOccurrenceId !== undefined && { recurringOccurrenceId: approval.recurringOccurrenceId }),
    ...(approval.occurrenceKey !== undefined && { occurrenceKey: approval.occurrenceKey }),
    ...(approval.error !== undefined && { error: approval.error }),
    copyPayload,
    detailRows: completedRows([
      ['Type', recurring ? 'Recurring occurrence' : 'One-time approval'],
      ['Status', approval.status],
      ['Approval id', approval.id],
      planDraftId ? ['Plan id', planDraftId] : undefined,
      approval.recurringScheduleId ? ['Recurring schedule', approval.recurringScheduleId] : undefined,
      approval.occurrenceKey ? ['Occurrence', approval.occurrenceKey] : undefined,
      ['Wallet', approval.walletAddress],
      recipient ? ['Recipient', recipient] : undefined,
      amount ? ['Amount', `${amount} ${token ?? ''}`.trim()] : undefined,
      ['Created', approval.createdAt],
      ['Completed', options.completedAt],
      proofSignature ? ['Decision proof', proofSignature] : undefined,
      approval.decisionProofVerified !== undefined ? ['Decision proof verified', String(approval.decisionProofVerified)] : undefined,
      approval.txid ? ['Transaction', approval.txid] : undefined,
      approval.error ? ['Error', approval.error] : undefined,
    ]),
    payload: {
      type: recurring ? 'recurring_occurrence' : 'one_time',
      approvalRequestId: approval.id,
      status: approval.status,
      params: approval.params,
    },
  };
}

export function completedFromApproval(approval: ApprovalRequestRecord): CompletedRecord {
  return completedRecordFromApproval(approval, {
    id: `completed:${approval.id}`,
    completedAt: approval.confirmedAt ?? approval.decidedAt ?? approval.updatedAt,
  });
}

export function normalizeCompletedRecord(record: CompletedRecord): CompletedRecord {
  const { approvalId: _approvalId, planId: _planId, ...rest } = record;
  const approvalRequestId = record.approvalRequestId ?? record.approvalId;
  const planDraftId = record.planDraftId ?? record.planId;
  return {
    ...rest,
    kind: record.kind === 'one-time' ? 'one_time' : record.kind,
    ...(approvalRequestId ? { approvalRequestId } : {}),
    ...(planDraftId ? { planDraftId } : {}),
    copyPayload: record.copyPayload ?? record.payload ?? { type: record.kind, id: record.id },
    detailRows: record.detailRows ?? completedRows([
      ['Type', record.kind],
      ['Status', record.status],
      ['Wallet', record.walletAddress],
      ['Created', record.createdAt],
      ['Completed', record.completedAt],
      approvalRequestId ? ['Approval id', approvalRequestId] : undefined,
      record.txid ? ['Transaction', record.txid] : undefined,
    ]),
    payload: record.payload ?? record.copyPayload ?? { type: record.kind, id: record.id },
  };
}

export function capabilitiesForWorkflowMode(mode: WorkflowMode): WorkflowCapabilities {
  switch (mode) {
    case 'agentic_cloud':
      return {
        mode,
        storage: 'cloud',
        persistent: true,
        availableOffline: false,
        requiresWalletSession: true,
        requiresLocalhost: false,
        supportsCloudSync: true,
        supportsPrivateLocalMode: false,
        supportsPlanDrafts: true,
        supportsApprovalRequests: true,
        supportsRecurringSchedules: true,
        supportsCompletedHistory: true,
        supportsEvidenceReceipts: true,
        supportsAuditEvents: true,
      };
    case 'browser_fallback':
      return {
        mode,
        storage: 'browser',
        persistent: true,
        availableOffline: true,
        requiresWalletSession: false,
        requiresLocalhost: false,
        supportsCloudSync: false,
        supportsPrivateLocalMode: false,
        supportsPlanDrafts: true,
        supportsApprovalRequests: true,
        supportsRecurringSchedules: true,
        supportsCompletedHistory: true,
        supportsEvidenceReceipts: true,
        supportsAuditEvents: false,
      };
    case 'local_bridge':
      return {
        mode,
        storage: 'local_bridge',
        persistent: true,
        availableOffline: true,
        requiresWalletSession: false,
        requiresLocalhost: true,
        supportsCloudSync: false,
        supportsPrivateLocalMode: true,
        supportsPlanDrafts: true,
        supportsApprovalRequests: true,
        supportsRecurringSchedules: true,
        supportsCompletedHistory: true,
        supportsEvidenceReceipts: true,
        supportsAuditEvents: true,
      };
  }
}

export function parseJsonObject(input: unknown, path = '$'): JsonObject {
  if (!isPlainObject(input)) {
    throw new WorkflowValidationError('invalid_object', 'Expected a JSON object.', path);
  }
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = parseJsonValue(value, `${path}.${key}`);
  }
  return output;
}

export function parseWorkflowCapabilities(input: unknown, path = '$'): WorkflowCapabilities {
  const record = expectRecord(input, path);
  return {
    mode: expectEnum(record, 'mode', WORKFLOW_MODES, path),
    storage: expectEnum(record, 'storage', WORKFLOW_STORES, path),
    persistent: expectBoolean(record, 'persistent', path),
    availableOffline: expectBoolean(record, 'availableOffline', path),
    requiresWalletSession: expectBoolean(record, 'requiresWalletSession', path),
    requiresLocalhost: expectBoolean(record, 'requiresLocalhost', path),
    supportsCloudSync: expectBoolean(record, 'supportsCloudSync', path),
    supportsPrivateLocalMode: expectBoolean(record, 'supportsPrivateLocalMode', path),
    supportsPlanDrafts: expectBoolean(record, 'supportsPlanDrafts', path),
    supportsApprovalRequests: expectBoolean(record, 'supportsApprovalRequests', path),
    supportsRecurringSchedules: expectBoolean(record, 'supportsRecurringSchedules', path),
    supportsCompletedHistory: expectBoolean(record, 'supportsCompletedHistory', path),
    supportsEvidenceReceipts: expectBoolean(record, 'supportsEvidenceReceipts', path),
    supportsAuditEvents: expectBoolean(record, 'supportsAuditEvents', path),
  };
}

export function parseWalletSession(input: unknown, path = '$'): WalletSession {
  const record = expectRecord(input, path);
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    createdAt: expectString(record, 'createdAt', path),
    expiresAt: expectString(record, 'expiresAt', path),
    ...optionalStringProp(record, 'userId', path),
    ...optionalStringProp(record, 'lastSeenAt', path),
  };
}

export function parseWorkflowUser(input: unknown, path = '$'): WorkflowUser {
  const record = expectRecord(input, path);
  return {
    walletAddress: expectString(record, 'walletAddress', path),
    ...optionalStringProp(record, 'id', path),
    ...optionalStringProp(record, 'createdAt', path),
    ...optionalStringProp(record, 'updatedAt', path),
    ...optionalStringProp(record, 'lastSeenAt', path),
  };
}

export function parsePlanDraftField(input: unknown, path = '$'): PlanDraftField {
  const record = expectRecord(input, path);
  return {
    label: expectString(record, 'label', path),
    value: expectString(record, 'value', path),
  };
}

export function parsePlanDraftRecord(input: unknown, path = '$'): PlanDraftRecord {
  const record = expectRecord(input, path);
  const templateId = optionalStringProp(record, 'templateId', path).templateId ?? '';
  const templateTitle = optionalStringProp(record, 'templateTitle', path).templateTitle ?? '';
  const prompt = optionalStringProp(record, 'prompt', path).prompt ?? '';
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    plan: record.plan === undefined ? {} : expectJsonObject(record, 'plan', path),
    title: expectString(record, 'title', path),
    intent: expectString(record, 'intent', path),
    route: expectString(record, 'route', path),
    risk: expectString(record, 'risk', path),
    approval: expectString(record, 'approval', path),
    source: expectEnum(record, 'source', PLAN_DRAFT_SOURCES, path),
    category: expectString(record, 'category', path),
    actionType: expectString(record, 'actionType', path),
    parameters: expectStringRecord(record, 'parameters', path),
    fields: expectArray(record, 'fields', path).map((field, index) => parsePlanDraftField(field, `${path}.fields[${index}]`)),
    safeguards: expectStringArray(record, 'safeguards', path),
    status: expectEnum(record, 'status', PLAN_DRAFT_STATUSES, path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    templateId,
    templateTitle,
    prompt,
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    ...optionalStringProp(record, 'userNotes', path),
    ...optionalEnumProp(record, 'riskLevel', WORKFLOW_RISK_LEVELS, path),
    ...optionalStringProp(record, 'signature', path),
    ...optionalStringProp(record, 'approvalRequestId', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseApprovalRequestRecord(input: unknown, path = '$'): ApprovalRequestRecord {
  const record = expectRecord(input, path);
  const planDraftId = optionalStringProp(record, 'planDraftId', path).planDraftId ??
    optionalStringProp(record, 'planId', path).planId;
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    ...(planDraftId ? { planDraftId } : {}),
    ...optionalJsonObjectProp(record, 'plan', path),
    kind: expectString(record, 'kind', path),
    status: expectEnum(record, 'status', APPROVAL_STATUSES, path),
    summary: expectString(record, 'summary', path),
    params: expectJsonObject(record, 'params', path),
    ...optionalEnumProp(record, 'cluster', WORKFLOW_CLUSTERS, path),
    dueAt: expectString(record, 'dueAt', path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    ...optionalStringProp(record, 'recurringScheduleId', path),
    ...optionalStringProp(record, 'recurringOccurrenceId', path),
    ...optionalStringProp(record, 'occurrenceKey', path),
    ...optionalStringProp(record, 'activeRequestId', path),
    ...optionalStringProp(record, 'amount', path),
    ...optionalStringProp(record, 'token', path),
    ...optionalStringProp(record, 'recipient', path),
    ...optionalStringProp(record, 'txid', path),
    ...optionalEnumProp(record, 'txStatus', TX_STATUSES, path),
    ...optionalStringProp(record, 'explorerUrl', path),
    ...optionalStringProp(record, 'confirmedAt', path),
    ...optionalStringProp(record, 'decidedAt', path),
    ...optionalStringProp(record, 'txError', path),
    ...optionalStringProp(record, 'error', path),
    ...optionalStringProp(record, 'note', path),
    ...optionalStringProp(record, 'decisionNote', path),
    ...optionalStringProp(record, 'proofSignature', path),
    ...optionalStringProp(record, 'decisionProofSignature', path),
    ...optionalStringProp(record, 'decisionProofMessage', path),
    ...optionalBooleanProp(record, 'decisionProofVerified', path),
    ...optionalBooleanProp(record, 'archived', path),
    ...optionalStringProp(record, 'archivedAt', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseRecurringScheduleRecord(input: unknown, path = '$'): RecurringScheduleRecord {
  const record = expectRecord(input, path);
  return {
    id: expectString(record, 'id', path),
    status: expectEnum(record, 'status', RECURRING_SCHEDULE_STATUSES, path),
    walletAddress: expectString(record, 'walletAddress', path),
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    token: expectString(record, 'token', path),
    recipient: expectString(record, 'recipient', path),
    amount: expectString(record, 'amount', path),
    cadence: expectEnum(record, 'cadence', RECURRING_CADENCES, path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    ...optionalIntegerProp(record, 'dayOfWeek', path),
    ...optionalIntegerProp(record, 'dayOfMonth', path),
    ...optionalIntegerProp(record, 'intervalDays', path),
    ...optionalIntegerProp(record, 'intervalHours', path),
    ...optionalIntegerProp(record, 'intervalMinutes', path),
    ...optionalStringProp(record, 'localTime', path),
    ...optionalStringProp(record, 'startAt', path),
    ...optionalIntegerProp(record, 'maxOccurrences', path),
    ...optionalIntegerProp(record, 'occurrencesCreated', path),
    ...optionalStringProp(record, 'nextDueAt', path),
    ...optionalStringProp(record, 'lastMaterializedAt', path),
    ...optionalIntegerProp(record, 'slippageBps', path),
    ...optionalStringProp(record, 'memo', path),
    ...optionalStringProp(record, 'note', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseRecurringOccurrenceRecord(input: unknown, path = '$'): RecurringOccurrenceRecord {
  const record = expectRecord(input, path);
  return {
    id: expectString(record, 'id', path),
    recurringScheduleId: expectString(record, 'recurringScheduleId', path),
    walletAddress: expectString(record, 'walletAddress', path),
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    status: expectEnum(record, 'status', RECURRING_OCCURRENCE_STATUSES, path),
    occurrenceKey: expectString(record, 'occurrenceKey', path),
    dueAt: expectString(record, 'dueAt', path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    ...optionalStringProp(record, 'approvalRequestId', path),
    ...optionalStringProp(record, 'completedRecordId', path),
    ...optionalStringProp(record, 'error', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseCompletedRecord(input: unknown, path = '$'): CompletedRecord {
  const record = expectRecord(input, path);
  const planDraftId = optionalStringProp(record, 'planDraftId', path).planDraftId ??
    optionalStringProp(record, 'planId', path).planId;
  const approvalRequestId = optionalStringProp(record, 'approvalRequestId', path).approvalRequestId ??
    optionalStringProp(record, 'approvalId', path).approvalId;
  return {
    id: expectString(record, 'id', path),
    kind: expectCompletedKind(record, 'kind', path),
    status: expectString(record, 'status', path),
    title: expectString(record, 'title', path),
    summary: expectString(record, 'summary', path),
    walletAddress: expectString(record, 'walletAddress', path),
    createdAt: expectString(record, 'createdAt', path),
    completedAt: expectString(record, 'completedAt', path),
    ...optionalEnumProp(record, 'cluster', WORKFLOW_CLUSTERS, path),
    ...optionalStringProp(record, 'amount', path),
    ...optionalStringProp(record, 'token', path),
    ...optionalStringProp(record, 'recipient', path),
    ...optionalStringProp(record, 'signature', path),
    ...optionalStringProp(record, 'proofSignature', path),
    ...optionalStringProp(record, 'txid', path),
    ...optionalStringProp(record, 'explorerUrl', path),
    ...(planDraftId ? { planDraftId } : {}),
    ...(approvalRequestId ? { approvalRequestId } : {}),
    ...optionalStringProp(record, 'recurringScheduleId', path),
    ...optionalStringProp(record, 'recurringOccurrenceId', path),
    ...optionalStringProp(record, 'occurrenceKey', path),
    ...optionalStringProp(record, 'evidenceReceiptId', path),
    ...optionalStringProp(record, 'error', path),
    copyPayload: expectJsonObject(record, 'copyPayload', path),
    detailRows: expectDetailRows(record, 'detailRows', path),
    ...optionalJsonObjectProp(record, 'payload', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseEvidenceReceiptRecord(input: unknown, path = '$'): EvidenceReceiptRecord {
  const record = expectRecord(input, path);
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    ...optionalStringProp(record, 'cluster', path),
    title: expectString(record, 'title', path),
    kind: expectEnum(record, 'kind', EVIDENCE_RECEIPT_KINDS, path),
    status: expectEnum(record, 'status', EVIDENCE_RECEIPT_STATUSES, path),
    payload: expectJsonObject(record, 'payload', path),
    preSignatureHash: expectString(record, 'preSignatureHash', path),
    signingMessage: expectString(record, 'signingMessage', path),
    signature: expectString(record, 'signature', path),
    verified: expectBoolean(record, 'verified', path),
    artifactHash: expectString(record, 'artifactHash', path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    ...optionalStringProp(record, 'receiptType', path),
    ...optionalStringProp(record, 'summary', path),
    ...optionalStringProp(record, 'verdict', path),
    ...optionalStringProp(record, 'effect', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseAuditEventRecord(input: unknown, path = '$'): AuditEventRecord {
  const record = expectRecord(input, path);
  const type = record.type === undefined ? expectString(record, 'eventType', path) : expectString(record, 'type', path);
  const eventType = optionalStringProp(record, 'eventType', path).eventType ?? type;
  const subjectType = optionalStringProp(record, 'subjectType', path).subjectType ??
    optionalStringProp(record, 'recordType', path).recordType;
  const subjectId = optionalStringProp(record, 'subjectId', path).subjectId ??
    optionalStringProp(record, 'recordId', path).recordId;
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    type,
    createdAt: expectString(record, 'createdAt', path),
    ...optionalEnumProp(record, 'actor', AUDIT_ACTORS, path),
    eventType,
    ...optionalEnumProp(record, 'recordType', ['plan', 'approval', 'completed', 'evidence'] as const, path),
    ...optionalStringProp(record, 'recordId', path),
    ...(subjectType ? { subjectType } : {}),
    ...(subjectId ? { subjectId } : {}),
    ...optionalStringProp(record, 'outcome', path),
    metadata: record.metadata === undefined ? {} : parseJsonObject(record.metadata, `${path}.metadata`),
  };
}

export function parseAuthNonceResponse(input: unknown, path = '$'): AuthNonceResponse {
  const record = expectRecord(input, path);
  return {
    nonce: expectString(record, 'nonce', path),
    message: expectString(record, 'message', path),
    domain: expectString(record, 'domain', path),
    issuedAt: expectString(record, 'issuedAt', path),
    expiresAt: expectString(record, 'expiresAt', path),
    ...optionalStringProp(record, 'walletAddress', path),
  };
}

export function parseVerifyWalletRequest(input: unknown, path = '$'): VerifyWalletRequest {
  const record = expectRecord(input, path);
  return {
    walletAddress: expectString(record, 'walletAddress', path),
    message: expectString(record, 'message', path),
    signature: expectString(record, 'signature', path),
    nonce: expectString(record, 'nonce', path),
    domain: expectString(record, 'domain', path),
    issuedAt: expectString(record, 'issuedAt', path),
    expiresAt: expectString(record, 'expiresAt', path),
    ...optionalEnumProp(record, 'signatureEncoding', ['base58', 'base64'] as const, path),
  };
}

export function parseSessionResponse(input: unknown, path = '$'): SessionResponse {
  const record = expectRecord(input, path);
  return {
    signedIn: expectBoolean(record, 'signedIn', path),
    ...optionalParsedProp(record, 'capabilities', parseWorkflowCapabilities, path),
    ...optionalParsedProp(record, 'session', parseWalletSession, path),
    ...optionalParsedProp(record, 'user', parseWorkflowUser, path),
    ...optionalStringProp(record, 'expiresAt', path),
  };
}

export function parseCreatePlanRequest(input: unknown, path = '$'): CreatePlanRequest {
  const record = expectRecord(input, path);
  return {
    plan: record.plan === undefined ? {} : expectJsonObject(record, 'plan', path),
    title: expectString(record, 'title', path),
    intent: expectString(record, 'intent', path),
    route: expectString(record, 'route', path),
    risk: expectString(record, 'risk', path),
    approval: expectString(record, 'approval', path),
    source: expectEnum(record, 'source', PLAN_DRAFT_SOURCES, path),
    category: expectString(record, 'category', path),
    actionType: expectEnum(record, 'actionType', WORKFLOW_ACTION_KINDS, path),
    parameters: expectStringRecord(record, 'parameters', path),
    fields: record.fields === undefined
      ? []
      : expectArray(record, 'fields', path).map((field, index) => parsePlanDraftField(field, `${path}.fields[${index}]`)),
    safeguards: record.safeguards === undefined ? [] : expectStringArray(record, 'safeguards', path),
    templateId: typeof record.templateId === 'string' ? record.templateId : '',
    templateTitle: typeof record.templateTitle === 'string' ? record.templateTitle : '',
    prompt: typeof record.prompt === 'string' ? record.prompt : '',
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    ...optionalStringProp(record, 'userNotes', path),
    ...optionalEnumProp(record, 'status', PLAN_DRAFT_STATUSES, path),
    ...optionalStringProp(record, 'signature', path),
    ...optionalEnumProp(record, 'riskLevel', WORKFLOW_RISK_LEVELS, path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parsePlanListResponse(input: unknown, path = '$'): PlanListResponse {
  const record = expectRecord(input, path);
  return {
    plans: expectArray(record, 'plans', path).map((plan, index) => parsePlanDraftRecord(plan, `${path}.plans[${index}]`)),
  };
}

export function parseCreateApprovalRequest(input: unknown, path = '$'): CreateApprovalRequest {
  const record = expectRecord(input, path);
  return {
    ...optionalStringProp(record, 'planId', path),
    ...optionalStringProp(record, 'planDraftId', path),
    ...(record.plan === undefined ? {} : { plan: expectJsonObject(record, 'plan', path) }),
    ...optionalEnumProp(record, 'kind', WORKFLOW_ACTION_KINDS, path),
    ...optionalStringProp(record, 'summary', path),
    ...(record.params === undefined ? {} : { params: expectJsonObject(record, 'params', path) }),
    ...optionalEnumProp(record, 'cluster', WORKFLOW_CLUSTERS, path),
    ...optionalStringProp(record, 'dueAt', path),
    ...optionalStringProp(record, 'recurringScheduleId', path),
    ...optionalStringProp(record, 'recurringOccurrenceId', path),
    ...optionalStringProp(record, 'occurrenceKey', path),
    ...optionalStringProp(record, 'note', path),
    ...optionalStringProp(record, 'amount', path),
    ...optionalStringProp(record, 'token', path),
    ...optionalStringProp(record, 'recipient', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseApprovalListResponse(input: unknown, path = '$'): ApprovalListResponse {
  const record = expectRecord(input, path);
  return {
    approvals: expectArray(record, 'approvals', path).map((approval, index) =>
      parseApprovalRequestRecord(approval, `${path}.approvals[${index}]`),
    ),
  };
}

export function parseCreateRecurringRequest(input: unknown, path = '$'): CreateRecurringRequest {
  const record = expectRecord(input, path);
  return {
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    token: expectString(record, 'token', path),
    recipient: expectString(record, 'recipient', path),
    amount: expectString(record, 'amount', path),
    cadence: expectEnum(record, 'cadence', RECURRING_CADENCES, path),
    ...optionalIntegerProp(record, 'dayOfWeek', path),
    ...optionalIntegerProp(record, 'dayOfMonth', path),
    ...optionalIntegerProp(record, 'intervalDays', path),
    ...optionalIntegerProp(record, 'intervalHours', path),
    ...optionalIntegerProp(record, 'intervalMinutes', path),
    ...optionalStringProp(record, 'localTime', path),
    ...optionalStringProp(record, 'startAt', path),
    ...optionalIntegerProp(record, 'maxOccurrences', path),
    ...optionalIntegerProp(record, 'slippageBps', path),
    ...optionalStringProp(record, 'memo', path),
    ...optionalStringProp(record, 'note', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseRecurringListResponse(input: unknown, path = '$'): RecurringListResponse {
  const record = expectRecord(input, path);
  return {
    schedules: expectArray(record, 'schedules', path).map((schedule, index) =>
      parseRecurringScheduleRecord(schedule, `${path}.schedules[${index}]`),
    ),
    occurrences: expectArray(record, 'occurrences', path).map((occurrence, index) =>
      parseRecurringOccurrenceRecord(occurrence, `${path}.occurrences[${index}]`),
    ),
  };
}

export function parseCompletedListResponse(input: unknown, path = '$'): CompletedListResponse {
  const record = expectRecord(input, path);
  return {
    completed: expectArray(record, 'completed', path).map((completed, index) =>
      parseCompletedRecord(completed, `${path}.completed[${index}]`),
    ),
  };
}

export function parseCreateEvidenceReceiptRequest(input: unknown, path = '$'): CreateEvidenceReceiptRequest {
  const record = expectRecord(input, path);
  return {
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    title: expectString(record, 'title', path),
    kind: expectEnum(record, 'kind', EVIDENCE_RECEIPT_KINDS, path),
    status: expectEnum(record, 'status', EVIDENCE_RECEIPT_STATUSES, path),
    payload: expectJsonObject(record, 'payload', path),
    preSignatureHash: expectString(record, 'preSignatureHash', path),
    signingMessage: expectString(record, 'signingMessage', path),
    signature: expectString(record, 'signature', path),
    ...optionalStringProp(record, 'artifactHash', path),
    ...optionalStringProp(record, 'receiptType', path),
    ...optionalStringProp(record, 'summary', path),
    ...optionalStringProp(record, 'verdict', path),
    ...optionalStringProp(record, 'effect', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseEvidenceReceiptListResponse(input: unknown, path = '$'): EvidenceReceiptListResponse {
  const record = expectRecord(input, path);
  return {
    receipts: expectArray(record, 'receipts', path).map((receipt, index) =>
      parseEvidenceReceiptRecord(receipt, `${path}.receipts[${index}]`),
    ),
  };
}

const FORBIDDEN_EXACT_KEYS = new Set([
  'seedphrase',
  'recoveryphrase',
  'mnemonic',
  'privatekey',
  'secretkey',
  'delegatedsigner',
  'delegatesigner',
  'unlimitedapproval',
]);

const EVIDENCE_SHORT_FIELD_MAX_LENGTH = 240;
const EVIDENCE_HASH_MAX_LENGTH = 256;
const EVIDENCE_SIGNING_MESSAGE_MAX_LENGTH = 8192;
const EVIDENCE_SIGNATURE_MAX_LENGTH = 1024;

export function validateCreatePlanRequest(body: unknown, path = '$'): CreatePlanInput {
  assertNoForbiddenWorkflowSecrets(body, path);
  const input = requireObject(body, path);
  const plan = input.plan === undefined ? coerceJsonObject(input, path) : requireJsonObject(input.plan, `${path}.plan`);
  const planSource = stringFromJson(plan, 'source');
  const source = optionalSource(input.source, planSource === 'ai' ? 'ai' : 'template');
  const templateTitle = optionalString(input.templateTitle, 'templateTitle') ?? stringFromJson(plan, 'templateTitle') ?? '';
  const intent = planText(input, plan, 'intent');

  return {
    plan,
    title: optionalString(input.title, 'title') ?? stringFromJson(plan, 'title') ?? intent,
    intent,
    route: planText(input, plan, 'route'),
    risk: planText(input, plan, 'risk'),
    approval: planText(input, plan, 'approval'),
    source,
    category: optionalString(input.category, 'category') ?? stringFromJson(plan, 'category') ?? 'custom',
    actionType: optionalString(input.actionType, 'actionType') ?? stringFromJson(plan, 'actionType') ?? 'manual_review',
    parameters: stringRecord(input.parameters ?? plan.parameters, 'parameters'),
    fields: planFields(input.fields ?? plan.fields, 'fields'),
    safeguards: stringArray(input.safeguards ?? plan.safeguards, 'safeguards'),
    templateId: optionalString(input.templateId, 'templateId') ?? stringFromJson(plan, 'templateId') ?? '',
    templateTitle,
    prompt: optionalString(input.prompt, 'prompt') ?? stringFromJson(plan, 'prompt') ?? '',
    cluster: optionalCluster(input.cluster, stringFromJson(plan, 'cluster') ?? 'devnet'),
    ...(optionalString(input.userNotes, 'userNotes') ?? stringFromJson(plan, 'userNotes')
      ? { userNotes: optionalString(input.userNotes, 'userNotes') ?? stringFromJson(plan, 'userNotes') }
      : {}),
    ...(input.status === undefined ? {} : { status: requirePlanStatus(input.status, 'status') }),
    ...(optionalString(input.signature, 'signature') ? { signature: optionalString(input.signature, 'signature') } : {}),
    ...(input.riskMetadata === undefined ? {} : { riskMetadata: requireJsonObject(input.riskMetadata, 'riskMetadata') }),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

export function validateUpdatePlanRequest(body: unknown): UpdatePlanInput {
  assertNoForbiddenWorkflowSecrets(body);
  const input = requireObject(body, '$');
  const patch: UpdatePlanInput = {};

  if (input.plan !== undefined) patch.plan = requireJsonObject(input.plan, 'plan');
  if (input.title !== undefined) patch.title = requiredString(input.title, 'title');
  if (input.intent !== undefined) patch.intent = requiredString(input.intent, 'intent');
  if (input.route !== undefined) patch.route = requiredString(input.route, 'route');
  if (input.risk !== undefined) patch.risk = requiredString(input.risk, 'risk');
  if (input.approval !== undefined) patch.approval = requiredString(input.approval, 'approval');
  if (input.source !== undefined) patch.source = optionalSource(input.source, undefined);
  if (input.category !== undefined) patch.category = requiredString(input.category, 'category');
  if (input.actionType !== undefined) patch.actionType = requiredString(input.actionType, 'actionType');
  if (input.parameters !== undefined) patch.parameters = stringRecord(input.parameters, 'parameters');
  if (input.fields !== undefined) patch.fields = planFields(input.fields, 'fields');
  if (input.safeguards !== undefined) patch.safeguards = stringArray(input.safeguards, 'safeguards');
  if (input.templateId !== undefined) patch.templateId = requiredString(input.templateId, 'templateId');
  if (input.templateTitle !== undefined) patch.templateTitle = requiredString(input.templateTitle, 'templateTitle');
  if (input.prompt !== undefined) patch.prompt = requiredString(input.prompt, 'prompt');
  if (input.cluster !== undefined) patch.cluster = requireCluster(input.cluster, 'cluster');
  if (input.userNotes !== undefined) patch.userNotes = requiredString(input.userNotes, 'userNotes');
  if (input.riskLevel !== undefined) patch.riskLevel = requireRiskLevel(input.riskLevel, 'riskLevel');
  if (input.status !== undefined) patch.status = requirePlanStatus(input.status, 'status');
  if (input.signature !== undefined) patch.signature = requiredString(input.signature, 'signature');
  if (input.approvalRequestId !== undefined) patch.approvalRequestId = requiredString(input.approvalRequestId, 'approvalRequestId');
  if (input.riskMetadata !== undefined) patch.riskMetadata = requireJsonObject(input.riskMetadata, 'riskMetadata');
  if (input.metadata !== undefined) patch.metadata = requireJsonObject(input.metadata, 'metadata');

  if (Object.keys(patch).length === 0) {
    throw new WorkflowValidationError('empty_patch', 'Plan update must include at least one mutable field.');
  }
  return patch;
}

export function validateCreateApprovalRequest(body: unknown, path = '$'): CreateApprovalInput {
  assertNoForbiddenWorkflowSecrets(body, path);
  const input = requireObject(body, path);
  const planId = optionalString(input.planId, 'planId');
  const planDraftId = optionalString(input.planDraftId, 'planDraftId');
  const canonicalPlanDraftId = planDraftId ?? planId;
  const plan = input.plan === undefined ? undefined : requireJsonObject(input.plan, 'plan');
  const summary = optionalString(input.summary, 'summary');

  if (!canonicalPlanDraftId && !plan && !summary) {
    throw new WorkflowValidationError('missing_approval_source', 'Approval request must include planId, planDraftId, plan, or summary.');
  }

  return {
    ...(canonicalPlanDraftId ? { planDraftId: canonicalPlanDraftId } : {}),
    ...(plan ? { plan } : {}),
    ...(optionalString(input.kind, 'kind') ? { kind: optionalString(input.kind, 'kind') } : {}),
    ...(summary ? { summary } : {}),
    ...(input.params === undefined ? {} : { params: requireJsonObject(input.params, 'params') }),
    ...(input.cluster !== undefined ? { cluster: requireCluster(input.cluster, 'cluster') } : {}),
    ...(optionalString(input.dueAt, 'dueAt') ? { dueAt: optionalString(input.dueAt, 'dueAt') } : {}),
    ...(optionalString(input.note, 'note') ? { note: optionalString(input.note, 'note') } : {}),
    ...(optionalString(input.amount, 'amount') ? { amount: optionalString(input.amount, 'amount') } : {}),
    ...(optionalString(input.token, 'token') ? { token: optionalString(input.token, 'token') } : {}),
    ...(optionalString(input.recipient, 'recipient') ? { recipient: optionalString(input.recipient, 'recipient') } : {}),
    ...(optionalString(input.recurringScheduleId, 'recurringScheduleId') ? { recurringScheduleId: optionalString(input.recurringScheduleId, 'recurringScheduleId') } : {}),
    ...(optionalString(input.recurringOccurrenceId, 'recurringOccurrenceId') ? { recurringOccurrenceId: optionalString(input.recurringOccurrenceId, 'recurringOccurrenceId') } : {}),
    ...(optionalString(input.occurrenceKey, 'occurrenceKey') ? { occurrenceKey: optionalString(input.occurrenceKey, 'occurrenceKey') } : {}),
    ...(input.riskMetadata === undefined ? {} : { riskMetadata: requireJsonObject(input.riskMetadata, 'riskMetadata') }),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

export function validateApprovalDecisionRequest(body: unknown): ApprovalDecisionInput {
  assertNoForbiddenWorkflowSecrets(body);
  const input = requireObject(body ?? {}, '$');
  const proofSignature = optionalString(input.proofSignature, 'proofSignature')
    ?? optionalString(input.decisionProofSignature, 'decisionProofSignature');
  const decisionProofMessage = optionalString(input.decisionProofMessage, 'decisionProofMessage');
  const signatureEncoding = optionalEnumProp(input, 'signatureEncoding', ['base58', 'base64'] as const, '$').signatureEncoding;
  return {
    ...(proofSignature ? { proofSignature, decisionProofSignature: proofSignature } : {}),
    ...(decisionProofMessage ? { decisionProofMessage } : {}),
    ...(signatureEncoding ? { signatureEncoding } : {}),
    ...(optionalString(input.note, 'note') ? { note: optionalString(input.note, 'note') } : {}),
    ...(optionalString(input.txid, 'txid') ? { txid: optionalString(input.txid, 'txid') } : {}),
    ...(optionalString(input.explorerUrl, 'explorerUrl') ? { explorerUrl: optionalString(input.explorerUrl, 'explorerUrl') } : {}),
    ...(optionalString(input.error, 'error') ? { error: optionalString(input.error, 'error') } : {}),
  };
}

export function validateRecordId(value: string, label = 'id'): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw new WorkflowValidationError('invalid_id', `${label} is invalid.`);
  }
  if (!decoded || decoded.includes('/')) {
    throw new WorkflowValidationError('invalid_id', `${label} is invalid.`);
  }
  return decoded;
}

export function validateCreateRecurringRequest(body: unknown, path = '$'): CreateRecurringRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const input = requireObject(body, path);
  const request: CreateRecurringRequest = {
    cluster: requireCluster(input.cluster, 'cluster'),
    token: requireNonEmptyString(input.token, 'token'),
    recipient: requireNonEmptyString(input.recipient, 'recipient'),
    amount: requireNonEmptyString(input.amount, 'amount'),
    cadence: requireCadence(input.cadence),
    ...optionalIntegerField(input.dayOfWeek, 'dayOfWeek'),
    ...optionalIntegerField(input.dayOfMonth, 'dayOfMonth'),
    ...optionalIntegerField(input.intervalDays, 'intervalDays'),
    ...optionalIntegerField(input.intervalHours, 'intervalHours'),
    ...optionalIntegerField(input.intervalMinutes, 'intervalMinutes'),
    ...optionalStringField(input.localTime, 'localTime'),
    ...optionalStringField(input.startAt, 'startAt'),
    ...optionalIntegerField(input.maxOccurrences, 'maxOccurrences'),
    ...optionalIntegerField(input.slippageBps, 'slippageBps'),
    ...optionalStringField(input.memo, 'memo'),
    ...optionalStringField(input.note, 'note'),
    ...optionalJsonObjectField(input.riskMetadata, 'riskMetadata'),
    ...optionalJsonObjectField(input.metadata, 'metadata'),
  };
  assertCadenceFields(request);
  return request;
}

export function validateUpdateRecurringRequest(body: unknown): UpdateRecurringRequest {
  assertNoForbiddenWorkflowSecrets(body);
  const input = requireObject(body, '$');
  const patch: UpdateRecurringRequest = {};

  if (input.status !== undefined) patch.status = requireScheduleStatus(input.status);
  if (input.cluster !== undefined) patch.cluster = requireCluster(input.cluster, 'cluster');
  if (input.token !== undefined) patch.token = requireNonEmptyString(input.token, 'token');
  if (input.recipient !== undefined) patch.recipient = requireNonEmptyString(input.recipient, 'recipient');
  if (input.amount !== undefined) patch.amount = requireNonEmptyString(input.amount, 'amount');
  if (input.cadence !== undefined) patch.cadence = requireCadence(input.cadence);
  if (input.dayOfWeek !== undefined) patch.dayOfWeek = requireInteger(input.dayOfWeek, 'dayOfWeek');
  if (input.dayOfMonth !== undefined) patch.dayOfMonth = requireInteger(input.dayOfMonth, 'dayOfMonth');
  if (input.intervalDays !== undefined) patch.intervalDays = requireInteger(input.intervalDays, 'intervalDays');
  if (input.intervalHours !== undefined) patch.intervalHours = requireInteger(input.intervalHours, 'intervalHours');
  if (input.intervalMinutes !== undefined) patch.intervalMinutes = requireInteger(input.intervalMinutes, 'intervalMinutes');
  if (input.localTime !== undefined) patch.localTime = requireNonEmptyString(input.localTime, 'localTime');
  if (input.startAt !== undefined) patch.startAt = requireNonEmptyString(input.startAt, 'startAt');
  if (input.maxOccurrences !== undefined) patch.maxOccurrences = requireInteger(input.maxOccurrences, 'maxOccurrences');
  if (input.slippageBps !== undefined) patch.slippageBps = requireInteger(input.slippageBps, 'slippageBps');
  if (input.memo !== undefined) patch.memo = requireNonEmptyString(input.memo, 'memo');
  if (input.note !== undefined) patch.note = requireNonEmptyString(input.note, 'note');
  if (input.riskMetadata !== undefined) patch.riskMetadata = requireJsonObject(input.riskMetadata, 'riskMetadata');
  if (input.metadata !== undefined) patch.metadata = requireJsonObject(input.metadata, 'metadata');

  if (Object.keys(patch).length === 0) {
    throw new RecurringValidationError('empty_patch', 'Recurring update must include at least one mutable field.');
  }
  return patch;
}

export function validateRecurringId(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value).trim();
  } catch {
    throw new RecurringValidationError('invalid_id', 'Recurring schedule id is invalid.');
  }
  if (!decoded || decoded.includes('/')) {
    throw new RecurringValidationError('invalid_id', 'Recurring schedule id is invalid.');
  }
  return decoded;
}

export function validateCreateEvidenceReceiptRequest(body: unknown, path = '$'): CreateEvidenceReceiptRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const input = requireObject(body, path);
  const artifactHash = optionalEvidenceHash(input.artifactHash, 'artifactHash');
  const receiptType = optionalEvidenceShortString(input.receiptType, 'receiptType');
  const summary = optionalEvidenceShortString(input.summary, 'summary');
  const verdict = optionalEvidenceShortString(input.verdict, 'verdict');
  const effect = optionalEvidenceShortString(input.effect, 'effect');

  return {
    title: requiredEvidenceShortString(input.title, 'title'),
    kind: requireEvidenceReceiptKind(input.kind),
    status: requireEvidenceReceiptStatus(input.status),
    cluster: requireRequiredCluster(input.cluster),
    payload: requireJsonObject(input.payload, 'payload'),
    preSignatureHash: requiredEvidenceHash(input.preSignatureHash, 'preSignatureHash'),
    signingMessage: requiredEvidenceSigningMessage(input.signingMessage),
    signature: requiredEvidenceSignature(input.signature),
    ...(artifactHash ? { artifactHash } : {}),
    ...(receiptType ? { receiptType } : {}),
    ...(summary ? { summary } : {}),
    ...(verdict ? { verdict } : {}),
    ...(effect ? { effect } : {}),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

export function stringFromJson(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function assertNoForbiddenWorkflowSecrets(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenWorkflowSecrets(entry, `${path}[${index}]`));
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_EXACT_KEYS.has(normalized) || normalized.includes('privatekey') || normalized.includes('secretkey')) {
      throw new WorkflowValidationError('forbidden_secret', `${path}.${key} is not accepted by Agentic Cloud workflow APIs.`);
    }
    if (
      (normalized.includes('approvalauthority') || normalized.includes('signingauthority') || normalized.includes('authority')) &&
      indicatesUnlimitedAuthority(entry)
    ) {
      throw new WorkflowValidationError('forbidden_authority', `${path}.${key} cannot grant unlimited approval authority.`);
    }
    assertNoForbiddenWorkflowSecrets(entry, `${path}.${key}`);
  }
}

function explorerUrl(txid: string, cluster: WorkflowCluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
}

function firstStringParam(params: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function parseJsonValue(input: unknown, path: string): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') {
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new WorkflowValidationError('invalid_json', 'Expected a finite JSON number.', path);
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((value, index) => parseJsonValue(value, `${path}[${index}]`));
  }
  if (isPlainObject(input)) {
    return parseJsonObject(input, path);
  }
  throw new WorkflowValidationError('invalid_json', 'Expected a JSON value.', path);
}

function expectRecord(input: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new WorkflowValidationError('invalid_object', 'Expected an object.', path);
  }
  return input;
}

function expectRequired(record: Record<string, unknown>, key: string, path: string): unknown {
  const value = record[key];
  if (value === undefined) {
    throw new WorkflowValidationError('missing_field', 'Missing required field.', `${path}.${key}`);
  }
  return value;
}

function expectString(record: Record<string, unknown>, key: string, path: string): string {
  const value = expectRequired(record, key, path);
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  return value;
}

function expectBoolean(record: Record<string, unknown>, key: string, path: string): boolean {
  const value = expectRequired(record, key, path);
  if (typeof value !== 'boolean') {
    throw new WorkflowValidationError('invalid_boolean', 'Expected a boolean.', `${path}.${key}`);
  }
  return value;
}

function expectEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
  path: string,
): T[number] {
  const value = expectString(record, key, path);
  if (!values.includes(value as T[number])) {
    throw new WorkflowValidationError('invalid_enum', `Expected one of: ${values.join(', ')}.`, `${path}.${key}`);
  }
  return value as T[number];
}

function expectArray(record: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = expectRequired(record, key, path);
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_array', 'Expected an array.', `${path}.${key}`);
  }
  return value;
}

function expectStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  return expectArray(record, key, path).map((value, index) => {
    if (typeof value !== 'string') {
      throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}[${index}]`);
    }
    return value;
  });
}

function expectStringRecord(record: Record<string, unknown>, key: string, path: string): Record<string, string> {
  const value = expectRequired(record, key, path);
  if (!isPlainObject(value)) {
    throw new WorkflowValidationError('invalid_object', 'Expected an object.', `${path}.${key}`);
  }
  const output: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') {
      throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}.${entryKey}`);
    }
    output[entryKey] = entryValue;
  }
  return output;
}

function expectJsonObject(record: Record<string, unknown>, key: string, path: string): JsonObject {
  return parseJsonObject(expectRequired(record, key, path), `${path}.${key}`);
}

function optionalStringProp<T extends string>(record: Record<string, unknown>, key: T, path: string): Partial<Record<T, string>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  return { [key]: value } as Partial<Record<T, string>>;
}

function optionalBooleanProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, boolean>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'boolean') {
    throw new WorkflowValidationError('invalid_boolean', 'Expected a boolean.', `${path}.${key}`);
  }
  return { [key]: value } as Partial<Record<T, boolean>>;
}

function optionalIntegerProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, number>> {
  const value = record[key];
  if (value === undefined) return {};
  if (!Number.isInteger(value)) {
    throw new WorkflowValidationError('invalid_integer', 'Expected an integer.', `${path}.${key}`);
  }
  return { [key]: value } as Partial<Record<T, number>>;
}

function optionalEnumProp<T extends string, const V extends readonly string[]>(
  record: Record<string, unknown>,
  key: T,
  values: V,
  path: string,
): Partial<Record<T, V[number]>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== 'string' || !values.includes(value as V[number])) {
    throw new WorkflowValidationError('invalid_enum', `Expected one of: ${values.join(', ')}.`, `${path}.${key}`);
  }
  return { [key]: value } as Partial<Record<T, V[number]>>;
}

function optionalJsonObjectProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, JsonObject>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: parseJsonObject(value, `${path}.${key}`) } as Partial<Record<T, JsonObject>>;
}

function optionalStringArrayProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, string[]>> {
  const value = record[key];
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_array', 'Expected an array.', `${path}.${key}`);
  }
  return {
    [key]: value.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new WorkflowValidationError('invalid_string', 'Expected a string.', `${path}.${key}[${index}]`);
      }
      return entry;
    }),
  } as Partial<Record<T, string[]>>;
}

function optionalParsedProp<T extends string, V>(
  record: Record<string, unknown>,
  key: T,
  parser: (input: unknown, path: string) => V,
  path: string,
): Partial<Record<T, V>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: parser(value, `${path}.${key}`) } as Partial<Record<T, V>>;
}

function optionalParsedArrayProp<T extends string, V>(
  record: Record<string, unknown>,
  key: T,
  parser: (input: unknown, path: string) => V,
  path: string,
): Partial<Record<T, V[]>> {
  const value = record[key];
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_array', 'Expected an array.', `${path}.${key}`);
  }
  return {
    [key]: value.map((entry, index) => parser(entry, `${path}.${key}[${index}]`)),
  } as Partial<Record<T, V[]>>;
}

function expectCompletedKind(record: Record<string, unknown>, key: string, path: string): CompletedKind {
  const value = expectString(record, key, path);
  if (value === 'one-time') return 'one_time';
  if (COMPLETED_KINDS.includes(value as (typeof COMPLETED_KINDS)[number])) {
    return value as CompletedKind;
  }
  throw new WorkflowValidationError('invalid_kind', `Expected one of: one-time, ${COMPLETED_KINDS.join(', ')}.`, `${path}.${key}`);
}

function expectDetailRows(record: Record<string, unknown>, key: string, path: string): Array<[string, string]> {
  return expectArray(record, key, path).map((value, index) => {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
      throw new WorkflowValidationError('invalid_detail_rows', 'Expected a [label, value] string tuple.', `${path}.${key}[${index}]`);
    }
    return [value[0], value[1]];
  });
}

function completedRows(rows: Array<[string, string] | undefined>): Array<[string, string]> {
  return rows.filter((row): row is [string, string] => Boolean(row && row[1]));
}

function requirePlanStatus(value: unknown, label: string): PlanDraftStatus {
  const status = requiredString(value, label);
  if (!PLAN_DRAFT_STATUSES.includes(status as PlanDraftStatus)) {
    throw new WorkflowValidationError('invalid_status', `${label} must be draft, signed, queued, or archived.`);
  }
  return status as PlanDraftStatus;
}

function requireRiskLevel(value: unknown, label: string): WorkflowRiskLevel {
  const riskLevel = requiredString(value, label);
  if (!WORKFLOW_RISK_LEVELS.includes(riskLevel as WorkflowRiskLevel)) {
    throw new WorkflowValidationError('invalid_risk_level', `${label} must be one of: ${WORKFLOW_RISK_LEVELS.join(', ')}.`);
  }
  return riskLevel as WorkflowRiskLevel;
}

function optionalSource(value: unknown, fallback: PlanDraftSource | undefined): PlanDraftSource {
  if (value === undefined || value === null || value === '') return fallback ?? 'template';
  if (value === 'template' || value === 'ai') return value;
  throw new WorkflowValidationError('invalid_source', 'source must be template or ai.');
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  return coerceJsonObject(value, label);
}

function planText(input: Record<string, unknown>, plan: JsonObject, key: string): string {
  const value = optionalString(input[key], key) ?? stringFromJson(plan, key);
  if (!value) {
    throw new WorkflowValidationError('missing_plan_field', `${key} is required.`);
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const object = requireObject(value, label);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== 'string') {
      throw new WorkflowValidationError('invalid_string_record', `${label}.${key} must be a string.`);
    }
    output[key] = entry;
  }
  return output;
}

function planFields(value: unknown, label: string): PlanDraftField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_fields', `${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const field = requireObject(entry, `${label}[${index}]`);
    return {
      label: requiredString(field.label, `${label}[${index}].label`),
      value: requiredString(field.value, `${label}[${index}].value`),
    };
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_string_array', `${label} must be an array.`);
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

function coerceJsonObject(value: unknown, label: string): JsonObject {
  const object = requireObject(value, label);
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(object)) {
    output[key] = coerceJsonValue(entry, `${label}.${key}`);
  }
  return output;
}

function coerceJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowValidationError('invalid_json', `${label} must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => coerceJsonValue(entry, `${label}[${index}]`));
  }
  if (isPlainObject(value)) {
    return coerceJsonObject(value, label);
  }
  throw new WorkflowValidationError('invalid_json', `${label} must be JSON serializable.`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new WorkflowValidationError('invalid_object', `${label} must be an object.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalCluster(value: unknown, fallback: string): WorkflowCluster {
  return requireCluster(value === undefined || value === null || value === '' ? fallback : value, 'cluster');
}

function requireCluster(value: unknown, label: string): WorkflowCluster {
  const cluster = typeof value === 'string' ? value.trim() : value;
  if (typeof cluster !== 'string' || !WORKFLOW_CLUSTERS.includes(cluster as WorkflowCluster)) {
    throw new WorkflowValidationError(
      'invalid_cluster',
      `${label} must be one of: ${WORKFLOW_CLUSTERS.join(', ')}.`,
    );
  }
  return cluster as WorkflowCluster;
}

function requireRequiredCluster(value: unknown): WorkflowCluster {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new WorkflowValidationError('missing_field', 'cluster is required.');
  }
  return requireCluster(value, 'cluster');
}

function requiredEvidenceString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', `${label} must be a string.`);
  }
  return value;
}

function requiredEvidenceShortString(value: unknown, label: string): string {
  const trimmed = requiredEvidenceString(value, label).trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', `${label} is required.`);
  }
  if (trimmed.length > EVIDENCE_SHORT_FIELD_MAX_LENGTH) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${EVIDENCE_SHORT_FIELD_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

function optionalEvidenceShortString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = requiredEvidenceString(value, label).trim();
  if (!trimmed) return undefined;
  if (trimmed.length > EVIDENCE_SHORT_FIELD_MAX_LENGTH) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${EVIDENCE_SHORT_FIELD_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

function requiredEvidenceHash(value: unknown, label: string): string {
  const trimmed = requiredEvidenceString(value, label).trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', `${label} is required.`);
  }
  if (trimmed.length > EVIDENCE_HASH_MAX_LENGTH) {
    throw new WorkflowValidationError('field_too_long', `${label} must be at most ${EVIDENCE_HASH_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

function optionalEvidenceHash(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredEvidenceHash(value, label);
}

function requiredEvidenceSigningMessage(value: unknown): string {
  const text = requiredEvidenceString(value, 'signingMessage');
  if (!text.trim()) {
    throw new WorkflowValidationError('missing_field', 'signingMessage is required.');
  }
  if (text.length > EVIDENCE_SIGNING_MESSAGE_MAX_LENGTH) {
    throw new WorkflowValidationError('field_too_long', `signingMessage must be at most ${EVIDENCE_SIGNING_MESSAGE_MAX_LENGTH} characters.`);
  }
  return text;
}

function requiredEvidenceSignature(value: unknown): string {
  const trimmed = requiredEvidenceString(value, 'signature').trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', 'signature is required.');
  }
  if (trimmed.length > EVIDENCE_SIGNATURE_MAX_LENGTH) {
    throw new WorkflowValidationError('field_too_long', `signature must be at most ${EVIDENCE_SIGNATURE_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

function requireEvidenceReceiptKind(value: unknown): EvidenceReceiptKind {
  const kind = requiredEvidenceString(value, 'kind').trim();
  if (!EVIDENCE_RECEIPT_KINDS.includes(kind as EvidenceReceiptKind)) {
    throw new WorkflowValidationError(
      'invalid_kind',
      `kind must be one of ${EVIDENCE_RECEIPT_KINDS.join(', ')}.`,
    );
  }
  return kind as EvidenceReceiptKind;
}

function requireEvidenceReceiptStatus(value: unknown): EvidenceReceiptStatus {
  const status = requiredEvidenceString(value, 'status').trim();
  if (!EVIDENCE_RECEIPT_STATUSES.includes(status as EvidenceReceiptStatus)) {
    throw new WorkflowValidationError(
      'invalid_status',
      `status must be one of ${EVIDENCE_RECEIPT_STATUSES.join(', ')}.`,
    );
  }
  return status as EvidenceReceiptStatus;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RecurringValidationError('invalid_string', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new RecurringValidationError('invalid_integer', `${label} must be an integer.`);
  }
  return value as number;
}

function requireCadence(value: unknown): RecurringCadence {
  if (typeof value !== 'string' || !RECURRING_CADENCES.includes(value as RecurringCadence)) {
    throw new RecurringValidationError(
      'invalid_cadence',
      `cadence must be one of: ${RECURRING_CADENCES.join(', ')}.`,
    );
  }
  return value as RecurringCadence;
}

function requireScheduleStatus(value: unknown): RecurringScheduleStatus {
  if (typeof value !== 'string' || !RECURRING_SCHEDULE_STATUSES.includes(value as RecurringScheduleStatus)) {
    throw new RecurringValidationError(
      'invalid_status',
      `status must be one of: ${RECURRING_SCHEDULE_STATUSES.join(', ')}.`,
    );
  }
  return value as RecurringScheduleStatus;
}

function optionalStringField<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !value.trim()) {
    throw new RecurringValidationError('invalid_string', `${key} must be a non-empty string.`);
  }
  return { [key]: value.trim() } as Partial<Record<K, string>>;
}

function optionalIntegerField<K extends string>(value: unknown, key: K): Partial<Record<K, number>> {
  if (value === undefined || value === null || value === '') return {};
  return { [key]: requireInteger(value, key) } as Partial<Record<K, number>>;
}

function optionalJsonObjectField<K extends string>(value: unknown, key: K): Partial<Record<K, JsonObject>> {
  if (value === undefined) return {};
  return { [key]: requireJsonObject(value, key) } as Partial<Record<K, JsonObject>>;
}

function assertCadenceFields(request: CreateRecurringRequest | UpdateRecurringRequest): void {
  switch (request.cadence) {
    case 'weekly':
      if (request.dayOfWeek === undefined || !request.localTime) {
        throw new RecurringValidationError('missing_cadence_fields', 'weekly cadence requires dayOfWeek and localTime.');
      }
      if (request.dayOfWeek < 0 || request.dayOfWeek > 6) {
        throw new RecurringValidationError('invalid_day', 'dayOfWeek must be between 0 and 6.');
      }
      break;
    case 'monthly':
      if (request.dayOfMonth === undefined || !request.localTime) {
        throw new RecurringValidationError('missing_cadence_fields', 'monthly cadence requires dayOfMonth and localTime.');
      }
      if (request.dayOfMonth < 1 || request.dayOfMonth > 31) {
        throw new RecurringValidationError('invalid_day', 'dayOfMonth must be between 1 and 31.');
      }
      break;
    case 'interval_days':
      if (!Number.isInteger(request.intervalDays) || (request.intervalDays ?? 0) < 1) {
        throw new RecurringValidationError('invalid_interval', 'interval_days requires intervalDays >= 1.');
      }
      break;
    case 'interval_hours':
      if (!Number.isInteger(request.intervalHours) || (request.intervalHours ?? 0) < 1) {
        throw new RecurringValidationError('invalid_interval', 'interval_hours requires intervalHours >= 1.');
      }
      break;
    case 'interval_minutes':
      if (!Number.isInteger(request.intervalMinutes) || (request.intervalMinutes ?? 0) < 1) {
        throw new RecurringValidationError('invalid_interval', 'interval_minutes requires intervalMinutes >= 1.');
      }
      break;
  }
}

function indicatesUnlimitedAuthority(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    return normalized.includes('unlimited') || normalized.includes('delegate') || normalized.includes('any amount');
  }
  if (typeof value === 'number') return !Number.isFinite(value);
  return false;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
