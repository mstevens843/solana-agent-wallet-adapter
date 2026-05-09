import { randomUUID } from 'node:crypto';

import {
  isActiveApprovalStatus,
  isTerminalApprovalStatus,
  type ApprovalRequestRecord,
  type AuditEventRecord,
  type CompletedRecord,
  type JsonObject,
  type PlanDraftRecord,
} from '@solana-agent-wallet-adapter/workflow';

import { completedRecordFromApproval } from './receiptService.js';
import type {
  ApprovalDecision,
  ApprovalDecisionInput,
  CreateApprovalInput,
  CreatePlanInput,
  UpdatePlanInput,
  WorkflowSession,
} from './workflowValidation.js';
import {
  normalizeCompletedRecord,
  stringFromJson,
} from './workflowValidation.js';

export interface WorkflowStore {
  listPlans(walletAddress: string): Promise<PlanDraftRecord[]>;
  getPlan(walletAddress: string, id: string): Promise<PlanDraftRecord | undefined>;
  savePlan(walletAddress: string, record: PlanDraftRecord): Promise<void>;
  deletePlan(walletAddress: string, id: string): Promise<boolean>;
  listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]>;
  getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined>;
  saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void>;
  listCompleted(walletAddress: string): Promise<CompletedRecord[]>;
  getCompleted(walletAddress: string, id: string): Promise<CompletedRecord | undefined>;
  saveCompleted(walletAddress: string, record: CompletedRecord): Promise<void>;
  deleteCompleted(walletAddress: string, id: string): Promise<boolean>;
  appendAuditEvent(walletAddress: string, record: AuditEventRecord): Promise<void>;
}

interface WorkflowServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
}

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

  constructor(
    private readonly store: WorkflowStore,
    options: WorkflowServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  async createPlan(session: WorkflowSession, input: CreatePlanInput): Promise<PlanDraftRecord> {
    const now = this.now();
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
      ...(input.riskMetadata ? { riskMetadata: input.riskMetadata } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      status: input.status ?? 'draft',
      ...(input.signature ? { signature: input.signature } : {}),
    };

    await this.store.savePlan(session.walletAddress, record);
    await this.audit(session, 'plan.created', 'plan', record.id, { status: record.status });
    return record;
  }

  async listPlans(session: WorkflowSession): Promise<PlanDraftRecord[]> {
    return sortByUpdatedAt((await this.store.listPlans(session.walletAddress)).map(normalizePlanRecord));
  }

  async updatePlan(session: WorkflowSession, id: string, input: UpdatePlanInput): Promise<PlanDraftRecord> {
    const existing = await this.requirePlan(session, id);
    this.assertPlanPatchAllowed(existing, input);
    const updated: PlanDraftRecord = {
      ...existing,
      ...input,
      updatedAt: this.now(),
    };

    await this.store.savePlan(session.walletAddress, updated);
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

    const plan = input.plan;
    const kind = input.kind ?? linkedPlan?.actionType ?? stringFromJson(plan, 'actionType') ?? 'manual_review';
    const summary = input.summary ?? linkedPlan?.intent ?? stringFromJson(plan, 'intent') ?? `${kind.replace(/_/g, ' ')} approval`;
    const params = input.params ?? stringRecordToJson(linkedPlan?.parameters) ?? jsonObjectFromPlan(plan, 'parameters') ?? {};

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
      ...(input.riskMetadata ? { riskMetadata: input.riskMetadata } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await this.store.saveApproval(session.walletAddress, record);
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
    });
    return record;
  }

  async listActiveApprovals(session: WorkflowSession): Promise<ApprovalRequestRecord[]> {
    const approvals = (await this.store.listApprovals(session.walletAddress)).map(normalizeApprovalRecord);
    return sortByUpdatedAt(approvals.filter((approval) => isActiveApprovalStatus(approval.status)));
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

    const completedAt = this.now();
    const approval: ApprovalRequestRecord = {
      ...existing,
      status: decision,
      updatedAt: completedAt,
      confirmedAt: completedAt,
      ...(input.decisionProofSignature ? { decisionProofSignature: input.decisionProofSignature } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.txid ? { txid: input.txid } : {}),
      ...(input.error ? { error: input.error } : {}),
      metadata: {
        ...(existing.metadata ?? {}),
        ...(input.explorerUrl ? { explorerUrl: input.explorerUrl } : {}),
      },
    };
    const completed = completedRecordFromApproval(approval);

    await this.store.saveApproval(session.walletAddress, approval);
    await this.store.saveCompleted(session.walletAddress, completed);
    await this.audit(session, `approval.${decision}`, 'approval', approval.id, {
      completedId: completed.id,
      status: decision,
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

  private async activeApprovalForPlan(session: WorkflowSession, planDraftId: string): Promise<ApprovalRequestRecord | undefined> {
    const approvals = (await this.store.listApprovals(session.walletAddress)).map(normalizeApprovalRecord);
    return approvals.find((approval) => approval.planDraftId === planDraftId && isActiveApprovalStatus(approval.status));
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
  return {
    ...rest,
    cluster: raw.cluster ?? 'devnet',
    kind: raw.kind ?? 'manual_review',
    status: raw.status === 'pending' ? 'ready' : raw.status === 'denied' ? 'rejected' : raw.status,
    ...(typeof raw.planId === 'string' && raw.planDraftId === undefined ? { planDraftId: raw.planId } : {}),
    ...(typeof raw.proofSignature === 'string' && raw.decisionProofSignature === undefined ? { decisionProofSignature: raw.proofSignature } : {}),
  };
}

function notFound(message: string): WorkflowServiceError {
  return new WorkflowServiceError(404, 'not_found', message);
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

function validPlanTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'draft') return to === 'signed' || to === 'archived';
  if (from === 'signed') return to === 'archived';
  return false;
}

function stringRecordFromJson(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') output[key] = entry;
  }
  return output;
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
