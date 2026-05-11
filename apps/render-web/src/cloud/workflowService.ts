import { createHash, randomUUID } from 'node:crypto';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
  assertPlanGuardrails,
  finalizationRequirementForAction,
  isActiveApprovalStatus,
  isTerminalApprovalStatus,
  requiresTransactionFinalization as workflowRequiresTransactionFinalization,
  stableWorkflowHash,
  type AiGuardrailReport,
  type ApprovalRequestRecord,
  type AuditEventRecord,
  type CompletedRecord,
  type FinalizationRequirement,
  type JsonObject,
  type PlanDraftRecord,
  type TransactionFinalizationRecord,
  type WorkflowCluster,
  workflowDecisionProofMessage as sharedWorkflowDecisionProofMessage,
  workflowFinalizationProofMessage,
} from '@solana-agent-wallet-adapter/workflow';

import { completedRecordFromApproval } from './receiptService.js';
import type {
  ApprovalDecision,
  ApprovalDecisionInput,
  CreateTransactionFinalizationPreviewInput,
  CreateApprovalInput,
  CreatePlanInput,
  RecordTransactionFinalizationResultInput,
  TransactionFinalizationStatus,
  TxStatus,
  UpdatePlanInput,
  WorkflowSession,
} from './workflowValidation.js';
import {
  normalizeCompletedRecord,
  stringFromJson,
} from './workflowValidation.js';
import { verifyWalletSignature } from './auth.js';

export interface WorkflowStore {
  listPlans(walletAddress: string): Promise<PlanDraftRecord[]>;
  getPlan(walletAddress: string, id: string): Promise<PlanDraftRecord | undefined>;
  savePlan(walletAddress: string, record: PlanDraftRecord): Promise<void>;
  deletePlan(walletAddress: string, id: string): Promise<boolean>;
  listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]>;
  listApprovalsByIds?(walletAddress: string, ids: string[]): Promise<ApprovalRequestRecord[]>;
  listApprovalsByRecurringOccurrenceIds?(walletAddress: string, occurrenceIds: string[]): Promise<ApprovalRequestRecord[]>;
  getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined>;
  saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void>;
  listCompleted(walletAddress: string): Promise<CompletedRecord[]>;
  listCompletedByIds?(walletAddress: string, ids: string[]): Promise<CompletedRecord[]>;
  listCompletedByRecurringOccurrenceIds?(walletAddress: string, occurrenceIds: string[]): Promise<CompletedRecord[]>;
  getCompleted(walletAddress: string, id: string): Promise<CompletedRecord | undefined>;
  saveCompleted(walletAddress: string, record: CompletedRecord): Promise<void>;
  deleteCompleted(walletAddress: string, id: string): Promise<boolean>;
  listFinalizations(walletAddress: string, approvalRequestId?: string): Promise<TransactionFinalizationRecord[]>;
  getFinalization(walletAddress: string, id: string): Promise<TransactionFinalizationRecord | undefined>;
  saveFinalization(walletAddress: string, record: TransactionFinalizationRecord): Promise<void>;
  appendAuditEvent(walletAddress: string, record: AuditEventRecord): Promise<void>;
}

interface WorkflowServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  transactionVerifier?: TransactionVerifier;
}

export type TransactionVerificationStatus = 'confirmed' | 'pending' | 'failed' | 'message_mismatch';

export interface TransactionVerificationRequest {
  finalization: TransactionFinalizationRecord;
  txid: string;
  cluster: WorkflowCluster;
}

export interface TransactionVerificationResult {
  status: TransactionVerificationStatus;
  txStatus?: TxStatus;
  confirmationStatus?: string;
  messageHash?: string;
  slot?: number;
  error?: string;
  metadata?: JsonObject;
}

export type TransactionVerifier = (request: TransactionVerificationRequest) => Promise<TransactionVerificationResult>;

interface PreparedTransactionFinalizationPreview {
  transactionBase64: string;
  preview: CreateTransactionFinalizationPreviewInput;
}

interface CreateFinalizationPreviewOptions {
  trustedServerPrepared?: boolean;
}

interface RecordTransactionFinalizationFailureInput {
  error?: string;
  note?: string;
  metadata?: JsonObject;
}

const FINALIZATION_PREVIEW_TTL_MS = 10 * 60_000;
const MAX_FINALIZATION_PREVIEW_TTL_MS = 15 * 60_000;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export class WorkflowServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowServiceError';
  }
}

