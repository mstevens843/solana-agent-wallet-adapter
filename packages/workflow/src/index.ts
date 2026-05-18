export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export {
  clampedMonthlyDate,
  exhaustionReason,
  intervalKey,
  latestDueOccurrence,
  lifetimeSpendEstimate,
  monthlyKey,
  multiplyDecimalString,
  nextFutureOccurrence,
  parseLocalTime,
  previewUpcoming,
  recurringStartAt,
} from './cadence.js';
export type { CadenceFields, ExhaustionReason, LifetimeSpend, OccurrenceInfo } from './cadence.js';

export { formatOccurrenceStatus, formatScheduleStatus } from './labels.js';
export type { ApprovalSummaryHint, LabelTone, StatusLabel } from './labels.js';
// DevLayer1 (AP2/ACP/AgentCard/Bridge validators) lives at
// `@solana-agent-wallet-adapter/workflow/dev` because it transitively
// imports the `ap2-adapter`/`acp-adapter` packages, which depend on Node
// crypto and must not enter browser bundles. Server-side consumers import
// it via the subpath; browser consumers continue using the main barrel
// without pulling node:crypto into Vite/Rollup.
//   import * as DevLayer1 from '@solana-agent-wallet-adapter/workflow/dev';
export * from './agentPlans.js';
export * from './agentFactRouter.js';
export * from './agentEvidence.js';
export * from './agentEvidenceRequirements.js';
export * from './agentEvidenceGate.js';
export * from './agentAtoms.js';
export * from './agentCapabilityRegistry.js';
export * from './policyEvaluator.js';
export * from './policyOrchestrator.js';
export * from './txGates.js';
export * from './verifiedPrograms.js';
export * from './promptInjectionDefense.js';
export * from './confidence.js';
export * from './counterfactuals.js';
export * from './behavioralBaselines.js';
export * from './priceUsd.js';
export * from './deviceAgent.js';
export {
  appendReviewFinding,
  evidenceTextFields,
  expectedDecisionForThreshold,
  extractInstructionThreshold,
  extractThresholdPriceCandidates,
  extractThresholdRule,
  factLabelFromInstruction,
  formatDollar,
  reconcileThresholdReviewDecision,
  selectThresholdPriceCandidate,
} from './thresholdReview.js';
export type {
  EvidenceTextField,
  ReviewFinding,
  ThresholdPriceCandidate,
  ThresholdReviewTone,
  ThresholdRule,
} from './thresholdReview.js';

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
  'blink_action',
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

export const TRANSACTION_FINALIZATION_STATUSES = [
  'not_started',
  'prepared',
  'preview_ready',
  'simulation_passed',
  'wallet_pending',
  'submitted',
  'confirmed',
  'failed',
  'aborted',
  'expired',
  'blocked',
] as const;
export type TransactionFinalizationStatus = (typeof TRANSACTION_FINALIZATION_STATUSES)[number];

export const RECURRING_CADENCES = ['weekly', 'monthly', 'interval_days', 'interval_hours', 'interval_minutes'] as const;
export type RecurringCadence = (typeof RECURRING_CADENCES)[number];

export const RECURRING_SCHEDULE_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type RecurringScheduleStatus = (typeof RECURRING_SCHEDULE_STATUSES)[number];

export const RECURRING_CREATE_SCHEDULE_STATUSES = ['active', 'paused'] as const;
export type CreateRecurringScheduleStatus = (typeof RECURRING_CREATE_SCHEDULE_STATUSES)[number];

export const RECURRING_ACTION_KINDS = ['transfer', 'swap'] as const;
export type RecurringActionKind = (typeof RECURRING_ACTION_KINDS)[number];

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

export const RECURRING_AGENT_REVIEW_STATUSES = ['checking', 'approved', 'denied', 'needs_input', 'error'] as const;
export type RecurringAgentReviewStatus = (typeof RECURRING_AGENT_REVIEW_STATUSES)[number];

export const RECURRING_AGENT_REVIEW_DECISIONS = ['approve', 'deny', 'needs_input', ''] as const;
export type RecurringAgentReviewDecision = (typeof RECURRING_AGENT_REVIEW_DECISIONS)[number];

export const EVIDENCE_RECEIPT_KINDS = [
  'review_proof',
  'intent_receipt',
  'policy_receipt',
  'risk_review_receipt',
  'rejection_receipt',
  'tool_trace_receipt',
  'agent_override_receipt',
  'acp_outbound',
  'ap2_inbound',
  'mpp_session',
  'streaming_session_grant',
  'streaming_voucher',
  'streaming_settlement',
] as const;
export type EvidenceReceiptKind = (typeof EVIDENCE_RECEIPT_KINDS)[number];

export const STREAMING_SESSION_STATUSES = ['pending', 'active', 'expired', 'revoked', 'settled'] as const;
export type StreamingSessionStatus = (typeof STREAMING_SESSION_STATUSES)[number];

