import { createHash, randomUUID } from 'node:crypto';

import type {
  ApprovalRequestRecord,
  AuditEventRecord,
  EvidenceReceiptRecord,
  JsonObject,
  WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';

import { verifyWalletSignature } from './auth.js';
import type { EvidenceStore } from './evidenceService.js';
import { isSkillsStore, type Clock, type SkillExecutionStoreRecord } from './store.js';
import type { WorkflowStore } from './workflowService.js';

type SkillExecutionResult = NonNullable<SkillExecutionStoreRecord['result']>;

export interface RecordSkillExecutionOutcomeInput {
  store: WorkflowStore;
  evidenceStore: EvidenceStore;
  clock: Clock;
  session: WorkflowSession;
  approval: ApprovalRequestRecord;
}

export async function recordSkillExecutionOutcomeForApproval(
  input: RecordSkillExecutionOutcomeInput,
): Promise<void> {
  const { store, evidenceStore, clock, session, approval } = input;
  if (!isSkillsStore(store)) return;

  const outcome = skillExecutionResultForApproval(approval);
  if (!outcome) return;

  const existing = await store.getSkillExecutionByApprovalRequestId(session.walletAddress, approval.id);
  if (!existing) return;
  if (existing.result === outcome && existing.evidenceReceiptId) return;

  const nowIso = clock.now().toISOString();
  const receipt = existing.evidenceReceiptId
    ? await evidenceStore.getEvidence(session.walletAddress, existing.evidenceReceiptId)
    : undefined;
  const receiptRecord = receipt ?? await createSkillEvidenceReceipt({
    evidenceStore,
    session,
    approval,
    execution: existing,
    result: outcome,
    nowIso,
  });

  const execution = mergeExecutionPayload(existing, {
    result: outcome,
    evidenceReceiptId: receiptRecord.id,
    nowIso,
    approval,
  });
  await store.saveSkillExecution(execution);
  await store.appendAuditEvent(session.walletAddress, {
    id: `skill-audit-${randomUUID()}`,
    walletAddress: session.walletAddress,
    type: 'skill.execution.receipted',
    createdAt: nowIso,
    recordType: 'skill_execution',
    recordId: execution.id,
    metadata: {
      installId: execution.installId,
      skillId: execution.skillId,
      approvalRequestId: approval.id,
      evidenceReceiptId: receiptRecord.id,
      result: outcome,
    },
  } satisfies AuditEventRecord);
}

function skillExecutionResultForApproval(
  approval: ApprovalRequestRecord,
): SkillExecutionResult | undefined {
  if (approval.status === 'approved') return 'success';
  if (approval.status === 'rejected' || approval.status === 'cancelled') return 'rejected';
  if (approval.status === 'failed' || approval.status === 'blocked' || approval.status === 'expired') return 'failed';
  return undefined;
}

async function createSkillEvidenceReceipt(input: {
  evidenceStore: EvidenceStore;
  session: WorkflowSession;
  approval: ApprovalRequestRecord;
  execution: SkillExecutionStoreRecord;
  result: SkillExecutionResult;
  nowIso: string;
}): Promise<EvidenceReceiptRecord> {
  const { evidenceStore, session, approval, execution, result, nowIso } = input;
  const payload = skillReceiptPayload({ approval, execution, result });
  const preSignatureHash = sha256Hex(payload);
  const signingMessage = approval.decisionProofMessage
    ?? [
      'Agentic skill execution outcome',
      `Approval: ${approval.id}`,
      `Wallet: ${session.walletAddress}`,
      `Skill: ${execution.skillId}`,
      `Result: ${result}`,
    ].join('\n');
  const signature = approval.decisionProofSignature ?? approval.proofSignature ?? '';
  const verified = Boolean(signature && verifyWalletSignature({
    walletAddress: session.walletAddress,
    message: signingMessage,
    signature,
    signatureEncoding: 'base58',
  }));
  const record: EvidenceReceiptRecord = {
    id: `evidence_skill_${execution.id.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    walletAddress: session.walletAddress,
    cluster: approval.cluster ?? 'mainnet-beta',
    title: `Skill execution: ${execution.skillId}`,
    kind: 'tool_trace_receipt',
    status: result === 'success' ? 'approved' : 'blocked',
    payload,
    preSignatureHash,
    signingMessage,
    signature,
    verified,
    artifactHash: preSignatureHash,
    createdAt: nowIso,
    updatedAt: nowIso,
    receiptType: 'skill_execution_v1',
    summary: `${execution.skillId} ${result}`,
    metadata: {
      skillId: execution.skillId,
      installId: execution.installId,
      approvalRequestId: approval.id,
      result,
      txid: approval.txid ?? '',
      executedAmount: approval.amount ?? stringFromJson(approval.params, 'amount') ?? '',
      gasUsed: '0',
    },
  };
  await evidenceStore.saveEvidence(session.walletAddress, record);
  await evidenceStore.appendEvidenceAuditEvent(session.walletAddress, {
    id: `audit_${randomUUID()}`,
    walletAddress: session.walletAddress,
    type: 'evidence.created',
    recordType: 'evidence',
    recordId: record.id,
    createdAt: nowIso,
    metadata: {
      kind: record.kind,
      status: record.status,
      source: 'skill_execution_lifecycle',
      skillId: execution.skillId,
      approvalRequestId: approval.id,
    },
  });
  return record;
}

function skillReceiptPayload(input: {
  approval: ApprovalRequestRecord;
  execution: SkillExecutionStoreRecord;
  result: SkillExecutionResult;
}): JsonObject {
  const { approval, execution, result } = input;
  return {
    receiptType: 'skill_execution_v1',
    skillId: execution.skillId,
    installId: execution.installId,
    executionId: execution.id,
    approvalRequestId: approval.id,
    result,
    status: approval.status,
    kind: approval.kind,
    cluster: approval.cluster ?? 'mainnet-beta',
    txid: approval.txid ?? '',
  };
}

function mergeExecutionPayload(
  existing: SkillExecutionStoreRecord,
  input: {
    result: SkillExecutionResult;
    evidenceReceiptId: string;
    nowIso: string;
    approval: ApprovalRequestRecord;
  },
): SkillExecutionStoreRecord {
  const execution = isJsonObject(existing.execution) ? existing.execution : {};
  const metadata = isJsonObject(execution.metadata) ? execution.metadata : {};
  const amount = input.approval.amount ?? stringFromJson(input.approval.params, 'amount');
  const mergedExecution: JsonObject = {
    ...execution,
    result: input.result,
    approvedAt: input.result === 'success' ? input.approval.decidedAt ?? input.approval.confirmedAt ?? input.nowIso : '',
    rejectedAt: input.result === 'rejected' ? input.approval.decidedAt ?? input.nowIso : '',
    evidenceReceiptId: input.evidenceReceiptId,
    txid: input.approval.txid ?? '',
    metadata: {
      ...metadata,
      outcomeRecordedAt: input.nowIso,
      ...(amount ? { executedAmount: amount } : {}),
    },
  };
  return {
    ...existing,
    result: input.result,
    evidenceReceiptId: input.evidenceReceiptId,
    ...(input.approval.txid ? { txid: input.approval.txid } : {}),
    execution: mergedExecution,
  };
}

function sha256Hex(value: JsonObject): string {
  return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringFromJson(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