export class WorkflowService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly transactionVerifier: TransactionVerifier;

  constructor(
    private readonly store: WorkflowStore,
    options: WorkflowServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.transactionVerifier = options.transactionVerifier ?? verifySolanaTransactionFinalization;
  }

  async createPlan(session: WorkflowSession, input: CreatePlanInput): Promise<PlanDraftRecord> {
    const now = this.now();
    const guardrailReport = planGuardrailReport(input);
    const record: PlanDraftRecord = {
      id: this.id('plan'),
      walletAddress: session.walletAddress,
      plan: input.plan,
      title: input.title,
      intent: input.intent,
      route: input.route,
      risk: input.risk,
      approval: input.approval,
      createdAt: now,
      updatedAt: now,
      source: input.source,
      category: input.category,
      actionType: input.actionType,
      parameters: input.parameters,
      fields: input.fields,
      safeguards: input.safeguards,
      templateId: input.templateId,
      templateTitle: input.templateTitle,
      prompt: input.prompt,
      cluster: input.cluster,
      ...(input.userNotes ? { userNotes: input.userNotes } : {}),
      ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
      riskMetadata: withGuardrailRiskMetadata(input.riskMetadata, guardrailReport),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      status: input.status ?? 'draft',
      ...(input.signature ? { signature: input.signature } : {}),
    };

    await this.store.savePlan(session.walletAddress, record);
    await this.audit(session, 'plan.guardrail.checked', 'plan', record.id, guardrailAuditMetadata(guardrailReport));
    await this.audit(session, 'plan.created', 'plan', record.id, {
      status: record.status,
      guardrailVerdict: guardrailReport.verdict,
      finalizationRequirement: guardrailReport.finalizationRequirement,
      constraintFingerprint: guardrailReport.constraintFingerprint,
      ...(guardrailReport.constraintHash ? { constraintHash: guardrailReport.constraintHash } : {}),
    });
    return record;
  }

  async listPlans(session: WorkflowSession): Promise<PlanDraftRecord[]> {
    return sortByUpdatedAt((await this.store.listPlans(session.walletAddress)).map(normalizePlanRecord));
  }

  async updatePlan(session: WorkflowSession, id: string, input: UpdatePlanInput): Promise<PlanDraftRecord> {
    const existing = await this.requirePlan(session, id);
    this.assertPlanPatchAllowed(existing, input);
    let updated: PlanDraftRecord = {
      ...existing,
      ...input,
      updatedAt: this.now(),
    };
    const guardrailReport = isPlanContentPatch(input) ? planRecordGuardrailReport(updated) : undefined;
    if (guardrailReport) {
      updated = {
        ...updated,
        riskMetadata: withGuardrailRiskMetadata(updated.riskMetadata, guardrailReport),
      };
    }

    await this.store.savePlan(session.walletAddress, updated);
    if (guardrailReport) {
      await this.audit(session, 'plan.guardrail.checked', 'plan', updated.id, guardrailAuditMetadata(guardrailReport));
    }
    await this.audit(session, 'plan.updated', 'plan', updated.id, { status: updated.status });
    return updated;
  }

  async deletePlan(session: WorkflowSession, id: string): Promise<void> {
    const plan = await this.requirePlan(session, id);
    if (plan.status === 'queued') {
      const activeApproval = await this.activeApprovalForPlan(session, id);
      if (activeApproval) {
        throw new WorkflowServiceError(409, 'plan_has_active_approval', 'Queued plans with active approvals cannot be deleted.');
      }
    }
    const deleted = await this.store.deletePlan(session.walletAddress, id);
    if (!deleted) throw notFound('Plan was not found.');
    await this.audit(session, 'plan.deleted', 'plan', id, {});
  }

  async createApproval(session: WorkflowSession, input: CreateApprovalInput): Promise<ApprovalRequestRecord> {
    const now = this.now();
    const linkedPlanId = input.planId ?? input.planDraftId;
    const linkedPlan = linkedPlanId ? await this.requirePlan(session, linkedPlanId) : undefined;
    if (linkedPlan?.status === 'archived') {
      throw new WorkflowServiceError(409, 'archived_plan', 'Archived plans cannot be queued for approval.');
    }
    if (linkedPlan && await this.activeApprovalForPlan(session, linkedPlan.id)) {
      throw new WorkflowServiceError(409, 'approval_exists', 'This plan already has an active approval request.');
    }
    const existingRecurringApproval = input.recurringOccurrenceId
      ? await this.activeApprovalForRecurringOccurrence(
        session,
        input.recurringOccurrenceId,
        input.recurringScheduleId,
      )
      : undefined;
    if (existingRecurringApproval) {
      return existingRecurringApproval;
    }

    const plan = input.plan;
    const kind = input.kind ?? linkedPlan?.actionType ?? stringFromJson(plan, 'actionType') ?? 'manual_review';
    const summary = input.summary ?? linkedPlan?.intent ?? stringFromJson(plan, 'intent') ?? `${kind.replace(/_/g, ' ')} approval`;
    const params = input.params ?? stringRecordToJson(linkedPlan?.parameters) ?? jsonObjectFromPlan(plan, 'parameters') ?? {};
    const guardrailReport = approvalGuardrailReport(input, linkedPlan, kind, params);
    const finalizationRequirement = finalizationRequirementForAction(kind);
    assertCloudApprovalKindSupported(kind);

    const record: ApprovalRequestRecord = {
      id: this.id('approval'),
      walletAddress: session.walletAddress,
      ...(linkedPlan ? { planDraftId: linkedPlan.id } : linkedPlanId ? { planDraftId: linkedPlanId } : {}),
      kind,
      summary,
      params,
      status: 'ready',
      cluster: input.cluster ?? linkedPlan?.cluster ?? 'devnet',
      dueAt: input.dueAt ?? now,
      createdAt: now,
      updatedAt: now,
      ...(input.note ? { note: input.note } : {}),
      ...(input.amount ?? amountFromPlan(plan) ? { amount: input.amount ?? amountFromPlan(plan) } : {}),
      ...(input.token ?? tokenFromPlan(plan) ? { token: input.token ?? tokenFromPlan(plan) } : {}),
      ...(input.recipient ?? stringFromJson(params, 'recipient') ? { recipient: input.recipient ?? stringFromJson(params, 'recipient') } : {}),
      ...(input.recurringScheduleId ? { recurringScheduleId: input.recurringScheduleId } : {}),
      ...(input.recurringOccurrenceId ? { recurringOccurrenceId: input.recurringOccurrenceId } : {}),
      ...(input.occurrenceKey ? { occurrenceKey: input.occurrenceKey } : {}),
      finalizationRequirement,
      executionMode: executionModeForFinalizationRequirement(finalizationRequirement),
      finalizationSupport: finalizationSupportForKind(kind),
      riskMetadata: withGuardrailRiskMetadata(input.riskMetadata ?? linkedPlan?.riskMetadata, guardrailReport),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    try {
      await this.store.saveApproval(session.walletAddress, record);
    } catch (err) {
      if (input.recurringOccurrenceId && isApprovalExistsStoreError(err)) {
        const existing = await this.activeApprovalForRecurringOccurrence(
          session,
          input.recurringOccurrenceId,
          input.recurringScheduleId,
        );
        if (existing) return existing;
      }
      if (isApprovalExistsStoreError(err)) {
        throw new WorkflowServiceError(409, 'approval_exists', 'This plan already has an active approval request.');
      }
      throw err;
    }
    if (linkedPlan) {
      await this.store.savePlan(session.walletAddress, {
        ...linkedPlan,
        status: 'queued',
        approvalRequestId: record.id,
        updatedAt: now,
      });
    }
    await this.audit(session, 'approval.created', 'approval', record.id, {
      status: record.status,
      ...(record.planDraftId ? { planDraftId: record.planDraftId } : {}),
      guardrailVerdict: guardrailReport.verdict,
      finalizationRequirement: guardrailReport.finalizationRequirement,
      constraintFingerprint: guardrailReport.constraintFingerprint,
      ...(guardrailReport.constraintHash ? { constraintHash: guardrailReport.constraintHash } : {}),
    });
    await this.audit(session, 'approval.guardrail.checked', 'approval', record.id, guardrailAuditMetadata(guardrailReport));
    return record;
  }

  async listActiveApprovals(session: WorkflowSession): Promise<ApprovalRequestRecord[]> {
    const approvals = (await this.store.listApprovals(session.walletAddress)).map(normalizeApprovalRecord);
    return sortByUpdatedAt(approvals.filter((approval) => isActiveApprovalStatus(approval.status)));
  }

  async listFinalizationsForApproval(
    session: WorkflowSession,
    approvalRequestId: string,
  ): Promise<TransactionFinalizationRecord[]> {
    await this.requireApproval(session, approvalRequestId);
    return (await this.store.listFinalizations(session.walletAddress, approvalRequestId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
  }

  async prepareTransactionFinalization(
    session: WorkflowSession,
    approvalRequestId: string,
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord; transactionBase64: string }> {
    const approval = await this.requireApproval(session, approvalRequestId);
    if (isTerminalApprovalStatus(approval.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    if (!requiresTransactionFinalization(approval.kind)) {
      throw new WorkflowServiceError(
        400,
        'transaction_finalization_not_required',
        'This approval does not require transaction finalization.',
      );
    }
    const support = finalizationSupportForKind(approval.kind);
    if (!support.supported) {
      throw new WorkflowServiceError(
        409,
        'unsupported_cloud_finalization_kind',
        support.reason ?? 'This approval kind is not supported by Agentic Cloud transaction finalization yet.',
      );
    }

    const prepared = approval.kind === 'transfer_sol'
      ? await prepareSolTransferFinalizationPreview(session, approval, this.now())
      : undefined;
    if (!prepared) {
      throw new WorkflowServiceError(
        409,
        'unsupported_cloud_finalization_kind',
        'This approval kind is not supported by Agentic Cloud transaction finalization yet.',
      );
    }

    const result = await this.createFinalizationPreview(session, approvalRequestId, prepared.preview, {
      trustedServerPrepared: true,
    });
    await this.audit(session, 'approval.finalization.prepared', 'approval', approval.id, {
      finalizationId: result.finalization.id,
      transactionHash: result.finalization.transactionHash,
      walletActionKind: result.finalization.walletAction.kind,
      serverPrepared: true,
    });
    return { ...result, transactionBase64: prepared.transactionBase64 };
  }

  async submitTransactionFinalization(
    session: WorkflowSession,
    approvalRequestId: string,
    finalizationId: string,
    input: RecordTransactionFinalizationResultInput,
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord; completed?: CompletedRecord }> {
    if (input.finalizationId !== finalizationId) {
      throw new WorkflowServiceError(400, 'finalization_id_mismatch', 'Finalization id must match the request path.');
    }
    return this.recordFinalizationResult(session, approvalRequestId, input);
  }

  async failTransactionFinalization(
    session: WorkflowSession,
    approvalRequestId: string,
    finalizationId: string,
    input: RecordTransactionFinalizationFailureInput,
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord }> {
    const result = await this.recordFinalizationResult(session, approvalRequestId, {
      finalizationId,
      finalizationStatus: 'aborted',
      error: input.error ?? 'Wallet transaction was not submitted.',
      ...(input.note ? { note: input.note } : {}),
      metadata: {
        ...(input.metadata ?? {}),
        failureSource: 'wallet_action',
      },
    });
    return { approval: result.approval, finalization: result.finalization };
  }

  async confirmTransactionFinalization(
    session: WorkflowSession,
    approvalRequestId: string,
    finalizationId: string,
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord; completed?: CompletedRecord }> {
    const approval = await this.requireApproval(session, approvalRequestId);
    if (isTerminalApprovalStatus(approval.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    const finalization = await this.store.getFinalization(session.walletAddress, finalizationId);
    if (!finalization || finalization.approvalRequestId !== approval.id) {
      throw new WorkflowServiceError(404, 'not_found', 'Finalization record was not found.');
    }
    if (!finalization.txid) {
      throw new WorkflowServiceError(400, 'missing_txid', 'Finalization has no submitted transaction id to confirm.');
    }
    if (!approval.decisionProofSignature || !approval.decisionProofMessage) {
      throw new WorkflowServiceError(400, 'missing_decision_proof', 'Submitted finalization is missing its wallet proof.');
    }
    return this.recordFinalizationResult(session, approvalRequestId, {
      finalizationId,
      finalizationStatus: 'confirmed',
      txStatus: 'confirmed',
      txid: finalization.txid,
      transactionHash: finalization.transactionHash,
      ...(finalization.messageHash ? { messageHash: finalization.messageHash } : {}),
      ...(finalization.quote?.quoteHash ? { quoteHash: finalization.quote.quoteHash } : {}),
      ...(finalization.simulation?.simulationHash ? { simulationHash: finalization.simulation.simulationHash } : {}),
      ...(finalization.explorerUrl ? { explorerUrl: finalization.explorerUrl } : {}),
      proofSignature: approval.decisionProofSignature,
      decisionProofSignature: approval.decisionProofSignature,
      decisionProofMessage: approval.decisionProofMessage,
      signatureEncoding: 'base58',
      note: approval.note,
      metadata: {
        confirmationSource: 'server_retry',
      },
    });
  }

  async createFinalizationPreview(
    session: WorkflowSession,
    approvalRequestId: string,
    input: CreateTransactionFinalizationPreviewInput,
    options: CreateFinalizationPreviewOptions = {},
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord }> {
    const approval = await this.requireApproval(session, approvalRequestId);
    if (isTerminalApprovalStatus(approval.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    if (input.walletAction.walletAddress !== approval.walletAddress) {
      throw new WorkflowServiceError(400, 'wallet_mismatch', 'Finalization preview wallet must match the approval wallet.');
    }
    const cluster = approval.cluster ?? 'devnet';
    if (input.walletAction.cluster !== cluster) {
      throw new WorkflowServiceError(400, 'cluster_mismatch', 'Finalization preview cluster must match the approval cluster.');
    }
    const finalizationStatus = input.status ?? 'prepared';
    const executableFinalizationPreview =
      requiresTransactionFinalization(approval.kind) &&
      finalizationStatus !== 'blocked' &&
      finalizationStatus !== 'expired';
    if (executableFinalizationPreview) {
      if (!input.simulation || input.simulation.status !== 'ok') {
        throw new WorkflowServiceError(
          400,
          'simulation_required',
          'Transaction finalization preview requires a successful simulation before wallet approval.',
        );
      }
      if (!input.quote?.quoteHash) {
        throw new WorkflowServiceError(
          400,
          'quote_required',
          'Transaction finalization preview requires a refreshed quote or fixed transfer quote hash.',
        );
      }
      assertFinalizationMatchesApproval(approval, input);
      if (options.trustedServerPrepared !== true) {
        throw new WorkflowServiceError(
          409,
          'server_prepared_finalization_required',
          'Money-moving cloud finalizations must be prepared by the server.',
        );
      }
    }
    const now = this.now();
    const expiresAt = finalizationExpiry(input.expiresAt, now);
    const finalization: TransactionFinalizationRecord = {
      id: this.id('finalization'),
      walletAddress: session.walletAddress,
      approvalRequestId: approval.id,
      ...(approval.planDraftId ? { planDraftId: approval.planDraftId } : {}),
      kind: approval.kind,
      status: input.status ?? 'prepared',
      cluster,
      walletAction: {
        ...input.walletAction,
        kind: approval.kind,
        walletAddress: approval.walletAddress,
        cluster,
      },
      transactionHash: input.transactionHash,
      ...(input.messageHash ? { messageHash: input.messageHash } : {}),
      ...(input.quote ? { quote: input.quote } : {}),
      ...(input.simulation ? { simulation: input.simulation } : {}),
      createdAt: now,
      updatedAt: now,
      expiresAt,
      ...(approval.recurringScheduleId ? { recurringScheduleId: approval.recurringScheduleId } : {}),
      ...(approval.recurringOccurrenceId ? { recurringOccurrenceId: approval.recurringOccurrenceId } : {}),
      ...(approval.occurrenceKey ? { occurrenceKey: approval.occurrenceKey } : {}),
      metadata: finalizationMetadata(
        trustedFinalizationMetadata(input.metadata, options.trustedServerPrepared === true),
        approval,
      ),
    };

    const updatedApproval: ApprovalRequestRecord = {
      ...approval,
      updatedAt: now,
      metadata: {
        ...(approval.metadata ?? {}),
        finalization: jsonObject(finalization),
        finalizationRequirement: 'transaction_preview',
      },
    };

    await this.store.saveFinalization(session.walletAddress, finalization);
    await this.store.saveApproval(session.walletAddress, updatedApproval);
    await this.audit(session, 'approval.finalization.previewed', 'approval', approval.id, {
      finalizationId: finalization.id,
      status: finalization.status,
      transactionHash: finalization.transactionHash,
    });
    return { approval: updatedApproval, finalization };
  }

  async recordFinalizationResult(
    session: WorkflowSession,
    approvalRequestId: string,
    input: RecordTransactionFinalizationResultInput,
  ): Promise<{ approval: ApprovalRequestRecord; finalization: TransactionFinalizationRecord; completed?: CompletedRecord }> {
    const existing = await this.requireApproval(session, approvalRequestId);
    if (isTerminalApprovalStatus(existing.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    const finalization = await this.store.getFinalization(session.walletAddress, input.finalizationId);
    if (!finalization || finalization.approvalRequestId !== existing.id) {
      throw new WorkflowServiceError(404, 'not_found', 'Finalization record was not found.');
    }
    const now = this.now();
    let finalizationStatus = input.finalizationStatus ?? finalizationStatusFromTxStatus(input.txStatus);
    if ((finalizationStatus === 'confirmed' || finalizationStatus === 'submitted') && !input.txid) {
      throw new WorkflowServiceError(400, 'missing_txid', 'Submitted or confirmed finalization requires a transaction id.');
    }
    if (
      requiresTransactionFinalization(existing.kind) &&
      requiresSubmittedFinalizationChecks(finalizationStatus) &&
      !isServerPreparedFinalization(finalization)
    ) {
      throw new WorkflowServiceError(
        409,
        'server_prepared_finalization_required',
        'Money-moving cloud finalization receipts must use a server-prepared finalization.',
      );
    }
    if (requiresFinalizationIntegrityChecks(finalizationStatus, input)) {
      if (finalizationSubmissionExpired(finalization, input, now)) {
        throw new WorkflowServiceError(409, 'finalization_expired', 'Finalization has expired. Prepare a fresh transaction review.');
      }
      if (finalization.status === 'blocked' || finalization.status === 'expired') {
        throw new WorkflowServiceError(409, 'finalization_not_submittable', 'Blocked or expired finalizations cannot be submitted.');
      }
      if (!input.transactionHash) {
        throw new WorkflowServiceError(400, 'missing_transaction_hash', 'Finalization result must include the prepared transaction hash.');
      }
      if (input.transactionHash !== finalization.transactionHash) {
        throw new WorkflowServiceError(409, 'transaction_hash_mismatch', 'Wallet result does not match the prepared transaction hash.');
      }
      if (finalization.messageHash && input.messageHash !== finalization.messageHash) {
        throw new WorkflowServiceError(409, 'message_hash_mismatch', 'Wallet result does not match the prepared message hash.');
      }
      if (!finalization.simulation || finalization.simulation.status !== 'ok') {
        throw new WorkflowServiceError(409, 'simulation_required', 'Finalization must have a successful simulation before wallet submission.');
      }
      if (!input.simulationHash || input.simulationHash !== finalization.simulation.simulationHash) {
        throw new WorkflowServiceError(409, 'simulation_hash_mismatch', 'Wallet result does not match the prepared simulation hash.');
      }
      if (finalization.quote && (!input.quoteHash || input.quoteHash !== finalization.quote.quoteHash)) {
        throw new WorkflowServiceError(409, 'quote_hash_mismatch', 'Wallet result does not match the refreshed quote hash.');
      }
    }
    const finalizationProofMessage = requiresFinalizationProof(finalizationStatus, input)
      ? this.finalizationProofMessageForResult(session, existing, input, finalization)
      : undefined;
    const verification = await this.verifySubmittedFinalization(finalization, finalizationStatus, input);
    if (verification) {
      finalizationStatus = finalizationStatusFromVerification(verification);
    }
    const txStatus = txStatusFromFinalizationStatus(finalizationStatus, verification ? verification.txStatus : input.txStatus);
    const confirmationStatus = verification?.confirmationStatus ?? input.confirmationStatus;
    const finalizationError = verificationErrorMessage(verification) ?? input.error;
    const updatedFinalization: TransactionFinalizationRecord = {
      ...finalization,
      status: finalizationStatus,
      updatedAt: now,
      ...(input.txid ? { txid: input.txid } : {}),
      ...(txStatus ? { txStatus } : {}),
      ...(confirmationStatus ? { confirmationStatus } : {}),
      ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
      ...(finalizationError ? { error: finalizationError } : {}),
      ...(finalizationStatus === 'wallet_pending' ? { submittedAt: now } : {}),
      ...(finalizationStatus === 'submitted' ? { submittedAt: now } : {}),
      ...(finalizationStatus === 'confirmed' ? { submittedAt: finalization.submittedAt ?? now, confirmedAt: now } : {}),
      metadata: {
        ...(finalization.metadata ?? {}),
        ...(input.metadata ?? {}),
        ...(finalizationProofMessage ? { finalizationProofMessage } : {}),
        ...(verification ? { verification: jsonObject(verificationMetadata(verification, now)) } : {}),
      },
    };

    await this.store.saveFinalization(session.walletAddress, updatedFinalization);

    const baseApproval: ApprovalRequestRecord = {
      ...existing,
      updatedAt: now,
      ...(input.txid ? { txid: input.txid } : {}),
      ...(txStatus ? { txStatus } : {}),
      ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
      ...(finalizationError ? { error: finalizationError } : {}),
      metadata: {
        ...(existing.metadata ?? {}),
        finalization: jsonObject(updatedFinalization),
        finalizationRequirement: 'transaction_preview',
        ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
      },
    };

    if (finalizationStatus === 'confirmed') {
      const approved: ApprovalRequestRecord = {
        ...baseApproval,
        status: 'approved',
        decidedAt: now,
        confirmedAt: now,
        ...(input.decisionProofSignature ? { decisionProofSignature: input.decisionProofSignature } : {}),
        ...(finalizationProofMessage ? { decisionProofMessage: finalizationProofMessage, decisionProofVerified: true } : {}),
        note: input.note ?? existing.note,
      };
      const completed = completedRecordFromApproval(approved);
      await this.store.saveApproval(session.walletAddress, approved);
      await this.store.saveCompleted(session.walletAddress, completed);
      await this.archiveLinkedPlanForTerminalApproval(session, approved, completed, now);
      await this.audit(session, 'approval.finalized', 'approval', approved.id, {
        completedId: completed.id,
        status: approved.status,
        finalizationId: updatedFinalization.id,
        ...(input.txid ? { txid: input.txid } : {}),
      });
      return { approval: approved, finalization: updatedFinalization, completed };
    }

    const activeApproval: ApprovalRequestRecord = {
      ...baseApproval,
      status: activeApprovalStatusForFinalization(finalizationStatus, existing.status),
      ...(input.decisionProofSignature ? { decisionProofSignature: input.decisionProofSignature } : {}),
      ...(finalizationProofMessage ? { decisionProofMessage: finalizationProofMessage, decisionProofVerified: true } : {}),
      ...(input.note ? { note: input.note } : {}),
    };
    await this.store.saveApproval(session.walletAddress, activeApproval);
    await this.audit(session, `approval.finalization.${finalizationStatus}`, 'approval', activeApproval.id, {
      finalizationId: updatedFinalization.id,
      status: finalizationStatus,
      ...(input.txid ? { txid: input.txid } : {}),
    });
    return { approval: activeApproval, finalization: updatedFinalization };
  }

  async decideApproval(
    session: WorkflowSession,
    id: string,
    decision: ApprovalDecision,
    input: ApprovalDecisionInput,
  ): Promise<{ approval: ApprovalRequestRecord; completed: CompletedRecord }> {
    const existing = await this.requireApproval(session, id);
    if (isTerminalApprovalStatus(existing.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    if ((decision === 'approved' || decision === 'rejected') && !input.decisionProofSignature) {
      throw new WorkflowServiceError(400, 'missing_decision_proof', 'Approve and deny decisions require a wallet decision proof signature.');
    }
    if (decision === 'approved' && requiresTransactionFinalization(existing.kind)) {
      throw new WorkflowServiceError(
        409,
        'transaction_finalization_required',
        'Money-moving approvals must be finalized through the transaction review flow.',
      );
    }
    if ((decision === 'approved' || decision === 'rejected') && proofOnlyDecisionCarriesTransactionFields(input)) {
      throw new WorkflowServiceError(
        400,
        'proof_only_tx_fields_not_allowed',
        'Proof-only decisions cannot include transaction ids, explorer URLs, transaction hashes, or finalization fields.',
      );
    }
    const decisionProofMessage = (decision === 'approved' || decision === 'rejected')
      ? this.requireVerifiedDecisionProof(session, existing, decision, input)
      : undefined;

    const completedAt = this.now();
    const existingForDecision: ApprovalRequestRecord = { ...existing };
    delete existingForDecision.confirmedAt;
    const approval: ApprovalRequestRecord = {
      ...existingForDecision,
      status: decision,
      updatedAt: completedAt,
      decidedAt: completedAt,
      ...(decision === 'approved' && input.txid ? { confirmedAt: completedAt } : {}),
      ...(input.decisionProofSignature ? { decisionProofSignature: input.decisionProofSignature } : {}),
      ...(decisionProofMessage ? { decisionProofMessage, decisionProofVerified: true } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.error ? { error: input.error } : {}),
      metadata: {
        ...(existing.metadata ?? {}),
        executionMode: 'proof_only',
        ...(input.metadata ?? {}),
      },
    };
    const completed = completedRecordFromApproval(approval);

    await this.store.saveApproval(session.walletAddress, approval);
    await this.store.saveCompleted(session.walletAddress, completed);
    await this.archiveLinkedPlanForTerminalApproval(session, approval, completed, completedAt);
    await this.audit(session, `approval.${decision}`, 'approval', approval.id, {
      completedId: completed.id,
      status: decision,
    });
    return { approval, completed };
  }

  async finalizeApprovalTransaction(
    session: WorkflowSession,
    id: string,
    input: ApprovalDecisionInput,
  ): Promise<{ approval: ApprovalRequestRecord; completed: CompletedRecord }> {
    const existing = await this.requireApproval(session, id);
    if (isTerminalApprovalStatus(existing.status)) {
      throw new WorkflowServiceError(409, 'approval_terminal', 'Approval request is already terminal.');
    }
    if (!input.txid) {
      throw new WorkflowServiceError(400, 'missing_txid', 'Transaction finalization requires a transaction id.');
    }
    if (!input.decisionProofSignature) {
      throw new WorkflowServiceError(400, 'missing_decision_proof', 'Transaction finalization requires a wallet decision proof signature.');
    }
    const decisionProofMessage = this.requireVerifiedDecisionProof(session, existing, 'approved', input);
    const completedAt = this.now();
    const existingForDecision: ApprovalRequestRecord = { ...existing };
    delete existingForDecision.confirmedAt;
    const approval: ApprovalRequestRecord = {
      ...existingForDecision,
      status: 'approved',
      updatedAt: completedAt,
      decidedAt: completedAt,
      confirmedAt: completedAt,
      note: input.note ?? existing.note,
      txid: input.txid,
      ...(input.txStatus ? { txStatus: input.txStatus } : { txStatus: 'pending' }),
      ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
      ...(input.error ? { error: input.error } : {}),
      decisionProofSignature: input.decisionProofSignature,
      decisionProofMessage,
      decisionProofVerified: true,
      metadata: {
        ...(existing.metadata ?? {}),
        executionMode: 'wallet_execute',
        ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
        ...(input.metadata ?? {}),
      },
    };
    const completed = completedRecordFromApproval(approval);

    await this.store.saveApproval(session.walletAddress, approval);
    await this.store.saveCompleted(session.walletAddress, completed);
    await this.archiveLinkedPlanForTerminalApproval(session, approval, completed, completedAt);
    await this.audit(session, 'approval.finalized', 'approval', approval.id, {
      completedId: completed.id,
      status: approval.status,
      ...(input.finalizationId ? { finalizationId: input.finalizationId } : {}),
      ...(input.txid ? { txid: input.txid } : {}),
    });
    return { approval, completed };
  }

  async listCompleted(session: WorkflowSession): Promise<CompletedRecord[]> {
    const completed = (await this.store.listCompleted(session.walletAddress)).map(normalizeCompletedRecord);
    return [...completed].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async deleteCompleted(session: WorkflowSession, id: string): Promise<void> {
    const existing = await this.store.getCompleted(session.walletAddress, id);
    if (!existing) throw notFound('Completed record was not found.');
    const deleted = await this.store.deleteCompleted(session.walletAddress, id);
    if (!deleted) throw notFound('Completed record was not found.');
    await this.audit(session, 'completed.deleted', 'completed', id, {});
  }

  private async requirePlan(session: WorkflowSession, id: string): Promise<PlanDraftRecord> {
    const record = await this.store.getPlan(session.walletAddress, id);
    if (!record) throw notFound('Plan was not found.');
    return normalizePlanRecord(record);
  }

  private async requireApproval(session: WorkflowSession, id: string): Promise<ApprovalRequestRecord> {
    const record = await this.store.getApproval(session.walletAddress, id);
    if (!record) throw notFound('Approval request was not found.');
    return normalizeApprovalRecord(record);
  }

  private requireVerifiedDecisionProof(
    session: WorkflowSession,
    approval: ApprovalRequestRecord,
    decision: Extract<ApprovalDecision, 'approved' | 'rejected'>,
    input: ApprovalDecisionInput,
    finalization?: TransactionFinalizationRecord,
  ): string {
    const expectedMessage = finalization
      ? workflowFinalizationProofMessage({ approval, finalization })
      : workflowDecisionProofMessage({ approval, decision });
    if (!input.decisionProofMessage) {
      throw new WorkflowServiceError(400, 'missing_decision_proof_message', 'Approve, deny, and transaction finalization decisions require the exact wallet proof message.');
    }
    if (input.decisionProofMessage !== expectedMessage) {
      throw new WorkflowServiceError(400, 'invalid_decision_proof_message', 'Decision proof message does not match the approval request.');
    }
    if (!input.decisionProofSignature || !verifyWalletSignature({
      walletAddress: session.walletAddress,
      message: expectedMessage,
      signature: input.decisionProofSignature,
      signatureEncoding: input.signatureEncoding ?? 'base58',
    })) {
      throw new WorkflowServiceError(400, 'invalid_decision_proof', 'Decision proof signature could not be verified for this wallet.');
    }
    return expectedMessage;
  }

  private finalizationProofMessageForResult(
    session: WorkflowSession,
    approval: ApprovalRequestRecord,
    input: ApprovalDecisionInput,
    finalization: TransactionFinalizationRecord,
  ): string {
    const inputProofSignature = input.decisionProofSignature ?? input.proofSignature;
    if (
      approval.decisionProofVerified &&
      approval.decisionProofSignature &&
      approval.decisionProofMessage &&
      inputProofSignature === approval.decisionProofSignature &&
      input.decisionProofMessage === approval.decisionProofMessage
    ) {
      return approval.decisionProofMessage;
    }
    return this.requireVerifiedDecisionProof(session, approval, 'approved', input, finalization);
  }

  private async verifySubmittedFinalization(
    finalization: TransactionFinalizationRecord,
    finalizationStatus: TransactionFinalizationStatus,
    input: RecordTransactionFinalizationResultInput,
  ): Promise<TransactionVerificationResult | undefined> {
    if (!input.txid || !requiresSubmittedFinalizationChecks(finalizationStatus)) {
      return undefined;
    }
    return this.transactionVerifier({
      finalization,
      txid: input.txid,
      cluster: finalization.cluster,
    });
  }

  private async activeApprovalForPlan(session: WorkflowSession, planDraftId: string): Promise<ApprovalRequestRecord | undefined> {
    const approvals = (await this.store.listApprovals(session.walletAddress)).map(normalizeApprovalRecord);
    return approvals.find((approval) => approval.planDraftId === planDraftId && isActiveApprovalStatus(approval.status));
  }

  private async activeApprovalForRecurringOccurrence(
    session: WorkflowSession,
    recurringOccurrenceId: string,
    recurringScheduleId?: string,
  ): Promise<ApprovalRequestRecord | undefined> {
    const approvals = (await this.store.listApprovals(session.walletAddress)).map(normalizeApprovalRecord);
    return approvals.find((approval) => {
      return approval.recurringOccurrenceId === recurringOccurrenceId &&
        (!recurringScheduleId || approval.recurringScheduleId === recurringScheduleId) &&
        isActiveApprovalStatus(approval.status);
    });
  }

  private async archiveLinkedPlanForTerminalApproval(
    session: WorkflowSession,
    approval: ApprovalRequestRecord,
    completed: CompletedRecord,
    terminalAt: string,
  ): Promise<void> {
    if (!approval.planDraftId) return;
    const plan = await this.store.getPlan(session.walletAddress, approval.planDraftId);
    if (!plan) return;
    const normalized = normalizePlanRecord(plan);
    if (normalized.approvalRequestId !== approval.id || normalized.status === 'archived') return;

    await this.store.savePlan(session.walletAddress, {
      ...normalized,
      status: 'archived',
      approvalRequestId: approval.id,
      updatedAt: terminalAt,
      metadata: {
        ...(normalized.metadata ?? {}),
        terminalApprovalStatus: approval.status,
        terminalApprovalAt: terminalAt,
        completedRecordId: completed.id,
      },
    });
  }

  private assertPlanPatchAllowed(existing: PlanDraftRecord, input: UpdatePlanInput): void {
    const contentPatch = Object.keys(input).some((key) => !['status', 'signature', 'approvalRequestId'].includes(key));
    if (contentPatch && existing.status !== 'draft') {
      throw new WorkflowServiceError(409, 'plan_not_editable', 'Plan content can only be edited while the plan is a draft.');
    }
    if (input.status && !validPlanTransition(existing.status, input.status)) {
      throw new WorkflowServiceError(409, 'invalid_plan_transition', `Plan cannot transition from ${existing.status} to ${input.status}.`);
    }
  }

  private async audit(
    session: WorkflowSession,
    eventType: string,
    recordType: AuditEventRecord['recordType'],
    recordId: string,
    metadata: JsonObject,
  ): Promise<void> {
    await this.store.appendAuditEvent(session.walletAddress, {
      id: this.id('audit'),
      walletAddress: session.walletAddress,
      type: eventType,
      actor: 'server',
      eventType,
      recordType,
      recordId,
      ...(recordType ? { subjectType: recordType } : {}),
      subjectId: recordId,
      createdAt: this.now(),
      metadata,
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}_${this.idFactory()}`;
  }
}

export function normalizePlanRecord(record: PlanDraftRecord): PlanDraftRecord {
  const raw = record as PlanDraftRecord & Record<string, unknown>;
  const legacyPlan = raw.plan && typeof raw.plan === 'object' && !Array.isArray(raw.plan)
    ? raw.plan as JsonObject
    : undefined;
  return {
    ...raw,
    plan: legacyPlan ?? {},
    title: raw.title ?? stringFromJson(legacyPlan, 'title') ?? stringFromJson(legacyPlan, 'intent') ?? 'Untitled plan',
    intent: raw.intent ?? stringFromJson(legacyPlan, 'intent') ?? 'Untitled plan',
    route: raw.route ?? stringFromJson(legacyPlan, 'route') ?? '',
    risk: raw.risk ?? stringFromJson(legacyPlan, 'risk') ?? '',
    approval: raw.approval ?? stringFromJson(legacyPlan, 'approval') ?? '',
    source: raw.source ?? (stringFromJson(legacyPlan, 'source') === 'ai' ? 'ai' : 'template'),
    category: raw.category ?? stringFromJson(legacyPlan, 'category') ?? 'custom',
    actionType: raw.actionType ?? stringFromJson(legacyPlan, 'actionType') ?? 'manual_review',
    parameters: raw.parameters ?? stringRecordFromJson(legacyPlan?.parameters),
    fields: raw.fields ?? arrayFromJson(legacyPlan?.fields),
    safeguards: raw.safeguards ?? stringArrayFromJson(legacyPlan?.safeguards),
    templateId: raw.templateId ?? stringFromJson(legacyPlan, 'templateId') ?? '',
    templateTitle: raw.templateTitle ?? stringFromJson(legacyPlan, 'templateTitle') ?? '',
    prompt: raw.prompt ?? stringFromJson(legacyPlan, 'prompt') ?? '',
    cluster: raw.cluster ?? 'devnet',
  };
}

export function normalizeApprovalRecord(record: ApprovalRequestRecord): ApprovalRequestRecord {
  const raw = record as ApprovalRequestRecord & Record<string, unknown>;
  const { planId: _planId, ...rest } = raw;
  const metadataRequirement = stringFromJson(raw.riskMetadata, 'finalizationRequirement');
  const finalizationRequirement = raw.finalizationRequirement ??
    (metadataRequirement === 'none' || metadataRequirement === 'wallet_decision_proof' || metadataRequirement === 'transaction_preview'
      ? metadataRequirement
      : undefined) ??
    finalizationRequirementForAction(raw.kind ?? 'manual_review');
  return {
    ...rest,
    cluster: raw.cluster ?? 'devnet',
    kind: raw.kind ?? 'manual_review',
    status: raw.status === 'pending' ? 'ready' : raw.status === 'denied' ? 'rejected' : raw.status,
    finalizationRequirement,
    executionMode: raw.executionMode ?? executionModeForFinalizationRequirement(finalizationRequirement),
    finalizationSupport: raw.finalizationSupport ?? finalizationSupportForKind(raw.kind ?? 'manual_review'),
    ...(typeof raw.planId === 'string' && raw.planDraftId === undefined ? { planDraftId: raw.planId } : {}),
    ...(typeof raw.proofSignature === 'string' && raw.decisionProofSignature === undefined ? { decisionProofSignature: raw.proofSignature } : {}),
  };
}

export function workflowDecisionProofMessage(input: {
  approval: Pick<ApprovalRequestRecord, 'id' | 'walletAddress' | 'cluster' | 'summary' | 'kind' | 'params'>;
  decision: Extract<ApprovalDecision, 'approved' | 'rejected'>;
}): string {
  return sharedWorkflowDecisionProofMessage(input);
}

function planGuardrailReport(input: CreatePlanInput): AiGuardrailReport {
  return assertPlanGuardrails({
    plan: input.plan,
    source: input.source,
    category: input.category,
    actionType: input.actionType,
    templateId: input.templateId,
    templateTitle: input.templateTitle,
    cluster: input.cluster,
    parameters: input.parameters,
    fields: input.fields,
    userNotes: input.userNotes,
    prompt: input.prompt,
  });
}

function planRecordGuardrailReport(record: PlanDraftRecord): AiGuardrailReport {
  return assertPlanGuardrails({
    plan: record.plan,
    source: record.source,
    category: record.category,
    actionType: record.actionType,
    templateId: record.templateId,
    templateTitle: record.templateTitle,
    cluster: record.cluster,
    parameters: record.parameters,
    fields: record.fields,
    userNotes: record.userNotes,
    prompt: record.prompt,
  });
}

function approvalGuardrailReport(
  input: CreateApprovalInput,
  linkedPlan: PlanDraftRecord | undefined,
  kind: string,
  params: JsonObject,
): AiGuardrailReport {
  if (linkedPlan) {
    return assertPlanGuardrails({
      plan: linkedPlan.plan,
      source: linkedPlan.source,
      category: linkedPlan.category,
      actionType: linkedPlan.actionType,
      templateId: linkedPlan.templateId,
      templateTitle: linkedPlan.templateTitle,
      cluster: linkedPlan.cluster,
      parameters: linkedPlan.parameters,
      fields: linkedPlan.fields,
      userNotes: linkedPlan.userNotes,
      prompt: linkedPlan.prompt,
    });
  }

  const plan = input.plan
    ? {
        ...input.plan,
        ...(input.summary ? { summary: input.summary } : {}),
      }
    : {
        intent: input.summary ?? `${kind.replace(/_/g, ' ')} approval`,
        actionType: kind,
        parameters: params,
      };

  return assertPlanGuardrails({
    plan,
    source: stringFromJson(input.plan, 'source') ?? 'template',
    category: stringFromJson(input.plan, 'category') ?? 'custom',
    actionType: kind,
    templateId: stringFromJson(input.plan, 'templateId') ?? '',
    templateTitle: stringFromJson(input.plan, 'templateTitle') ?? '',
    cluster: input.cluster ?? stringFromJson(input.plan, 'cluster') ?? 'devnet',
    parameters: stringRecordFromJson(params),
    fields: arrayFromJson(input.plan?.fields),
    userNotes: stringFromJson(input.plan, 'userNotes'),
    prompt: stringFromJson(input.plan, 'prompt'),
  });
}

function withGuardrailRiskMetadata(
  riskMetadata: JsonObject | undefined,
  report: AiGuardrailReport,
): JsonObject {
  return {
    ...(riskMetadata ?? {}),
    aiGuardrails: jsonObject(report),
    guardrailVerdict: report.verdict,
    finalizationRequirement: report.finalizationRequirement,
    constraintFingerprint: report.constraintFingerprint,
    ...(report.constraintHash ? { constraintHash: report.constraintHash } : {}),
  };
}

function guardrailAuditMetadata(report: AiGuardrailReport): JsonObject {
  return {
    guardrailVerdict: report.verdict,
    finalizationRequirement: report.finalizationRequirement,
    constraintFingerprint: report.constraintFingerprint,
    ...(report.constraintHash ? { constraintHash: report.constraintHash } : {}),
    violationCount: report.violations.length,
    blockedViolationCount: report.violations.filter((violation) => violation.severity === 'block').length,
    warningViolationCount: report.violations.filter((violation) => violation.severity === 'warn').length,
    violationCodes: report.violations.map((violation) => violation.code),
    summary: report.summary,
  };
}

function notFound(message: string): WorkflowServiceError {
  return new WorkflowServiceError(404, 'not_found', message);
}

function isApprovalExistsStoreError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'approval_exists');
}

function sortByUpdatedAt<T extends { updatedAt: string; createdAt: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    return updated === 0 ? right.createdAt.localeCompare(left.createdAt) : updated;
  });
}

function jsonObjectFromPlan(plan: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = plan?.[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return undefined;
}

function stringRecordToJson(record: Record<string, string> | undefined): JsonObject | undefined {
  if (!record) return undefined;
  return { ...record };
}

function amountFromPlan(plan: JsonObject | undefined): string | undefined {
  const params = jsonObjectFromPlan(plan, 'parameters');
  return stringFromJson(params, 'amount') ?? stringFromJson(params, 'amountSol') ?? stringFromJson(params, 'inputAmount');
}

function tokenFromPlan(plan: JsonObject | undefined): string | undefined {
  const params = jsonObjectFromPlan(plan, 'parameters');
  return stringFromJson(params, 'token') ?? stringFromJson(params, 'inputToken') ?? stringFromJson(params, 'outputToken');
}

async function prepareSolTransferFinalizationPreview(
  session: WorkflowSession,
  approval: ApprovalRequestRecord,
  nowIso: string,
): Promise<PreparedTransactionFinalizationPreview> {
  const recipient = requireApprovalConstraint(approval, ['recipient', 'recipientAddress'], approval.recipient, 'recipient');
  const amountSol = requireApprovalConstraint(approval, ['amountSol', 'amount'], approval.amount, 'amount');
  const cluster = approval.cluster ?? 'devnet';
  const from = publicKeyForWorkflow(session.walletAddress, 'approval wallet');
  const to = publicKeyForWorkflow(recipient, 'recipient');
  const normalizedAmount = normalizeDecimalString(amountSol) ?? amountSol.trim();

  if (process.env.AGENTIC_MOCK_FINALIZATION === '1') {
    return mockSolTransferFinalizationPreview({
      approval,
      nowIso,
      cluster,
      sender: from.toBase58(),
      recipient: to.toBase58(),
      amountSol: normalizedAmount,
    });
  }

  const lamports = parseSolLamports(normalizedAmount);
  const connection = new Connection(defaultRpcUrl(cluster), 'confirmed');
  const balance = await connection.getBalance(from, 'confirmed');
  if (BigInt(balance) < BigInt(lamports)) {
    throw new WorkflowServiceError(409, 'insufficient_balance', `Insufficient SOL balance for ${normalizedAmount} SOL plus fees.`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: from,
    recentBlockhash: blockhash,
  }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  const memo = stringFromJson(approval.params, 'memo');
  if (memo) {
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: from, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, 'utf8'),
    }));
  }

  const fee = await connection.getFeeForMessage(tx.compileMessage(), 'confirmed');
  const estimatedFeeLamports = fee.value ?? 5_000;
  if (BigInt(balance) < BigInt(lamports) + BigInt(estimatedFeeLamports)) {
    throw new WorkflowServiceError(409, 'insufficient_balance', `Insufficient SOL balance for ${normalizedAmount} SOL plus estimated fees.`);
  }

  const simulation = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
  } as never);
  const logs = simulation.value.logs ?? [];
  const simulationHash = sha256Hex(stableJson({
    err: simulation.value.err ?? null,
    logs,
    unitsConsumed: simulation.value.unitsConsumed ?? null,
    blockhash,
  }));
  if (simulation.value.err) {
    throw new WorkflowServiceError(409, 'simulation_failed', `Simulation failed: ${stableJson(simulation.value.err)}`);
  }

  const transactionBase64 = txToBase64(tx);
  const transactionHash = sha256Hex(transactionBase64);
  const messageHash = sha256Hex(tx.serializeMessage().toString('base64'));
  const quoteHash = solTransferQuoteHash({
    amountSol: normalizedAmount,
    recipient: to.toBase58(),
    cluster,
  });
  const transactionBoundaryHash = stableWorkflowHash({
    approval: approval.id,
    walletAddress: approval.walletAddress,
    cluster,
    kind: approval.kind,
    params: approval.params,
  });

  return {
    transactionBase64,
    preview: {
      status: 'simulation_passed',
      walletAction: {
        kind: approval.kind,
        walletAddress: approval.walletAddress,
        cluster,
        summary: `Transfer ${normalizedAmount} SOL to ${to.toBase58()}`,
        sender: from.toBase58(),
        recipient: to.toBase58(),
        amount: normalizedAmount,
        token: 'SOL',
        feePayer: from.toBase58(),
        estimatedFeeLamports: String(estimatedFeeLamports),
        ...(memo ? { memo } : {}),
        instructionSummary: memo ? [`Transfer ${normalizedAmount} SOL`, `Memo: ${memo}`] : [`Transfer ${normalizedAmount} SOL`],
        touchedPrograms: memo ? [SystemProgram.programId.toBase58(), MEMO_PROGRAM_ID.toBase58()] : [SystemProgram.programId.toBase58()],
        metadata: {
          walletMethod: 'signAndSendTransaction',
          lastValidBlockHeight,
          blockhash,
        },
      },
      transactionHash,
      messageHash,
      quote: {
        provider: 'agentic-server-fixed-transfer',
        fetchedAt: nowIso,
        inputToken: 'SOL',
        inputAmount: normalizedAmount,
        outputToken: 'SOL',
        expectedOutputAmount: normalizedAmount,
        minimumOutputAmount: normalizedAmount,
        priceImpact: '0',
        routeLabel: 'SystemProgram.transfer',
        quoteHash,
      },
      simulation: {
        status: 'ok',
        simulatedAt: nowIso,
        logs,
        ...(simulation.value.unitsConsumed !== undefined ? { unitsConsumed: simulation.value.unitsConsumed } : {}),
        simulationHash,
      },
      expiresAt: new Date(Date.parse(nowIso) + FINALIZATION_PREVIEW_TTL_MS).toISOString(),
      metadata: {
        transactionBoundaryHash,
        preparedBy: 'agentic-render-web',
        serverPrepared: true,
        transactionBoundary: 'server_wallet_finalization_v1',
      },
    },
  };
}

function mockSolTransferFinalizationPreview(input: {
  approval: ApprovalRequestRecord;
  nowIso: string;
  cluster: WorkflowCluster;
  sender: string;
  recipient: string;
  amountSol: string;
}): PreparedTransactionFinalizationPreview {
  const transactionBase64 = Buffer.from(stableJson({
    approval: input.approval.id,
    sender: input.sender,
    recipient: input.recipient,
    amountSol: input.amountSol,
    cluster: input.cluster,
    kind: input.approval.kind,
  })).toString('base64');
  const transactionHash = sha256Hex(transactionBase64);
  const messageHash = sha256Hex(`mock-message:${transactionHash}`);
  const quoteHash = solTransferQuoteHash({
    amountSol: input.amountSol,
    recipient: input.recipient,
    cluster: input.cluster,
  });
  const simulationHash = sha256Hex(stableJson({
    status: 'ok',
    transactionHash,
    mocked: true,
  }));

  return {
    transactionBase64,
    preview: {
      status: 'simulation_passed',
      walletAction: {
        kind: input.approval.kind,
        walletAddress: input.approval.walletAddress,
        cluster: input.cluster,
        summary: `Transfer ${input.amountSol} SOL to ${input.recipient}`,
        sender: input.sender,
        recipient: input.recipient,
        amount: input.amountSol,
        token: 'SOL',
        feePayer: input.sender,
        instructionSummary: [`Transfer ${input.amountSol} SOL`],
        touchedPrograms: [SystemProgram.programId.toBase58()],
        metadata: {
          walletMethod: 'signAndSendTransaction',
          mocked: true,
        },
      },
      transactionHash,
      messageHash,
      quote: {
        provider: 'agentic-server-mock-transfer',
        fetchedAt: input.nowIso,
        inputToken: 'SOL',
        inputAmount: input.amountSol,
        outputToken: 'SOL',
        expectedOutputAmount: input.amountSol,
        minimumOutputAmount: input.amountSol,
        priceImpact: '0',
        routeLabel: 'SystemProgram.transfer',
        quoteHash,
      },
      simulation: {
        status: 'ok',
        simulatedAt: input.nowIso,
        logs: ['mock simulation passed'],
        simulationHash,
        metadata: { mocked: true },
      },
      expiresAt: new Date(Date.parse(input.nowIso) + FINALIZATION_PREVIEW_TTL_MS).toISOString(),
      metadata: {
        transactionBoundaryHash: stableWorkflowHash({
          approval: input.approval.id,
          walletAddress: input.approval.walletAddress,
          cluster: input.cluster,
          kind: input.approval.kind,
          params: input.approval.params,
        }),
        preparedBy: 'agentic-render-web',
        serverPrepared: true,
        mocked: true,
        transactionBoundary: 'server_wallet_finalization_v1',
      },
    },
  };
}

function publicKeyForWorkflow(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new WorkflowServiceError(400, 'invalid_public_key', `${label} must be a valid Solana public key.`);
  }
}

function parseSolLamports(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) throw new WorkflowServiceError(400, 'invalid_sol_amount', 'SOL amount must be a positive decimal with at most 9 decimal places.');
  const whole = BigInt(match[1] ?? '0');
  const fractional = BigInt((match[2] ?? '').padEnd(9, '0'));
  const lamports = whole * 1_000_000_000n + fractional;
  if (lamports <= 0n) throw new WorkflowServiceError(400, 'invalid_sol_amount', 'SOL amount must be greater than zero.');
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkflowServiceError(400, 'sol_amount_too_large', 'SOL amount is too large to prepare safely.');
  }
  return Number(lamports);
}

function txToBase64(tx: Transaction): string {
  return Buffer.from(tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  })).toString('base64');
}

async function verifySolanaTransactionFinalization(
  input: TransactionVerificationRequest,
): Promise<TransactionVerificationResult> {
  if (process.env.AGENTIC_MOCK_FINALIZATION === '1') {
    return mockSolanaTransactionVerification(input);
  }
  const connection = new Connection(defaultRpcUrl(input.cluster), 'confirmed');
  try {
    const response = await connection.getTransaction(input.txid, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!response) {
      const status = await connection.getSignatureStatus(input.txid, { searchTransactionHistory: true });
      if (status.value?.err) {
        return {
          status: 'failed',
          txStatus: 'failed',
          confirmationStatus: status.value.confirmationStatus ?? 'failed',
          error: stableJson(status.value.err),
        };
      }
      return {
        status: 'pending',
        txStatus: 'pending',
        ...(status.value?.confirmationStatus ? { confirmationStatus: status.value.confirmationStatus } : {}),
      };
    }

    if (response.meta?.err) {
      return {
        status: 'failed',
        txStatus: 'failed',
        confirmationStatus: 'failed',
        slot: response.slot,
        error: stableJson(response.meta.err),
      };
    }

    const messageHash = transactionMessageHash(response.transaction.message);
    if (input.finalization.messageHash && messageHash !== input.finalization.messageHash) {
      return {
        status: 'message_mismatch',
        txStatus: 'failed',
        confirmationStatus: 'message_mismatch',
        messageHash,
        slot: response.slot,
        error: 'Submitted transaction message did not match the prepared finalization.',
      };
    }

    return {
      status: 'confirmed',
      txStatus: 'confirmed',
      confirmationStatus: 'confirmed',
      messageHash,
      slot: response.slot,
    };
  } catch (err) {
    return {
      status: 'pending',
      txStatus: 'pending',
      confirmationStatus: 'verification_unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function mockSolanaTransactionVerification(input: TransactionVerificationRequest): TransactionVerificationResult {
  return {
    status: 'confirmed',
    txStatus: 'confirmed',
    confirmationStatus: 'confirmed',
    ...(input.finalization.messageHash ? { messageHash: input.finalization.messageHash } : {}),
    slot: 0,
    metadata: { mocked: true },
  };
}

function transactionMessageHash(message: unknown): string {
  const serializable = message as { serialize?: () => Uint8Array | number[] };
  if (typeof serializable.serialize !== 'function') {
    throw new Error('RPC transaction message was not serializable.');
  }
  return sha256Hex(Buffer.from(serializable.serialize()).toString('base64'));
}

function solTransferQuoteHash(input: {
  amountSol: string;
  recipient: string;
  cluster: WorkflowCluster;
}): string {
  return sha256Hex(stableJson({
    kind: 'fixed_sol_transfer',
    amountSol: input.amountSol,
    recipient: input.recipient,
    cluster: input.cluster,
  }));
}

function defaultRpcUrl(cluster: WorkflowCluster): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_RPC_URL) return process.env.HELIUS_RPC_URL;
  switch (cluster) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    case 'localnet':
      return 'http://127.0.0.1:8899';
    case 'devnet':
    default:
      return 'https://api.devnet.solana.com';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function finalizationStatusFromTxStatus(status: TxStatus | undefined): TransactionFinalizationStatus {
  if (status === 'confirmed') return 'confirmed';
  if (status === 'failed') return 'failed';
  return 'submitted';
}

function txStatusFromFinalizationStatus(
  status: TransactionFinalizationStatus,
  fallback: TxStatus | undefined,
): TxStatus | undefined {
  if (fallback) return fallback;
  if (status === 'confirmed') return 'confirmed';
  if (status === 'failed' || status === 'blocked' || status === 'expired') return 'failed';
  if (status === 'submitted' || status === 'wallet_pending') return 'pending';
  return undefined;
}

function finalizationStatusFromVerification(result: TransactionVerificationResult): TransactionFinalizationStatus {
  if (result.status === 'confirmed') return 'confirmed';
  if (result.status === 'pending') return 'submitted';
  return 'failed';
}

function verificationErrorMessage(result: TransactionVerificationResult | undefined): string | undefined {
  if (!result) return undefined;
  if (result.status === 'message_mismatch') {
    return result.error ?? 'Submitted transaction message did not match the prepared finalization.';
  }
  if (result.status === 'failed') {
    return result.error ?? 'Submitted transaction failed verification.';
  }
  return undefined;
}

function verificationMetadata(result: TransactionVerificationResult, checkedAt: string): JsonObject {
  return {
    ...(result.metadata ?? {}),
    status: result.status,
    checkedAt,
    source: 'server_rpc',
    ...(result.txStatus ? { txStatus: result.txStatus } : {}),
    ...(result.confirmationStatus ? { confirmationStatus: result.confirmationStatus } : {}),
    ...(result.messageHash ? { messageHash: result.messageHash } : {}),
    ...(result.slot !== undefined ? { slot: result.slot } : {}),
    ...(result.error ? { error: redactVerifierError(result.error) } : {}),
  };
}

function redactVerifierError(message: string): string {
  return message.replace(/https?:\/\/\S+/g, '[url]').slice(0, 500);
}

function activeApprovalStatusForFinalization(
  status: TransactionFinalizationStatus,
  existingStatus: ApprovalRequestRecord['status'],
): ApprovalRequestRecord['status'] {
  if (status === 'submitted' || status === 'wallet_pending') return 'approval_pending';
  if (
    existingStatus === 'approval_pending' &&
    (status === 'failed' || status === 'aborted' || status === 'expired' || status === 'blocked')
  ) {
    return 'ready';
  }
  return existingStatus;
}

function requiresSubmittedFinalizationChecks(status: TransactionFinalizationStatus): boolean {
  return status === 'wallet_pending' || status === 'submitted' || status === 'confirmed';
}

function requiresFinalizationIntegrityChecks(
  status: TransactionFinalizationStatus,
  input: RecordTransactionFinalizationResultInput,
): boolean {
  return requiresSubmittedFinalizationChecks(status) || (status === 'failed' && Boolean(input.txid));
}

function requiresFinalizationProof(
  status: TransactionFinalizationStatus,
  input: RecordTransactionFinalizationResultInput,
): boolean {
  return status === 'submitted' || status === 'confirmed' || (status === 'failed' && Boolean(input.txid));
}

function isServerPreparedFinalization(finalization: TransactionFinalizationRecord): boolean {
  return finalization.metadata?.serverPrepared === true;
}

function finalizationSubmissionExpired(
  finalization: TransactionFinalizationRecord,
  input: RecordTransactionFinalizationResultInput,
  nowIso: string,
): boolean {
  if (Date.parse(finalization.expiresAt) > Date.parse(nowIso)) return false;
  return !finalization.submittedAt || !finalization.txid || finalization.txid !== input.txid;
}

function proofOnlyDecisionCarriesTransactionFields(input: ApprovalDecisionInput): boolean {
  return Boolean(
    input.txid ||
    input.txStatus ||
    input.confirmationStatus ||
    input.explorerUrl ||
    input.finalizationId ||
    input.finalizationStatus ||
    input.transactionHash ||
    input.messageHash ||
    input.quoteHash ||
    input.simulationHash,
  );
}

function finalizationExpiry(inputExpiresAt: string | undefined, nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  const fallback = new Date(nowMs + FINALIZATION_PREVIEW_TTL_MS).toISOString();
  if (!inputExpiresAt) return fallback;
  const expiresMs = Date.parse(inputExpiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new WorkflowServiceError(400, 'invalid_finalization_expiry', 'Finalization expiry must be a valid ISO timestamp.');
  }
  if (expiresMs <= nowMs) {
    throw new WorkflowServiceError(400, 'invalid_finalization_expiry', 'Finalization expiry must be in the future.');
  }
  if (expiresMs - nowMs > MAX_FINALIZATION_PREVIEW_TTL_MS) {
    throw new WorkflowServiceError(400, 'finalization_expiry_too_long', 'Finalization expiry is too far in the future.');
  }
  return new Date(expiresMs).toISOString();
}

function finalizationMetadata(
  metadata: JsonObject | undefined,
  approval: ApprovalRequestRecord,
): JsonObject {
  const guardrails = jsonObjectFromPlan(approval.riskMetadata, 'aiGuardrails');
  return {
    ...(metadata ?? {}),
    ...(guardrails ? { aiGuardrails: guardrails } : {}),
    ...(stringFromJson(approval.riskMetadata, 'guardrailVerdict')
      ? { guardrailVerdict: stringFromJson(approval.riskMetadata, 'guardrailVerdict') }
      : {}),
    ...(stringFromJson(approval.riskMetadata, 'finalizationRequirement')
      ? { finalizationRequirement: stringFromJson(approval.riskMetadata, 'finalizationRequirement') }
      : {}),
    ...(stringFromJson(approval.riskMetadata, 'constraintFingerprint')
      ? { constraintFingerprint: stringFromJson(approval.riskMetadata, 'constraintFingerprint') }
      : {}),
    ...(stringFromJson(approval.riskMetadata, 'constraintHash')
      ? { constraintHash: stringFromJson(approval.riskMetadata, 'constraintHash') }
      : {}),
  };
}

function trustedFinalizationMetadata(metadata: JsonObject | undefined, trustedServerPrepared: boolean): JsonObject | undefined {
  if (trustedServerPrepared || !metadata) return metadata;
  const sanitized = { ...metadata };
  delete sanitized.serverPrepared;
  delete sanitized.preparedBy;
  return sanitized;
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function validPlanTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'signed' || to === 'archived';
  if (from === 'signed') return to === 'archived';
  return false;
}

export function requiresTransactionFinalization(kind: string): boolean {
  return workflowRequiresTransactionFinalization(kind);
}

function executionModeForFinalizationRequirement(requirement: FinalizationRequirement): 'proof_only' | 'wallet_execute' {
  return requirement === 'transaction_preview' ? 'wallet_execute' : 'proof_only';
}

function finalizationSupportForKind(kind: string): { required: boolean; supported: boolean; reason?: string } {
  const required = workflowRequiresTransactionFinalization(kind);
  if (!required) return { required: false, supported: true };
  if (kind === 'transfer_sol') return { required: true, supported: true };
  return {
    required: true,
    supported: false,
    reason: 'Cloud browser finalization currently supports SOL transfers only. Use private local mode or reject this request.',
  };
}

function assertCloudApprovalKindSupported(kind: string): void {
  const support = finalizationSupportForKind(kind);
  if (support.required && !support.supported) {
    throw new WorkflowServiceError(
      409,
      'unsupported_cloud_finalization_kind',
      support.reason ?? 'This approval kind is not supported by Agentic Cloud transaction finalization yet.',
    );
  }
}

function assertFinalizationMatchesApproval(
  approval: ApprovalRequestRecord,
  input: CreateTransactionFinalizationPreviewInput,
): void {
  if (!workflowRequiresTransactionFinalization(approval.kind)) return;
  const support = finalizationSupportForKind(approval.kind);
  if (support.required && !support.supported) {
    throw new WorkflowServiceError(
      409,
      'unsupported_cloud_finalization_kind',
      support.reason ?? 'This approval kind is not supported by Agentic Cloud transaction finalization yet.',
    );
  }
  if (input.walletAction.kind !== approval.kind) {
    throw new WorkflowServiceError(409, 'finalization_kind_mismatch', 'Finalization wallet action kind does not match the approval.');
  }
  if (approval.kind === 'transfer_sol') {
    const recipient = requireApprovalConstraint(approval, ['recipient', 'recipientAddress'], approval.recipient, 'recipient');
    const amount = requireApprovalConstraint(approval, ['amountSol', 'amount'], approval.amount, 'amount');
    if (input.walletAction.sender && input.walletAction.sender !== approval.walletAddress) {
      throw new WorkflowServiceError(409, 'finalization_sender_mismatch', 'Finalization sender does not match the approval wallet.');
    }
    if (input.walletAction.recipient !== recipient) {
      throw new WorkflowServiceError(409, 'finalization_recipient_mismatch', 'Finalization recipient does not match the approved recipient.');
    }
    if (!decimalStringsEqual(input.walletAction.amount, amount)) {
      throw new WorkflowServiceError(409, 'finalization_amount_mismatch', 'Finalization amount does not match the approved amount.');
    }
    if ((input.walletAction.token ?? 'SOL').toUpperCase() !== 'SOL') {
      throw new WorkflowServiceError(409, 'finalization_token_mismatch', 'Finalization token does not match the approved token.');
    }
    if (input.quote?.inputToken && input.quote.inputToken.toUpperCase() !== 'SOL') {
      throw new WorkflowServiceError(409, 'finalization_token_mismatch', 'Finalization quote token does not match the approved token.');
    }
    if (input.quote?.inputAmount && !decimalStringsEqual(input.quote.inputAmount, amount)) {
      throw new WorkflowServiceError(409, 'finalization_amount_mismatch', 'Finalization quote amount does not match the approved amount.');
    }
  }
}

function requireApprovalConstraint(
  approval: ApprovalRequestRecord,
  keys: string[],
  fallback: string | undefined,
  label: string,
): string {
  for (const key of keys) {
    const value = stringFromJson(approval.params, key);
    if (value) return value;
  }
  if (fallback) return fallback;
  throw new WorkflowServiceError(409, 'finalization_constraint_missing', `Approval is missing a locked ${label} constraint.`);
}

function decimalStringsEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const normalizedLeft = normalizeDecimalString(left);
  const normalizedRight = normalizeDecimalString(right);
  if (!normalizedLeft || !normalizedRight) return left.trim() === right.trim();
  return normalizedLeft === normalizedRight;
}

function normalizeDecimalString(value: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const whole = (match[1] ?? '0').replace(/^0+(?=\d)/, '') || '0';
  const fractional = (match[2] ?? '').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole;
}

function isPlanContentPatch(input: UpdatePlanInput): boolean {
  return Object.keys(input).some((key) => !['status', 'signature', 'approvalRequestId'].includes(key));
}

function stringRecordFromJson(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') output[key] = entry;
  }
  return output;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = sortJson(entry);
    }
    return sorted;
  }
  return value;
}

function arrayFromJson(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is { label: string; value: string } => {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) &&
      typeof (entry as { label?: unknown }).label === 'string' &&
      typeof (entry as { value?: unknown }).value === 'string');
  });
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