export interface StreamingSessionRecord {
  id: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  tokenMint: string;
  delegatePubkey: string;
  ephemeralSignerPubkey: string;
  capAmount: string;
  spentAmount: string;
  expiresAt: string;
  status: StreamingSessionStatus;
  /**
   * Optional whitelist of accepted voucher recipients. `undefined` or empty
   * array means "allow ANY recipient"; populated array is a strict whitelist
   * enforced server-side by `acceptVoucher` and on the library side by
   * `validateVoucher`. Mirror of `SessionGrant.recipientAllowlist` in
   * `@solana-agent-wallet-adapter/streaming-sessions`.
   */
  recipientAllowlist?: readonly string[];
  approveTxid?: string;
  revokeTxid?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface StreamingVoucherRecord {
  id: string;
  sessionId: string;
  nonce: string;
  amount: string;
  recipient: string;
  voucherHash: string;
  signature: string;
  issuedAt: string;
  createdAt: string;
  settledAt?: string;
  settlementTxid?: string;
  // Metadata is an opaque key/value bag. Use Record<string, unknown> so app-side
  // extensions can pass arbitrary structured payloads (e.g. base64 byte buffers,
  // protocol-specific receipts) that don't fit the strict JsonValue tree.
  metadata?: Record<string, unknown>;
}

export const MPP_SESSION_PAYMENT_FINALITIES = ['voucher_accepted', 'settlement_confirmed'] as const;
export type MppSessionPaymentFinality = (typeof MPP_SESSION_PAYMENT_FINALITIES)[number];

export const MPP_SESSION_PAYMENT_STATUSES = [
  'voucher_accepted',
  'settlement_pending',
  'settlement_confirmed',
  'failed',
] as const;
export type MppSessionPaymentStatus = (typeof MPP_SESSION_PAYMENT_STATUSES)[number];

export interface MppSessionPaymentLink {
  approvalId: string;
  challengeHash: string;
  sessionId: string;
  voucherId: string;
  voucherHash: string;
  amount: string;
  recipient: string;
  tokenMint: string;
  cluster: WorkflowCluster;
  finality: MppSessionPaymentFinality;
  status: MppSessionPaymentStatus;
  createdAt: string;
  updatedAt: string;
  receiptId?: string;
  receiptHash?: string;
  settlementTxid?: string;
  settledAt?: string;
  error?: string;
  policy?: JsonObject;
}

export interface MppSessionPolicy {
  allowedMerchantIds?: string[];
  allowedMerchantOrigins?: string[];
  allowedMerchantUrls?: string[];
  allowedResourceOrigins?: string[];
  allowedResourceUrls?: string[];
  allowedOrigins?: string[];
  allowedRecipients?: string[];
  maxAmount?: string;
  requireSettlementConfirmed?: boolean;
}

export interface MppSessionPolicyResult {
  allowed: boolean;
  reasonCode?: string;
  reason?: string;
  merchantId?: string;
  merchantOrigin?: string;
  merchantUrl?: string;
  resourceOrigin?: string;
  resourceUrl?: string;
  recipient?: string;
  amount?: string;
  maxAmount?: string;
  requireSettlementConfirmed?: boolean;
}

export interface StreamingSettlementRecord {
  id: string;
  sessionId: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  totalAmount: string;
  voucherCount: number;
  txid?: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  createdAt: string;
  updatedAt: string;
  receiptId?: string;
}

export const AUDIT_ACTORS = ['user', 'wallet', 'server', 'system'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AI_GUARDRAIL_VERDICTS = ['pass', 'warn', 'block'] as const;
export type AiGuardrailVerdict = (typeof AI_GUARDRAIL_VERDICTS)[number];
export type AiGuardrailViolationSeverity = 'warn' | 'block';

export type FinalizationRequirement =
  | 'none'
  | 'wallet_decision_proof'
  | 'transaction_preview';

export const FINALIZATION_REQUIREMENTS = ['none', 'wallet_decision_proof', 'transaction_preview'] as const;

export const EXECUTION_MODES = ['proof_only', 'wallet_execute', 'unsupported'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface FinalizationSupport {
  required: boolean;
  supported: boolean;
  reason?: string;
}

export interface AiGuardrailViolation {
  code: string;
  severity: AiGuardrailViolationSeverity;
  message: string;
  path?: string;
}

export interface PlanConstraintSnapshot {
  source: string;
  category: string;
  actionType: string;
  templateId: string;
  templateTitle: string;
  cluster: string;
  parameters: Record<string, string>;
  fields: PlanDraftField[];
  userNotes?: string;
}

export interface AiGuardrailReport {
  verdict: AiGuardrailVerdict;
  source: string;
  actionType: string;
  finalizationRequirement: FinalizationRequirement;
  constraintFingerprint: string;
  constraintHash?: string;
  violations: AiGuardrailViolation[];
  summary: string;
}

export interface FinalizationPreviewRecord {
  id: string;
  approvalRequestId: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  actionType: string;
  status: 'ready' | 'blocked' | 'expired';
  createdAt: string;
  expiresAt: string;
  constraintFingerprint: string;
  transactionFingerprint?: string;
  transactionBase64?: string;
  simulationSummary?: JsonObject;
  quoteSummary?: JsonObject;
  walletActionRows: Array<[string, string]>;
  guardrailReport?: AiGuardrailReport;
  metadata?: JsonObject;
}

export interface FinalizationReceipt {
  previewId: string;
  approvalRequestId: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  actionType: string;
  status: TxStatus | 'signed';
  constraintFingerprint: string;
  transactionFingerprint?: string;
  signature?: string;
  txid?: string;
  explorerUrl?: string;
  simulationSummary?: JsonObject;
  quoteSummary?: JsonObject;
  walletActionRows: Array<[string, string]>;
  guardrailReport?: AiGuardrailReport;
  createdAt: string;
  metadata?: JsonObject;
}

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
  finalizationRequirement?: FinalizationRequirement;
  executionMode?: ExecutionMode;
  finalizationSupport?: FinalizationSupport;
  proofSignature?: string;
  decisionProofSignature?: string;
  decisionProofMessage?: string;
  decisionProofVerified?: boolean;
  archived?: boolean;
  archivedAt?: string;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface WalletActionPreview {
  kind: string;
  walletAddress: string;
  cluster: WorkflowCluster;
  summary: string;
  sender?: string;
  recipient?: string;
  amount?: string;
  token?: string;
  mint?: string;
  feePayer?: string;
  estimatedFeeLamports?: string;
  memo?: string;
  instructionSummary: string[];
  touchedPrograms: string[];
  metadata?: JsonObject;
}

export interface QuoteSnapshot {
  provider: string;
  fetchedAt: string;
  requestId?: string;
  inputToken?: string;
  inputMint?: string;
  inputAmount?: string;
  outputToken?: string;
  outputMint?: string;
  expectedOutputAmount?: string;
  minimumOutputAmount?: string;
  slippageBps?: number;
  priceImpact?: string;
  routeLabel?: string;
  quoteHash: string;
  metadata?: JsonObject;
}

export interface SimulationSnapshot {
  status: 'ok' | 'failed' | 'unsupported';
  simulatedAt: string;
  err?: JsonValue;
  logs: string[];
  unitsConsumed?: number;
  simulationHash: string;
  metadata?: JsonObject;
}

export interface TransactionFinalizationRecord {
  id: string;
  walletAddress: string;
  approvalRequestId: string;
  planDraftId?: string;
  kind: string;
  status: TransactionFinalizationStatus;
  cluster: WorkflowCluster;
  walletAction: WalletActionPreview;
  transactionHash: string;
  messageHash?: string;
  quote?: QuoteSnapshot;
  simulation?: SimulationSnapshot;
  txid?: string;
  txStatus?: TxStatus;
  confirmationStatus?: string;
  explorerUrl?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  recurringScheduleId?: string;
  recurringOccurrenceId?: string;
  occurrenceKey?: string;
  metadata?: JsonObject;
}

export interface RecurringScheduleRecord {
  id: string;
  status: RecurringScheduleStatus;
  walletAddress: string;
  cluster: WorkflowCluster;
  actionKind?: RecurringActionKind;
  token: string;
  inputToken?: string;
  outputToken?: string;
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
  expiresAt?: string;
  notifications?: RecurringNotificationsConfig;
  riskMetadata?: JsonObject;
  metadata?: JsonObject;
}

export interface RecurringNotificationsConfig {
  inApp?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
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

export type RecurringAgentReviewMetadata = JsonObject & {
  agentReview?: JsonObject;
  agentReviewStatus?: RecurringAgentReviewStatus;
  agentReviewDecision?: RecurringAgentReviewDecision;
  agentReviewCheckedAt?: string;
  agentReviewProvider?: string;
  agentReviewModel?: string;
};

export type ConnectorWorkflowMetadata = JsonObject & {
  connectorId?: string;
  connectorName?: string;
  capability?: string;
  operation?: string;
  market?: string;
  pool?: string;
  reserve?: string;
  readiness?: JsonValue;
  factLabels?: string[];
  actionSource?: string;
  actionProposal?: JsonObject;
  approvalBoundary?: string;
};

export type WorkflowMetadata = JsonObject & RecurringAgentReviewMetadata & ConnectorWorkflowMetadata;

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
  txStatus?: TxStatus;
  confirmationStatus?: string;
  finalizationId?: string;
  transactionHash?: string;
  messageHash?: string;
  quoteHash?: string;
  simulationHash?: string;
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
  recordType?: 'plan' | 'approval' | 'completed' | 'evidence' | 'signal_feed' | 'signal_emission' | 'signal_subscription' | 'skill_execution';
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
  metadata?: WorkflowMetadata;
}
export type CreateApprovalInput = CreateApprovalRequest;

export interface ApprovalDecisionInput {
  proofSignature?: string;
  decisionProofSignature?: string;
  decisionProofMessage?: string;
  signatureEncoding?: 'base58' | 'base64';
  /**
   * Phantom Mobile MWA cannot signMessage; FE falls back to a memo-only
   * throwaway transaction. When set to 'tx-memo-proof', `decisionProofTxBase64`
   * carries the signed tx bytes so the server can verify the signature against
   * the compiled tx message (memo data == decisionProofMessage).
   */
  decisionProofEncoding?: 'utf8-message' | 'tx-memo-proof';
  decisionProofTxBase64?: string;
  note?: string;
  txid?: string;
  explorerUrl?: string;
  error?: string;
  txStatus?: TxStatus;
  confirmationStatus?: string;
  finalizationId?: string;
  transactionHash?: string;
  messageHash?: string;
  quoteHash?: string;
  simulationHash?: string;
  finalizationStatus?: TransactionFinalizationStatus;
  metadata?: JsonObject;
}

export interface ApprovalListResponse {
  approvals: ApprovalRequestRecord[];
}

export interface CreateRecurringRequest {
  status?: CreateRecurringScheduleStatus;
  cluster: WorkflowCluster;
  actionKind?: RecurringActionKind;
  token: string;
  inputToken?: string;
  outputToken?: string;
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
  expiresAt?: string;
  notifications?: RecurringNotificationsConfig;
  riskMetadata?: JsonObject;
  metadata?: WorkflowMetadata;
}

export interface UpdateRecurringRequest {
  status?: RecurringScheduleStatus;
  cluster?: WorkflowCluster;
  actionKind?: RecurringActionKind;
  token?: string;
  inputToken?: string;
  outputToken?: string;
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
  expiresAt?: string;
  notifications?: RecurringNotificationsConfig;
  riskMetadata?: JsonObject;
  metadata?: WorkflowMetadata;
}

export interface RecurringListResponse {
  schedules: RecurringScheduleRecord[];
  occurrences: RecurringOccurrenceRecord[];
}

export interface MaterializeResult {
  scheduleId: string;
  occurrenceKey?: string;
  occurrenceId?: string;
  reason: 'created' | 'duplicate' | 'pending_approval' | 'paused' | 'completed' | 'cancelled' | 'not_due' | 'invalid';
}

export interface MaterializeResponse {
  results: MaterializeResult[];
}

export interface CompletedListResponse {
  completed: CompletedRecord[];
}

export interface TransactionFinalizationListResponse {
  finalizations: TransactionFinalizationRecord[];
}

export interface CreateTransactionFinalizationPreviewRequest {
  status?: Extract<TransactionFinalizationStatus, 'prepared' | 'preview_ready' | 'simulation_passed' | 'blocked' | 'expired'>;
  walletAction: WalletActionPreview;
  transactionHash: string;
  messageHash?: string;
  quote?: QuoteSnapshot;
  simulation?: SimulationSnapshot;
  expiresAt?: string;
  metadata?: JsonObject;
}
export type CreateTransactionFinalizationPreviewInput = CreateTransactionFinalizationPreviewRequest;

export interface RecordTransactionFinalizationResultRequest extends ApprovalDecisionInput {
  finalizationId: string;
  finalizationStatus?: Extract<TransactionFinalizationStatus, 'wallet_pending' | 'submitted' | 'confirmed' | 'failed' | 'aborted' | 'expired' | 'blocked'>;
}
export type RecordTransactionFinalizationResultInput = RecordTransactionFinalizationResultRequest;

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

export function evaluatePlanGuardrails(input: {
  plan?: JsonObject | Record<string, unknown>;
  source?: string;
  category?: string;
  actionType?: string;
  templateId?: string;
  templateTitle?: string;
  cluster?: string;
  parameters?: Record<string, string>;
  fields?: PlanDraftField[];
  userNotes?: string;
  prompt?: string;
}): AiGuardrailReport {
  const plan = isPlainRecord(input.plan) ? input.plan : {};
  const parameters = normalizeStringRecord(input.parameters ?? valueRecord(plan.parameters));
  const fields = normalizePlanFields(input.fields ?? plan.fields);
  const source = stringValue(input.source) ?? stringValue(plan.source) ?? 'template';
  const category = stringValue(input.category) ?? stringValue(plan.category) ?? 'custom';
  const actionType = stringValue(input.actionType) ?? stringValue(plan.actionType) ?? 'manual_review';
  const templateId = stringValue(input.templateId) ?? stringValue(plan.templateId) ?? '';
  const templateTitle = stringValue(input.templateTitle) ?? stringValue(plan.templateTitle) ?? '';
  const cluster = stringValue(input.cluster) ?? stringValue(plan.cluster) ?? 'devnet';
  const userNotes = stringValue(input.userNotes) ?? stringValue(plan.userNotes) ?? '';
  const prompt = stringValue(input.prompt) ?? stringValue(plan.prompt) ?? '';
  const violations: AiGuardrailViolation[] = [];

  collectForbiddenGuardrailViolations({
    value: {
      ...plan,
      ...(input.prompt !== undefined ? { prompt } : {}),
      ...(input.userNotes !== undefined ? { userNotes } : {}),
    },
    path: '$.plan',
    violations,
  });

  collectUnsafeAiClaimViolations({
    value: {
      intent: plan.intent,
      route: plan.route,
      risk: plan.risk,
      approval: plan.approval,
      safeguards: plan.safeguards,
      prompt,
      userNotes,
      parameters,
      fields,
    },
    path: '$.plan',
    source,
    violations,
  });

  if (isQueueableWorkflowAction(actionType)) {
    collectMissingConstraintViolations(actionType, parameters, violations);
  }

  if (source === 'ai') {
    collectAiWarningViolations(plan, actionType, parameters, violations);
  }

  const finalizationRequirement = finalizationRequirementForAction(actionType);
  const constraintSnapshot = planConstraintSnapshot({
    source,
    category,
    actionType,
    templateId,
    templateTitle,
    cluster,
    parameters,
    fields,
    userNotes,
  });
  const constraintFingerprint = stableWorkflowFingerprint(constraintSnapshot);
  const constraintHash = stableWorkflowHash(constraintSnapshot);
  const verdict: AiGuardrailVerdict = violations.some((violation) => violation.severity === 'block')
    ? 'block'
    : violations.some((violation) => violation.severity === 'warn')
      ? 'warn'
      : 'pass';

  return {
    verdict,
    source,
    actionType,
    finalizationRequirement,
    constraintFingerprint,
    constraintHash,
    violations,
    summary: guardrailSummary(verdict, finalizationRequirement, violations),
  };
}

export function assertPlanGuardrails(
  input: Parameters<typeof evaluatePlanGuardrails>[0],
): AiGuardrailReport {
  const report = evaluatePlanGuardrails(input);
  if (report.verdict === 'block') {
    const first = report.violations.find((violation) => violation.severity === 'block');
    throw new WorkflowValidationError(
      'ai_guardrail_blocked',
      first?.message ?? 'Plan is blocked by Agentic AI guardrails.',
      first?.path,
    );
  }
  return report;
}

export function planConstraintSnapshot(input: {
  source?: string;
  category?: string;
  actionType?: string;
  templateId?: string;
  templateTitle?: string;
  cluster?: string;
  parameters?: Record<string, string>;
  fields?: PlanDraftField[];
  userNotes?: string;
}): PlanConstraintSnapshot {
  return {
    source: input.source ?? 'template',
    category: input.category ?? 'custom',
    actionType: input.actionType ?? 'manual_review',
    templateId: input.templateId ?? '',
    templateTitle: input.templateTitle ?? '',
    cluster: input.cluster ?? 'devnet',
    parameters: normalizeStringRecord(input.parameters),
    fields: normalizePlanFields(input.fields),
    ...(input.userNotes ? { userNotes: input.userNotes } : {}),
  };
}

export function stableWorkflowFingerprint(value: unknown): string {
  const serialized = stableJson(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `wf_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function stableWorkflowHash(value: unknown): string {
  return sha256Hex(stableJson(value));
}

export function isQueueableWorkflowAction(actionType: string): boolean {
  return actionType === 'transfer_sol' ||
    actionType === 'transfer_spl' ||
    actionType === 'swap' ||
    actionType === 'recurring_payment' ||
    actionType === 'blink_action';
}

export function finalizationRequirementForAction(actionType: string): FinalizationRequirement {
  if (
    actionType === 'transfer_sol' ||
    actionType === 'transfer_spl' ||
    actionType === 'swap' ||
    actionType === 'custom_transaction' ||
    actionType === 'blink_action'
  ) {
    return 'transaction_preview';
  }
  if (actionType === 'recurring_payment') {
    return 'wallet_decision_proof';
  }
  if (actionType === 'manual_review') {
    return 'wallet_decision_proof';
  }
  return 'none';
}

export function requiresTransactionFinalization(kind: string): boolean {
  return finalizationRequirementForAction(kind) === 'transaction_preview';
}

export function workflowDecisionProofMessage(input: {
  approval: Pick<ApprovalRequestRecord, 'id' | 'walletAddress' | 'cluster' | 'summary' | 'kind' | 'params'>;
  decision: Extract<ApprovalDecision, 'approved' | 'rejected'>;
}): string {
  return [
    'Agentic Cloud workflow decision',
    `Decision: ${input.decision}`,
    `Approval: ${input.approval.id}`,
    `Wallet: ${input.approval.walletAddress}`,
    `Cluster: ${input.approval.cluster ?? 'devnet'}`,
    `Summary: ${input.approval.summary}`,
    `Kind: ${input.approval.kind}`,
    `Params: ${stableJson(input.approval.params)}`,
    'This signature records a cloud workflow decision only. It does not submit a transaction or grant spending authority.',
  ].join('\n');
}

export function workflowFinalizationProofMessage(input: {
  approval: Pick<ApprovalRequestRecord, 'id' | 'walletAddress' | 'cluster' | 'summary' | 'kind' | 'params'>;
  finalization: Pick<TransactionFinalizationRecord, 'id' | 'transactionHash' | 'messageHash' | 'quote' | 'simulation' | 'walletAction' | 'metadata'>;
}): string {
  const quoteHash = input.finalization.quote?.quoteHash ?? '';
  const simulationHash = input.finalization.simulation?.simulationHash ?? '';
  const constraintHash = stringFromJson(input.finalization.metadata, 'constraintHash') ?? '';
  return [
    'Agentic Cloud transaction finalization',
    'Decision: approved',
    `Approval: ${input.approval.id}`,
    `Finalization: ${input.finalization.id}`,
    `Wallet: ${input.approval.walletAddress}`,
    `Cluster: ${input.approval.cluster ?? 'devnet'}`,
    `Summary: ${input.approval.summary}`,
    `Kind: ${input.approval.kind}`,
    `Params: ${stableJson(input.approval.params)}`,
    `Transaction hash: ${input.finalization.transactionHash}`,
    `Message hash: ${input.finalization.messageHash ?? ''}`,
    `Quote hash: ${quoteHash}`,
    `Simulation hash: ${simulationHash}`,
    `Constraint hash: ${constraintHash}`,
    `Wallet action: ${stableJson(input.finalization.walletAction)}`,
    'This signature approves only this reviewed transaction boundary. It does not grant custody, delegated authority, or unlimited signing rights.',
  ].join('\n');
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

export interface CompletedPlanProofOptions {
  id: string;
  completedAt: string;
}

export function completedRecordFromPlanProof(
  plan: PlanDraftRecord,
  options: CompletedPlanProofOptions,
): CompletedRecord {
  if (plan.status !== 'signed' || !plan.signature) {
    throw new WorkflowValidationError(
      'plan_not_signed',
      'Plan must be signed before it can become completed proof history.',
      'plan.status',
    );
  }
  const signedProof = jsonObjectFromJson(plan.metadata, 'signedProof');
  const connectorRead = jsonObjectFromJson(plan.metadata, 'connectorRead');
  const proofMessage = stringFromJson(signedProof, 'message');
  const proofMessageHash = stringFromJson(signedProof, 'messageHash') ??
    (proofMessage ? stableWorkflowHash(proofMessage) : undefined);
  const connectorReadSummary = stringFromJson(connectorRead, 'resultSummary');
  const connectorId = stringFromJson(connectorRead, 'connectorId');
  const connectorCapability = stringFromJson(connectorRead, 'capability');
  const connectorQuestion = stringFromJson(connectorRead, 'question');
  const amount = firstStringParam({ ...plan.parameters }, ['amountSol', 'amount', 'inputAmount', 'plannedAmount']);
  const token = firstStringParam({ ...plan.parameters }, ['token', 'inputToken', 'outputToken', 'priceFeedIdsLabel', 'priceFeedIdLabel']);
  const recipient = firstStringParam({ ...plan.parameters }, ['recipient', 'recipientAddress']);
  const metadata: JsonObject = {
    ...(plan.metadata ? { ...plan.metadata } : {}),
    signedProof: {
      ...(signedProof ?? {}),
      ...(proofMessageHash ? { messageHash: proofMessageHash } : {}),
    },
  };
  const copyPayload: JsonObject = {
    type: connectorRead ? 'signed_connector_read_receipt' : 'signed_plan_review_proof',
    planDraftId: plan.id,
    status: 'proof signed',
    title: plan.intent,
    walletAddress: plan.walletAddress,
    cluster: plan.cluster,
    completedAt: options.completedAt,
    signature: plan.signature,
    ...(proofMessageHash ? { proofMessageHash } : {}),
    ...(connectorRead ? { connectorRead } : {}),
  };
  return {
    id: options.id,
    kind: 'one_time',
    status: 'proof signed',
    title: plan.intent,
    summary: connectorReadSummary ?? plan.userNotes ?? plan.approval ?? plan.intent,
    walletAddress: plan.walletAddress,
    createdAt: plan.createdAt,
    completedAt: options.completedAt,
    cluster: plan.cluster,
    ...(amount ? { amount } : {}),
    ...(token ? { token } : {}),
    ...(recipient ? { recipient } : {}),
    signature: plan.signature,
    proofSignature: plan.signature,
    planDraftId: plan.id,
    copyPayload,
    detailRows: completedRows([
      ['Type', connectorRead ? 'Signed connector read' : 'Signed review proof'],
      ['Status', 'proof signed'],
      ['Plan id', plan.id],
      ['Wallet', plan.walletAddress],
      ['Template', plan.templateTitle],
      ['Action', plan.actionType.replace(/_/g, ' ')],
      connectorId ? ['Connector', connectorId] : undefined,
      connectorCapability ? ['Read capability', connectorCapability] : undefined,
      connectorQuestion ? ['Question', connectorQuestion] : undefined,
      connectorReadSummary ? ['Result', connectorReadSummary] : undefined,
      ['Created', plan.createdAt],
      ['Completed', options.completedAt],
      ['Review proof', plan.signature],
      proofMessageHash ? ['Signed message hash', proofMessageHash] : undefined,
    ]),
    payload: {
      type: connectorRead ? 'connector_read' : 'plan_review_proof',
      planDraftId: plan.id,
      status: 'proof signed',
      signature: plan.signature,
      ...(proofMessageHash ? { proofMessageHash } : {}),
      ...(metadata.signedProof ? { signedProof: metadata.signedProof } : {}),
      params: { ...plan.parameters },
      ...(connectorRead ? { connectorRead } : {}),
    },
    metadata,
  };
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
  const finalization = jsonObjectFromJson(approval.metadata, 'finalization');
  const finalizationMetadata = jsonObjectFromJson(finalization, 'metadata');
  const finalizationId = stringFromJson(finalization, 'id') ?? stringFromJson(finalization, 'finalizationId');
  const transactionHash = stringFromJson(finalization, 'transactionHash');
  const messageHash = stringFromJson(finalization, 'messageHash');
  const quote = jsonObjectFromJson(finalization, 'quote');
  const simulation = jsonObjectFromJson(finalization, 'simulation');
  const quoteHash = stringFromJson(finalization, 'quoteHash') ?? stringFromJson(quote, 'quoteHash');
  const simulationHash = stringFromJson(finalization, 'simulationHash') ?? stringFromJson(simulation, 'simulationHash');
  const confirmationStatus = stringFromJson(finalization, 'confirmationStatus');
  const txStatus = workflowTxStatus(stringFromJson(finalization, 'txStatus') ?? approval.txStatus);
  const aiGuardrails = jsonObjectFromJson(finalizationMetadata, 'aiGuardrails') ?? jsonObjectFromJson(approval.riskMetadata, 'aiGuardrails');
  const guardrailVerdict = stringFromJson(finalizationMetadata, 'guardrailVerdict') ?? stringFromJson(approval.riskMetadata, 'guardrailVerdict');
  const finalizationRequirement = stringFromJson(finalizationMetadata, 'finalizationRequirement') ??
    stringFromJson(approval.riskMetadata, 'finalizationRequirement');
  const constraintFingerprint = stringFromJson(finalizationMetadata, 'constraintFingerprint') ??
    stringFromJson(approval.riskMetadata, 'constraintFingerprint');
  const constraintHash = stringFromJson(finalizationMetadata, 'constraintHash') ?? stringFromJson(approval.riskMetadata, 'constraintHash');
  const receiptMetadata: JsonObject = {
    ...(finalization ? { finalization } : {}),
    ...(aiGuardrails ? { aiGuardrails } : {}),
    ...(guardrailVerdict ? { guardrailVerdict } : {}),
    ...(finalizationRequirement ? { finalizationRequirement } : {}),
    ...(constraintFingerprint ? { constraintFingerprint } : {}),
    ...(constraintHash ? { constraintHash } : {}),
    ...(approval.decisionProofMessage ? { decisionProofMessage: approval.decisionProofMessage } : {}),
    ...(approval.decisionProofVerified !== undefined ? { decisionProofVerified: approval.decisionProofVerified } : {}),
  };
  const copyPayload: JsonObject = {
    type: finalizationId
      ? recurring ? 'completed_recurring_transaction' : 'completed_one_time_transaction'
      : recurring ? 'completed_recurring_occurrence' : 'completed_one_time_approval',
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
    ...(txStatus ? { txStatus } : {}),
    ...(confirmationStatus ? { confirmationStatus } : {}),
    ...(finalizationId ? { finalizationId } : {}),
    ...(transactionHash ? { transactionHash } : {}),
    ...(messageHash ? { messageHash } : {}),
    ...(quoteHash ? { quoteHash } : {}),
    ...(simulationHash ? { simulationHash } : {}),
    ...(guardrailVerdict ? { guardrailVerdict } : {}),
    ...(finalizationRequirement ? { finalizationRequirement } : {}),
    ...(constraintFingerprint ? { constraintFingerprint } : {}),
    ...(constraintHash ? { constraintHash } : {}),
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
    ...(Object.keys(receiptMetadata).length ? { metadata: receiptMetadata } : {}),
    ...(approval.txid !== undefined && { txid: approval.txid }),
    ...(txStatus !== undefined && { txStatus }),
    ...(confirmationStatus !== undefined && { confirmationStatus }),
    ...(finalizationId !== undefined && { finalizationId }),
    ...(transactionHash !== undefined && { transactionHash }),
    ...(messageHash !== undefined && { messageHash }),
    ...(quoteHash !== undefined && { quoteHash }),
    ...(simulationHash !== undefined && { simulationHash }),
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
      finalizationId ? ['Finalization id', finalizationId] : undefined,
      transactionHash ? ['Transaction hash', transactionHash] : undefined,
      quoteHash ? ['Quote hash', quoteHash] : undefined,
      simulationHash ? ['Simulation hash', simulationHash] : undefined,
      guardrailVerdict ? ['Guardrail verdict', guardrailVerdict] : undefined,
      finalizationRequirement ? ['Finalization requirement', finalizationRequirement] : undefined,
      constraintHash ? ['Constraint hash', constraintHash] : undefined,
      !constraintHash && constraintFingerprint ? ['Constraint fingerprint', constraintFingerprint] : undefined,
      approval.txid ? ['Transaction', approval.txid] : undefined,
      txStatus ? ['Transaction status', txStatus] : undefined,
      confirmationStatus ? ['Confirmation status', confirmationStatus] : undefined,
      approval.error ? ['Error', approval.error] : undefined,
    ]),
    payload: {
      type: finalizationId
        ? recurring ? 'recurring_transaction' : 'one_time_transaction'
        : recurring ? 'recurring_occurrence' : 'one_time',
      approvalRequestId: approval.id,
      status: approval.status,
      params: approval.params,
      ...(finalization ? { finalization } : {}),
      ...(aiGuardrails ? { aiGuardrails } : {}),
      ...(guardrailVerdict ? { guardrailVerdict } : {}),
      ...(finalizationRequirement ? { finalizationRequirement } : {}),
      ...(constraintFingerprint ? { constraintFingerprint } : {}),
      ...(constraintHash ? { constraintHash } : {}),
    },
  };
}

export function completedFromApproval(approval: ApprovalRequestRecord): CompletedRecord {
  return completedRecordFromApproval(approval, {
    id: `completed:${approval.id}`,
    completedAt: approval.confirmedAt ?? approval.decidedAt ?? approval.updatedAt,
  });
}

export function completedFromPlanProof(plan: PlanDraftRecord): CompletedRecord {
  return completedRecordFromPlanProof(plan, {
    id: `completed:plan:${plan.id}`,
    completedAt: plan.updatedAt,
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
    ...optionalEnumProp(record, 'finalizationRequirement', FINALIZATION_REQUIREMENTS, path),
    ...optionalEnumProp(record, 'executionMode', EXECUTION_MODES, path),
    ...optionalFinalizationSupportProp(record, 'finalizationSupport', path),
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

export function parseWalletActionPreview(input: unknown, path = '$'): WalletActionPreview {
  const record = expectRecord(input, path);
  return {
    kind: expectString(record, 'kind', path),
    walletAddress: expectString(record, 'walletAddress', path),
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    summary: expectString(record, 'summary', path),
    ...optionalStringProp(record, 'sender', path),
    ...optionalStringProp(record, 'recipient', path),
    ...optionalStringProp(record, 'amount', path),
    ...optionalStringProp(record, 'token', path),
    ...optionalStringProp(record, 'mint', path),
    ...optionalStringProp(record, 'feePayer', path),
    ...optionalStringProp(record, 'estimatedFeeLamports', path),
    ...optionalStringProp(record, 'memo', path),
    instructionSummary: record.instructionSummary === undefined ? [] : expectStringArray(record, 'instructionSummary', path),
    touchedPrograms: record.touchedPrograms === undefined ? [] : expectStringArray(record, 'touchedPrograms', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseQuoteSnapshot(input: unknown, path = '$'): QuoteSnapshot {
  const record = expectRecord(input, path);
  return {
    provider: expectString(record, 'provider', path),
    fetchedAt: expectString(record, 'fetchedAt', path),
    ...optionalStringProp(record, 'requestId', path),
    ...optionalStringProp(record, 'inputToken', path),
    ...optionalStringProp(record, 'inputMint', path),
    ...optionalStringProp(record, 'inputAmount', path),
    ...optionalStringProp(record, 'outputToken', path),
    ...optionalStringProp(record, 'outputMint', path),
    ...optionalStringProp(record, 'expectedOutputAmount', path),
    ...optionalStringProp(record, 'minimumOutputAmount', path),
    ...optionalIntegerProp(record, 'slippageBps', path),
    ...optionalStringProp(record, 'priceImpact', path),
    ...optionalStringProp(record, 'routeLabel', path),
    quoteHash: expectString(record, 'quoteHash', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseSimulationSnapshot(input: unknown, path = '$'): SimulationSnapshot {
  const record = expectRecord(input, path);
  return {
    status: expectEnum(record, 'status', ['ok', 'failed', 'unsupported'] as const, path),
    simulatedAt: expectString(record, 'simulatedAt', path),
    ...(record.err === undefined ? {} : { err: parseJsonValue(record.err, `${path}.err`) }),
    logs: record.logs === undefined ? [] : expectStringArray(record, 'logs', path),
    ...optionalIntegerProp(record, 'unitsConsumed', path),
    simulationHash: expectString(record, 'simulationHash', path),
    ...optionalJsonObjectProp(record, 'metadata', path),
  };
}

export function parseTransactionFinalizationRecord(input: unknown, path = '$'): TransactionFinalizationRecord {
  const record = expectRecord(input, path);
  return {
    id: expectString(record, 'id', path),
    walletAddress: expectString(record, 'walletAddress', path),
    approvalRequestId: expectString(record, 'approvalRequestId', path),
    ...optionalStringProp(record, 'planDraftId', path),
    kind: expectString(record, 'kind', path),
    status: expectEnum(record, 'status', TRANSACTION_FINALIZATION_STATUSES, path),
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    walletAction: parseWalletActionPreview(expectRequired(record, 'walletAction', path), `${path}.walletAction`),
    transactionHash: expectString(record, 'transactionHash', path),
    ...optionalStringProp(record, 'messageHash', path),
    ...(record.quote === undefined ? {} : { quote: parseQuoteSnapshot(record.quote, `${path}.quote`) }),
    ...(record.simulation === undefined ? {} : { simulation: parseSimulationSnapshot(record.simulation, `${path}.simulation`) }),
    ...optionalStringProp(record, 'txid', path),
    ...optionalEnumProp(record, 'txStatus', TX_STATUSES, path),
    ...optionalStringProp(record, 'confirmationStatus', path),
    ...optionalStringProp(record, 'explorerUrl', path),
    ...optionalStringProp(record, 'error', path),
    createdAt: expectString(record, 'createdAt', path),
    updatedAt: expectString(record, 'updatedAt', path),
    expiresAt: expectString(record, 'expiresAt', path),
    ...optionalStringProp(record, 'submittedAt', path),
    ...optionalStringProp(record, 'confirmedAt', path),
    ...optionalStringProp(record, 'recurringScheduleId', path),
    ...optionalStringProp(record, 'recurringOccurrenceId', path),
    ...optionalStringProp(record, 'occurrenceKey', path),
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
    ...optionalEnumProp(record, 'actionKind', RECURRING_ACTION_KINDS, path),
    token: expectString(record, 'token', path),
    ...optionalStringProp(record, 'inputToken', path),
    ...optionalStringProp(record, 'outputToken', path),
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
    ...optionalStringProp(record, 'expiresAt', path),
    ...optionalNotificationsProp(record, 'notifications', path),
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
    ...optionalEnumProp(record, 'txStatus', TX_STATUSES, path),
    ...optionalStringProp(record, 'confirmationStatus', path),
    ...optionalStringProp(record, 'finalizationId', path),
    ...optionalStringProp(record, 'transactionHash', path),
    ...optionalStringProp(record, 'messageHash', path),
    ...optionalStringProp(record, 'quoteHash', path),
    ...optionalStringProp(record, 'simulationHash', path),
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
    ...optionalEnumProp(
      record,
      'recordType',
      ['plan', 'approval', 'completed', 'evidence', 'signal_feed', 'signal_emission', 'signal_subscription', 'skill_execution'] as const,
      path,
    ),
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
    ...optionalWorkflowMetadataProp(record, 'metadata', path),
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
    ...optionalEnumProp(record, 'status', RECURRING_CREATE_SCHEDULE_STATUSES, path),
    cluster: expectEnum(record, 'cluster', WORKFLOW_CLUSTERS, path),
    ...optionalEnumProp(record, 'actionKind', RECURRING_ACTION_KINDS, path),
    token: expectString(record, 'token', path),
    ...optionalStringProp(record, 'inputToken', path),
    ...optionalStringProp(record, 'outputToken', path),
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
    ...optionalStringProp(record, 'expiresAt', path),
    ...optionalNotificationsProp(record, 'notifications', path),
    ...optionalJsonObjectProp(record, 'riskMetadata', path),
    ...optionalWorkflowMetadataProp(record, 'metadata', path),
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
    ...(input.metadata === undefined ? {} : { metadata: requireWorkflowMetadataObject(input.metadata, 'metadata') }),
  };
}

export function validateApprovalDecisionRequest(body: unknown): ApprovalDecisionInput {
  assertNoForbiddenWorkflowSecrets(body);
  const input = requireObject(body ?? {}, '$');
  const proofSignature = optionalString(input.proofSignature, 'proofSignature')
    ?? optionalString(input.decisionProofSignature, 'decisionProofSignature');
  const decisionProofMessage = optionalString(input.decisionProofMessage, 'decisionProofMessage');
  const signatureEncoding = optionalEnumProp(input, 'signatureEncoding', ['base58', 'base64'] as const, '$').signatureEncoding;
  const decisionProofEncoding = optionalEnumProp(input, 'decisionProofEncoding', ['utf8-message', 'tx-memo-proof'] as const, '$').decisionProofEncoding;
  const decisionProofTxBase64 = optionalString(input.decisionProofTxBase64, 'decisionProofTxBase64');
  return {
    ...(proofSignature ? { proofSignature, decisionProofSignature: proofSignature } : {}),
    ...(decisionProofMessage ? { decisionProofMessage } : {}),
    ...(signatureEncoding ? { signatureEncoding } : {}),
    ...(decisionProofEncoding ? { decisionProofEncoding } : {}),
    ...(decisionProofTxBase64 ? { decisionProofTxBase64 } : {}),
    ...(optionalString(input.note, 'note') ? { note: optionalString(input.note, 'note') } : {}),
    ...(optionalString(input.txid, 'txid') ? { txid: optionalString(input.txid, 'txid') } : {}),
    ...(optionalString(input.explorerUrl, 'explorerUrl') ? { explorerUrl: optionalString(input.explorerUrl, 'explorerUrl') } : {}),
    ...(optionalString(input.error, 'error') ? { error: optionalString(input.error, 'error') } : {}),
    ...(input.txStatus !== undefined ? { txStatus: requireTxStatus(input.txStatus, 'txStatus') } : {}),
    ...(optionalString(input.confirmationStatus, 'confirmationStatus') ? { confirmationStatus: optionalString(input.confirmationStatus, 'confirmationStatus') } : {}),
    ...(optionalString(input.finalizationId, 'finalizationId') ? { finalizationId: optionalString(input.finalizationId, 'finalizationId') } : {}),
    ...(optionalString(input.transactionHash, 'transactionHash') ? { transactionHash: optionalString(input.transactionHash, 'transactionHash') } : {}),
    ...(optionalString(input.messageHash, 'messageHash') ? { messageHash: optionalString(input.messageHash, 'messageHash') } : {}),
    ...(optionalString(input.quoteHash, 'quoteHash') ? { quoteHash: optionalString(input.quoteHash, 'quoteHash') } : {}),
    ...(optionalString(input.simulationHash, 'simulationHash') ? { simulationHash: optionalString(input.simulationHash, 'simulationHash') } : {}),
    ...(input.finalizationStatus !== undefined ? { finalizationStatus: requireTransactionFinalizationStatus(input.finalizationStatus, 'finalizationStatus') } : {}),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

export function validateCreateTransactionFinalizationPreviewRequest(
  body: unknown,
): CreateTransactionFinalizationPreviewInput {
  assertNoForbiddenWorkflowSecrets(body);
  const input = requireObject(body ?? {}, '$');
  const status = input.status === undefined
    ? 'prepared'
    : requireTransactionFinalizationStatus(input.status, 'status');
  if (!['prepared', 'preview_ready', 'simulation_passed', 'blocked', 'expired'].includes(status)) {
    throw new WorkflowValidationError(
      'invalid_finalization_status',
      'status must be one of: prepared, preview_ready, simulation_passed, blocked, expired.',
      '$.status',
    );
  }
  return {
    status: status as CreateTransactionFinalizationPreviewInput['status'],
    walletAction: parseWalletActionPreview(input.walletAction, '$.walletAction'),
    transactionHash: requireWorkflowNonEmptyString(input.transactionHash, 'transactionHash'),
    ...(optionalString(input.messageHash, 'messageHash') ? { messageHash: optionalString(input.messageHash, 'messageHash') } : {}),
    ...(input.quote === undefined ? {} : { quote: parseQuoteSnapshot(input.quote, '$.quote') }),
    ...(input.simulation === undefined ? {} : { simulation: parseSimulationSnapshot(input.simulation, '$.simulation') }),
    ...(optionalString(input.expiresAt, 'expiresAt') ? { expiresAt: optionalString(input.expiresAt, 'expiresAt') } : {}),
    ...(input.metadata === undefined ? {} : { metadata: requireJsonObject(input.metadata, 'metadata') }),
  };
}

export function validateRecordTransactionFinalizationResultRequest(
  body: unknown,
): RecordTransactionFinalizationResultInput {
  const input = validateApprovalDecisionRequest(body);
  if (!input.finalizationId) {
    throw new WorkflowValidationError('missing_finalization_id', 'finalizationId is required.', '$.finalizationId');
  }
  const finalizationStatus = input.finalizationStatus === undefined
    ? txStatusToFinalizationStatus(input.txStatus)
    : requireTransactionFinalizationStatus(input.finalizationStatus, 'finalizationStatus');
  if (!['wallet_pending', 'submitted', 'confirmed', 'failed', 'aborted', 'expired', 'blocked'].includes(finalizationStatus)) {
    throw new WorkflowValidationError(
      'invalid_finalization_status',
      'finalizationStatus must be one of: wallet_pending, submitted, confirmed, failed, aborted, expired, blocked.',
      '$.finalizationStatus',
    );
  }
  return {
    ...input,
    finalizationId: input.finalizationId,
    finalizationStatus: finalizationStatus as RecordTransactionFinalizationResultInput['finalizationStatus'],
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
  const actionKind = input.actionKind === undefined ? recurringActionKindFromInput(input) : requireRecurringActionKind(input.actionKind);
  const token = requireNonEmptyString(input.token ?? input.inputToken, 'token');
  const inputToken = input.inputToken === undefined ? undefined : requireNonEmptyString(input.inputToken, 'inputToken');
  const outputToken = input.outputToken === undefined ? undefined : requireNonEmptyString(input.outputToken, 'outputToken');
  if (actionKind === 'swap' && !outputToken) {
    throw new RecurringValidationError('missing_swap_output_token', 'outputToken is required for recurring swaps.');
  }
  const request: CreateRecurringRequest = {
    ...(input.status !== undefined ? { status: requireCreateScheduleStatus(input.status) } : {}),
    cluster: requireCluster(input.cluster, 'cluster'),
    ...(actionKind !== 'transfer' || input.actionKind !== undefined ? { actionKind } : {}),
    token,
    ...(inputToken ? { inputToken } : {}),
    ...(outputToken ? { outputToken } : {}),
    recipient: actionKind === 'swap' ? optionalString(input.recipient, 'recipient') ?? '' : requireNonEmptyString(input.recipient, 'recipient'),
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
    ...optionalIsoTimestampField(input.expiresAt, 'expiresAt'),
    ...optionalUserNotificationsField(input.notifications, 'notifications'),
    ...optionalJsonObjectField(input.riskMetadata, 'riskMetadata'),
    ...optionalWorkflowMetadataField(input.metadata, 'metadata'),
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
  if (input.actionKind !== undefined) patch.actionKind = requireRecurringActionKind(input.actionKind);
  if (input.token !== undefined) patch.token = requireNonEmptyString(input.token, 'token');
  if (input.inputToken !== undefined) patch.inputToken = requireNonEmptyString(input.inputToken, 'inputToken');
  if (input.outputToken !== undefined) patch.outputToken = requireNonEmptyString(input.outputToken, 'outputToken');
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
  if (input.expiresAt !== undefined) patch.expiresAt = requireIsoTimestamp(input.expiresAt, 'expiresAt');
  if (input.notifications !== undefined) patch.notifications = requireUserNotifications(input.notifications, 'notifications');
  if (input.riskMetadata !== undefined) patch.riskMetadata = requireJsonObject(input.riskMetadata, 'riskMetadata');
  if (input.metadata !== undefined) patch.metadata = requireWorkflowMetadataObject(input.metadata, 'metadata');

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
    const mentionsAuthority =
      normalized.includes('approvalauthority') ||
      normalized.includes('signingauthority') ||
      normalized.includes('authority');
    const isNegatedAuthorityFact = /(disabled|revoked|removed|burned|nullified|none)$/.test(normalized);
    if (mentionsAuthority && !isNegatedAuthorityFact && indicatesUnlimitedAuthority(entry)) {
      throw new WorkflowValidationError('forbidden_authority', `${path}.${key} cannot grant unlimited approval authority.`);
    }
    assertNoForbiddenWorkflowSecrets(entry, `${path}.${key}`);
  }
}

function collectForbiddenGuardrailViolations(input: {
  value: unknown;
  path: string;
  violations: AiGuardrailViolation[];
}): void {
  if (!input.value || typeof input.value !== 'object') {
    if (typeof input.value === 'string') {
      collectForbiddenTextViolations(input.value, input.path, input.violations);
    }
    return;
  }
  if (Array.isArray(input.value)) {
    input.value.forEach((entry, index) => collectForbiddenGuardrailViolations({
      value: entry,
      path: `${input.path}[${index}]`,
      violations: input.violations,
    }));
    return;
  }

  for (const [key, entry] of Object.entries(input.value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const path = `${input.path}.${key}`;
    if (FORBIDDEN_EXACT_KEYS.has(normalized) || normalized.includes('privatekey') || normalized.includes('secretkey')) {
      input.violations.push({
        code: 'forbidden_secret',
        severity: 'block',
        message: `${path} is not accepted by Agentic workflow guardrails.`,
        path,
      });
    }
    const mentionsAuthority =
      normalized.includes('approvalauthority') ||
      normalized.includes('signingauthority') ||
      normalized.includes('authority');
    const isNegatedAuthorityFact = /(disabled|revoked|removed|burned|nullified|none)$/.test(normalized);
    if (mentionsAuthority && !isNegatedAuthorityFact && indicatesUnlimitedAuthority(entry)) {
      input.violations.push({
        code: 'forbidden_authority',
        severity: 'block',
        message: `${path} cannot grant unlimited approval authority.`,
        path,
      });
    }
    collectForbiddenGuardrailViolations({ value: entry, path, violations: input.violations });
  }
}

function collectForbiddenTextViolations(text: string, path: string, violations: AiGuardrailViolation[]): void {
  const normalized = normalizeGuardrailText(text);
  const secretRequest =
    /\b(share|send|enter|paste|provide|export|store|upload|reveal|recover)\b.{0,60}\b(seed phrase|recovery phrase|mnemonic|private key|secret key)\b/.test(normalized) ||
    /\b(seed phrase|recovery phrase|mnemonic|private key|secret key)\b.{0,60}\b(ai|agent|server|cloud|provider)\b/.test(normalized);
  if (secretRequest) {
    violations.push({
      code: 'forbidden_secret_request',
      severity: 'block',
      message: 'Plans cannot request seed phrases, private keys, recovery phrases, or secret keys.',
      path,
    });
  }
  const authorityRequest =
    /\b(grant|give|create|use|authorize|allow|enable)\b.{0,60}\b(delegated signer|delegate signer|server signer|unlimited approval|unrestricted authority|unlimited authority)\b/.test(normalized) ||
    /\b(unlimited approval|unrestricted authority|server signer|delegated signer)\b/.test(normalized);
  if (authorityRequest && !/\b(no|never|without|cannot|must not|do not|reject|block|forbid|forbidden|disallow)\b.{0,60}\b(unlimited approval|unrestricted authority|server signer|delegated signer)\b/.test(normalized)) {
    violations.push({
      code: 'forbidden_authority_request',
      severity: 'block',
      message: 'Plans cannot create delegated signers, server signers, or unlimited approval authority.',
      path,
    });
  }
}

function collectUnsafeAiClaimViolations(input: {
  value: unknown;
  path: string;
  source: string;
  violations: AiGuardrailViolation[];
}): void {
  if (typeof input.value === 'string') {
    if (input.source === 'ai') {
      collectUnsafeAiTextClaims(input.value, input.path, input.violations);
    }
    return;
  }
  if (!input.value || typeof input.value !== 'object') return;
  if (Array.isArray(input.value)) {
    input.value.forEach((entry, index) => collectUnsafeAiClaimViolations({
      value: entry,
      path: `${input.path}[${index}]`,
      source: input.source,
      violations: input.violations,
    }));
    return;
  }
  for (const [key, entry] of Object.entries(input.value as Record<string, unknown>)) {
    collectUnsafeAiClaimViolations({
      value: entry,
      path: `${input.path}.${key}`,
      source: input.source,
      violations: input.violations,
    });
  }
}

// Past-tense completion markers — the guardrail's job is to prevent the AI from
// telling the user the transaction is done when it isn't. After two false-positive
// rounds on benign workflow phrasings (Phase 3's negative-lookahead was too narrow;
// Phase 4's aux-verb branch caught "has been submitted to Jupiter for routing"), we
// took the maximally-conservative approach: ONLY block on the unambiguous explicit
// past-tense marker "already X". The `approval has already happened/occurred/...`
// branch stays for the same precision reason — it's the canonical English false
// claim. Trade-off: bare "has been submitted" / "auto-submitted at signature 5abc"
// no longer trips, but the system has other defenses (wallet signing UI, on-chain
// status) for the rare case of a model fabricating a completion claim.

function collectUnsafeAiTextClaims(text: string, path: string, violations: AiGuardrailViolation[]): void {
  const normalized = normalizeGuardrailText(text);
  const claims: Array<{
    code: string;
    pattern: RegExp | ((value: string) => boolean);
    message: string;
  }> = [
    {
      code: 'ai_claims_approved',
      pattern: /\balready[-\s]+approved\b|\bapproval(?:\s+has)?\s+already\s+(?:happened|occurred|completed|been\s+granted|been\s+approved)\b/,
      message: 'AI drafts cannot claim that wallet approval has already happened.',
    },
    {
      code: 'ai_claims_signed',
      pattern: /\balready[-\s]+(?:signed|signing)\b/,
      message: 'AI drafts cannot claim that a wallet signature has already happened.',
    },
    {
      code: 'ai_claims_submitted',
      pattern: /\balready[-\s]?(?:submitted|executed|broadcast|sent)\b/,
      message: 'AI drafts cannot claim that a transaction has already been submitted or executed.',
    },
    {
      code: 'ai_bypasses_wallet',
      pattern: hasUnsafeWalletBypassClaim,
      message: 'AI drafts cannot bypass wallet approval or signing.',
    },
    {
      code: 'ai_claims_safe',
      pattern: /\b(guaranteed safe|risk[-\s]?free|100%\s+safe|safe to sign|guaranteed profit|guaranteed return|cannot fail|fully reversible)\b/,
      message: 'AI drafts cannot claim that a transaction is guaranteed safe, profitable, reversible, or risk-free.',
    },
  ];
  for (const claim of claims) {
    const matched = typeof claim.pattern === 'function'
      ? claim.pattern(normalized)
      : claim.pattern.test(normalized);
    if (matched) {
      violations.push({
        code: claim.code,
        severity: 'block',
        message: claim.message,
        path,
      });
    }
  }
}

function hasUnsafeWalletBypassClaim(normalized: string): boolean {
  const directBypassClaims = [
    /\b(?:no|zero)\s+(?:wallet\s+)?(?:approval|signature|signing)\s+(?:is\s+)?(?:required|needed|necessary)\b/,
    /\b(?:wallet\s+)?(?:approval|signature|signing)\s+(?:is|are)\s+not\s+(?:required|needed|necessary)\b/,
    /\bdoes(?:\s+not|n't)\s+require\s+(?:a\s+)?(?:wallet\s+)?(?:approval|signature|signing)\b/,
  ];
  if (directBypassClaims.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return hasUnnegatedWalletBypassVerb(normalized) || hasUnnegatedWithoutWalletApproval(normalized);
}

function hasUnnegatedWalletBypassVerb(normalized: string): boolean {
  const pattern = /\b(?:skip|bypass)\b.{0,40}\b(?:wallet|approval|signature|signing)\b/g;
  for (const match of normalized.matchAll(pattern)) {
    if (match.index === undefined || !hasSafeNegationBefore(normalized, match.index, 45)) {
      return true;
    }
  }
  return false;
}

function hasUnnegatedWithoutWalletApproval(normalized: string): boolean {
  const pattern = /\bwithout\b.{0,40}\b(?:wallet|approval|signature|signing)\b/g;
  for (const match of normalized.matchAll(pattern)) {
    if (match.index === undefined || !hasSafeNegationBefore(normalized, match.index, 70)) {
      return true;
    }
  }
  return false;
}

function hasSafeNegationBefore(normalized: string, index: number, distance: number): boolean {
  const prefix = normalized.slice(Math.max(0, index - distance), index);
  return /\b(?:cannot|can't|can not|must not|should not|will not|won't|never|do not|does not|doesn't|not allowed to|not able to|not possible to|nothing|none|no\s+(?:transaction|funds|request|signing|signature|action|execution))\b.{0,50}$/.test(prefix);
}

function collectMissingConstraintViolations(
  actionType: string,
  parameters: Record<string, string>,
  violations: AiGuardrailViolation[],
): void {
  const required = requiredConstraintGroups(actionType);
  for (const group of required) {
    if (!group.keys.some((key) => hasStringParam(parameters, key))) {
      violations.push({
        code: 'missing_executable_constraint',
        severity: 'block',
        message: `${group.label} is required before this plan can enter Approval Inbox.`,
        path: `$.parameters.${group.keys[0]}`,
      });
    }
  }
  const amount = firstPresentParam(parameters, ['amount', 'amountSol', 'inputAmount', 'plannedAmount']);
  if (amount !== undefined && !(Number(amount) > 0)) {
    violations.push({
      code: 'invalid_amount_constraint',
      severity: 'block',
      message: 'Amount must be a positive number before this plan can enter Approval Inbox.',
      path: '$.parameters.amount',
    });
  }
}

function collectAiWarningViolations(
  plan: Record<string, unknown>,
  actionType: string,
  parameters: Record<string, string>,
  violations: AiGuardrailViolation[],
): void {
  for (const key of ['route', 'risk', 'approval'] as const) {
    const value = stringValue(plan[key]);
    if (!value || value.length < 12) {
      violations.push({
        code: 'vague_ai_review_text',
        severity: 'warn',
        message: `AI ${key} text should be explicit before review.`,
        path: `$.plan.${key}`,
      });
    }
  }
  if (isQueueableWorkflowAction(actionType) && !firstPresentParam(parameters, ['memo', 'note', 'reason'])) {
    violations.push({
      code: 'missing_context_note',
      severity: 'warn',
      message: 'A memo or reason is recommended for queueable AI plans.',
      path: '$.parameters.memo',
    });
  }
}

function requiredConstraintGroups(actionType: string): Array<{ label: string; keys: string[] }> {
  if (actionType === 'transfer_sol') {
    return [
      { label: 'Recipient', keys: ['recipient', 'recipientAddress'] },
      { label: 'Amount', keys: ['amount', 'amountSol'] },
    ];
  }
  if (actionType === 'transfer_spl') {
    return [
      { label: 'Token', keys: ['token'] },
      { label: 'Recipient', keys: ['recipient', 'recipientAddress'] },
      { label: 'Amount', keys: ['amount'] },
    ];
  }
  if (actionType === 'swap') {
    return [
      { label: 'Input token', keys: ['inputToken', 'inputMint'] },
      { label: 'Output token', keys: ['outputToken', 'outputMint'] },
      { label: 'Amount', keys: ['amount', 'inputAmount'] },
      { label: 'Slippage cap', keys: ['slippageBps'] },
    ];
  }
  if (actionType === 'recurring_payment') {
    return [
      { label: 'Token', keys: ['token'] },
      { label: 'Recipient', keys: ['recipient', 'recipientAddress'] },
      { label: 'Amount', keys: ['amount'] },
      { label: 'Cadence', keys: ['cadence'] },
    ];
  }
  return [];
}

function guardrailSummary(
  verdict: AiGuardrailVerdict,
  finalizationRequirement: FinalizationRequirement,
  violations: AiGuardrailViolation[],
): string {
  if (verdict === 'block') {
    return violations.find((violation) => violation.severity === 'block')?.message ?? 'Plan is blocked by guardrails.';
  }
  if (verdict === 'warn') {
    return violations.find((violation) => violation.severity === 'warn')?.message ?? 'Plan has guardrail warnings.';
  }
  if (finalizationRequirement === 'transaction_preview') {
    return 'Plan passed guardrails and requires transaction preview before wallet approval.';
  }
  if (finalizationRequirement === 'wallet_decision_proof') {
    return 'Plan passed guardrails and requires explicit wallet decision proof.';
  }
  return 'Plan passed guardrails.';
}

function normalizeGuardrailText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasStringParam(parameters: Record<string, string>, key: string): boolean {
  return Boolean(parameters[key]?.trim());
}

function firstPresentParam(parameters: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = parameters[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') output[key] = entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) output[key] = String(entry);
  }
  return output;
}

function normalizePlanFields(value: unknown): PlanDraftField[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PlanDraftField => {
    return Boolean(isPlainRecord(entry) && typeof entry.label === 'string' && typeof entry.value === 'string');
  }).map((entry) => ({ label: entry.label, value: entry.value }));
}

function valueRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return isPlainObject(input);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256Hex(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) {
    bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const index = offset + i * 4;
      w[i] = ((bytes[index] ?? 0) << 24) |
        ((bytes[index + 1] ?? 0) << 16) |
        ((bytes[index + 2] ?? 0) << 8) |
        (bytes[index + 3] ?? 0);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = sortJson(entry);
    }
    return output;
  }
  return value;
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

function jsonObjectFromJson(object: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = object?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function workflowTxStatus(value: unknown): TxStatus | undefined {
  return TX_STATUSES.includes(value as TxStatus) ? value as TxStatus : undefined;
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

function optionalWorkflowMetadataProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, JsonObject>> {
  const value = record[key];
  if (value === undefined) return {};
  return { [key]: requireWorkflowMetadataObject(value, `${path}.${key}`) } as Partial<Record<T, JsonObject>>;
}

function optionalFinalizationSupportProp<T extends string>(
  record: Record<string, unknown>,
  key: T,
  path: string,
): Partial<Record<T, FinalizationSupport>> {
  const value = record[key];
  if (value === undefined) return {};
  const support = expectRecord(value, `${path}.${key}`);
  const parsed: FinalizationSupport = {
    required: expectBoolean(support, 'required', `${path}.${key}`),
    supported: expectBoolean(support, 'supported', `${path}.${key}`),
    ...optionalStringProp(support, 'reason', `${path}.${key}`),
  };
  return { [key]: parsed } as Partial<Record<T, FinalizationSupport>>;
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

function requireTxStatus(value: unknown, label: string): TxStatus {
  const status = requiredString(value, label);
  if (!TX_STATUSES.includes(status as TxStatus)) {
    throw new WorkflowValidationError('invalid_tx_status', `${label} must be one of: ${TX_STATUSES.join(', ')}.`);
  }
  return status as TxStatus;
}

function requireTransactionFinalizationStatus(value: unknown, label: string): TransactionFinalizationStatus {
  const status = requiredString(value, label);
  if (!TRANSACTION_FINALIZATION_STATUSES.includes(status as TransactionFinalizationStatus)) {
    throw new WorkflowValidationError(
      'invalid_finalization_status',
      `${label} must be one of: ${TRANSACTION_FINALIZATION_STATUSES.join(', ')}.`,
    );
  }
  return status as TransactionFinalizationStatus;
}

function txStatusToFinalizationStatus(status: TxStatus | undefined): NonNullable<RecordTransactionFinalizationResultInput['finalizationStatus']> {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'failed') return 'failed';
  return 'submitted';
}

function requireWorkflowNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowValidationError('invalid_string', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalSource(value: unknown, fallback: PlanDraftSource | undefined): PlanDraftSource {
  if (value === undefined || value === null || value === '') return fallback ?? 'template';
  if (value === 'template' || value === 'ai') return value;
  throw new WorkflowValidationError('invalid_source', 'source must be template or ai.');
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  return coerceJsonObject(value, label);
}

function requireWorkflowMetadataObject(value: unknown, label: string): JsonObject {
  assertNoForbiddenWorkflowSecrets(value, label);
  const metadata = requireJsonObject(value, label);
  validateWorkflowMetadataContract(metadata, label);
  return metadata;
}

function validateWorkflowMetadataContract(metadata: JsonObject, label: string): void {
  if (metadata.agentReview !== undefined && !isPlainObject(metadata.agentReview)) {
    throw new WorkflowValidationError('invalid_metadata', `${label}.agentReview must be an object.`);
  }
  assertOptionalMetadataEnum(
    metadata,
    'agentReviewStatus',
    RECURRING_AGENT_REVIEW_STATUSES,
    label,
  );
  assertOptionalMetadataEnum(
    metadata,
    'agentReviewDecision',
    RECURRING_AGENT_REVIEW_DECISIONS,
    label,
  );
  assertOptionalMetadataIsoTimestamp(metadata, 'agentReviewCheckedAt', label);
  for (const key of [
    'agentReviewProvider',
    'agentReviewModel',
    'connectorId',
    'connectorName',
    'capability',
    'operation',
    'market',
    'pool',
    'reserve',
    'actionSource',
    'approvalBoundary',
  ]) {
    assertOptionalMetadataString(metadata, key, label);
  }
  assertOptionalMetadataStringArray(metadata, 'factLabels', label);
  if (metadata.actionProposal !== undefined && !isPlainObject(metadata.actionProposal)) {
    throw new WorkflowValidationError('invalid_metadata', `${label}.actionProposal must be an object.`);
  }
}

function assertOptionalMetadataEnum<const T extends readonly string[]>(
  metadata: JsonObject,
  key: string,
  values: T,
  label: string,
): void {
  const value = metadata[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || !values.includes(value as T[number])) {
    throw new WorkflowValidationError(
      'invalid_metadata',
      `${label}.${key} must be one of: ${values.map((entry) => entry || 'empty string').join(', ')}.`,
    );
  }
}

function assertOptionalMetadataString(metadata: JsonObject, key: string, label: string): void {
  const value = metadata[key];
  if (value === undefined) return;
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_metadata', `${label}.${key} must be a string.`);
  }
}

function assertOptionalMetadataStringArray(metadata: JsonObject, key: string, label: string): void {
  const value = metadata[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new WorkflowValidationError('invalid_metadata', `${label}.${key} must be an array of strings.`);
  }
}

function assertOptionalMetadataIsoTimestamp(metadata: JsonObject, key: string, label: string): void {
  const value = metadata[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkflowValidationError('invalid_metadata', `${label}.${key} must be an ISO timestamp string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new WorkflowValidationError('invalid_metadata', `${label}.${key} must be a valid ISO timestamp.`);
  }
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

function requireCreateScheduleStatus(value: unknown): CreateRecurringScheduleStatus {
  if (typeof value !== 'string' || !RECURRING_CREATE_SCHEDULE_STATUSES.includes(value as CreateRecurringScheduleStatus)) {
    throw new RecurringValidationError(
      'invalid_status',
      `status must be one of: ${RECURRING_CREATE_SCHEDULE_STATUSES.join(', ')}.`,
    );
  }
  return value as CreateRecurringScheduleStatus;
}

function requireRecurringActionKind(value: unknown): RecurringActionKind {
  if (typeof value !== 'string' || !RECURRING_ACTION_KINDS.includes(value as RecurringActionKind)) {
    throw new RecurringValidationError(
      'invalid_action_kind',
      `actionKind must be one of: ${RECURRING_ACTION_KINDS.join(', ')}.`,
    );
  }
  return value as RecurringActionKind;
}

function recurringActionKindFromInput(input: Record<string, unknown>): RecurringActionKind {
  if (typeof input.outputToken === 'string' && input.outputToken.trim()) return 'swap';
  if (typeof input.metadata === 'object' && input.metadata && !Array.isArray(input.metadata)) {
    const metadata = input.metadata as Record<string, unknown>;
    if (metadata.actionKind === 'swap') return 'swap';
  }
  return 'transfer';
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

function optionalWorkflowMetadataField<K extends string>(value: unknown, key: K): Partial<Record<K, JsonObject>> {
  if (value === undefined) return {};
  return { [key]: requireWorkflowMetadataObject(value, key) } as Partial<Record<K, JsonObject>>;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RecurringValidationError('invalid_string', `${label} must be a non-empty ISO timestamp string.`);
  }
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new RecurringValidationError('invalid_iso_timestamp', `${label} must be a valid ISO timestamp.`);
  }
  return trimmed;
}

function optionalIsoTimestampField<K extends string>(value: unknown, key: K): Partial<Record<K, string>> {
  if (value === undefined || value === null || value === '') return {};
  return { [key]: requireIsoTimestamp(value, key) } as Partial<Record<K, string>>;
}

function requireUserNotifications(value: unknown, label: string): RecurringNotificationsConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecurringValidationError('invalid_notifications', `${label} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  if ('webhookSecret' in obj) {
    throw new RecurringValidationError(
      'invalid_notifications',
      `${label}.webhookSecret cannot be set by the client; secrets are server-generated.`,
    );
  }
  const config: RecurringNotificationsConfig = {};
  if (obj.inApp !== undefined) {
    if (typeof obj.inApp !== 'boolean') {
      throw new RecurringValidationError('invalid_notifications', `${label}.inApp must be a boolean.`);
    }
    config.inApp = obj.inApp;
  }
  if (obj.webhookUrl !== undefined && obj.webhookUrl !== null && obj.webhookUrl !== '') {
    if (typeof obj.webhookUrl !== 'string') {
      throw new RecurringValidationError('invalid_notifications', `${label}.webhookUrl must be a string.`);
    }
    try {
      const parsed = new URL(obj.webhookUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('protocol');
      }
    } catch {
      throw new RecurringValidationError(
        'invalid_notifications',
        `${label}.webhookUrl must be a valid http(s) URL.`,
      );
    }
    config.webhookUrl = obj.webhookUrl;
  }
  return config;
}

function optionalUserNotificationsField<K extends string>(
  value: unknown,
  key: K,
): Partial<Record<K, RecurringNotificationsConfig>> {
  if (value === undefined || value === null) return {};
  return { [key]: requireUserNotifications(value, key) } as Partial<Record<K, RecurringNotificationsConfig>>;
}

function optionalNotificationsProp<K extends string>(
  record: Record<string, unknown>,
  key: K,
  path: string,
): Partial<Record<K, RecurringNotificationsConfig>> {
  const value = record[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_notifications', `${path}.${key} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  const config: RecurringNotificationsConfig = {};
  if (typeof obj.inApp === 'boolean') config.inApp = obj.inApp;
  if (typeof obj.webhookUrl === 'string' && obj.webhookUrl) config.webhookUrl = obj.webhookUrl;
  if (typeof obj.webhookSecret === 'string' && obj.webhookSecret) config.webhookSecret = obj.webhookSecret;
  return { [key]: config } as Partial<Record<K, RecurringNotificationsConfig>>;
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

export * from './spendEnvelope.js';
