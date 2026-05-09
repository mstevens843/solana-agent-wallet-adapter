import { randomUUID } from 'node:crypto';

import type {
  CreateEvidenceReceiptRequest,
  EvidenceReceiptKind,
  EvidenceReceiptRecord,
  EvidenceReceiptStatus,
  JsonObject,
  WorkflowSession,
} from '@solana-agent-wallet-adapter/workflow';

import { verifyWalletSignature } from './auth.js';

export {
  EVIDENCE_RECEIPT_KINDS,
  EVIDENCE_RECEIPT_STATUSES,
} from '@solana-agent-wallet-adapter/workflow';

export type {
  EvidenceReceiptKind,
  EvidenceReceiptRecord,
  EvidenceReceiptStatus,
} from '@solana-agent-wallet-adapter/workflow';

export type CreateEvidenceReceiptInput = CreateEvidenceReceiptRequest;

export interface EvidenceStore {
  listEvidence(walletAddress: string): Promise<EvidenceReceiptRecord[]>;
  getEvidence(walletAddress: string, id: string): Promise<EvidenceReceiptRecord | undefined>;
  saveEvidence(walletAddress: string, record: EvidenceReceiptRecord): Promise<void>;
  deleteEvidence(walletAddress: string, id: string): Promise<boolean>;
  deleteAllEvidence(walletAddress: string): Promise<number>;
  appendEvidenceAuditEvent(walletAddress: string, event: EvidenceAuditEvent): Promise<void>;
}

export interface EvidenceAuditEvent {
  id: string;
  walletAddress: string;
  type: string;
  recordType: 'evidence';
  recordId: string;
  createdAt: string;
  metadata: JsonObject;
}

export class EvidenceServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceServiceError';
  }
}

interface EvidenceServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
}

export class EvidenceService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly store: EvidenceStore,
    options: EvidenceServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  async createReceipt(
    session: WorkflowSession,
    input: CreateEvidenceReceiptInput,
  ): Promise<EvidenceReceiptRecord> {
    if (!verifyWalletSignature({
      walletAddress: session.walletAddress,
      message: input.signingMessage,
      signature: input.signature,
      signatureEncoding: 'base58',
    })) {
      throw new EvidenceServiceError(400, 'invalid_signature', 'Evidence receipt signature could not be verified for this wallet.');
    }

    const now = this.now();
    const record: EvidenceReceiptRecord = {
      id: `evidence_${this.idFactory()}`,
      walletAddress: session.walletAddress,
      cluster: input.cluster,
      title: input.title,
      kind: input.kind,
      status: input.status,
      payload: input.payload,
      preSignatureHash: input.preSignatureHash,
      signingMessage: input.signingMessage,
      signature: input.signature,
      verified: true,
      artifactHash: input.artifactHash ?? input.preSignatureHash,
      createdAt: now,
      updatedAt: now,
      ...(input.receiptType ? { receiptType: input.receiptType } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.verdict ? { verdict: input.verdict } : {}),
      ...(input.effect ? { effect: input.effect } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await this.store.saveEvidence(session.walletAddress, record);
    await this.audit(session, 'evidence.created', record.id, evidenceAuditMetadata(record, {
      kind: record.kind,
      status: record.status,
    }));
    return record;
  }

  async listReceipts(session: WorkflowSession): Promise<EvidenceReceiptRecord[]> {
    const records = await this.store.listEvidence(session.walletAddress);
    return [...records].sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt);
      return updated === 0 ? right.createdAt.localeCompare(left.createdAt) : updated;
    });
  }

  async deleteReceipt(session: WorkflowSession, id: string): Promise<void> {
    const existing = await this.store.getEvidence(session.walletAddress, id);
    if (!existing) throw notFound('Evidence receipt was not found.');
    const deleted = await this.store.deleteEvidence(session.walletAddress, id);
    if (!deleted) throw notFound('Evidence receipt was not found.');
    await this.audit(session, 'evidence.deleted', id, evidenceAuditMetadata(existing, { kind: existing.kind }));
  }

  private async audit(session: WorkflowSession, type: string, recordId: string, metadata: JsonObject): Promise<void> {
    await this.store.appendEvidenceAuditEvent(session.walletAddress, {
      id: `audit_${this.idFactory()}`,
      walletAddress: session.walletAddress,
      type,
      recordType: 'evidence',
      recordId,
      createdAt: this.now(),
      metadata,
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function notFound(message: string): EvidenceServiceError {
  return new EvidenceServiceError(404, 'not_found', message);
}

function evidenceAuditMetadata(
  record: EvidenceReceiptRecord,
  base: JsonObject,
): JsonObject {
  const source = auditSourceMetadata(record.metadata);
  return {
    ...base,
    recordType: 'evidence',
    recordId: record.id,
    receiptType: record.receiptType ?? record.kind,
    artifactHash: record.artifactHash,
    ...source,
  };
}

function auditSourceMetadata(metadata: JsonObject | undefined): JsonObject {
  if (!metadata) return {};
  const output: JsonObject = {};
  copyString(metadata, output, 'recordType', 'sourceRecordType');
  copyString(metadata, output, 'recordId', 'sourceRecordId');
  copyString(metadata, output, 'sourceRecordType');
  copyString(metadata, output, 'sourceRecordId');
  copyString(metadata, output, 'subjectType');
  copyString(metadata, output, 'subjectId');
  copyString(metadata, output, 'approvalId');
  copyString(metadata, output, 'proofUseCase');
  copyString(metadata, output, 'labId');
  copyString(metadata, output, 'browserArtifactId');
  copyString(metadata, output, 'recurringScheduleId');
  copyString(metadata, output, 'occurrenceKey');
  copyString(metadata, output, 'finalizationId');
  copyString(metadata, output, 'planDraftId');
  return output;
}

function copyString(source: JsonObject, target: JsonObject, from: string, to = from): void {
  const value = source[from];
  if (typeof value === 'string' && value.trim()) target[to] = value;
}

export class MemoryEvidenceStore implements EvidenceStore {
  private readonly receipts = new Map<string, EvidenceReceiptRecord>();
  private readonly auditEvents: EvidenceAuditEvent[] = [];

  async listEvidence(walletAddress: string): Promise<EvidenceReceiptRecord[]> {
    return [...this.receipts.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getEvidence(walletAddress: string, id: string): Promise<EvidenceReceiptRecord | undefined> {
    const record = this.receipts.get(id);
    if (!record || record.walletAddress !== walletAddress) return undefined;
    return clone(record);
  }

  async saveEvidence(_walletAddress: string, record: EvidenceReceiptRecord): Promise<void> {
    this.receipts.set(record.id, clone(record));
  }

  async deleteEvidence(walletAddress: string, id: string): Promise<boolean> {
    const record = this.receipts.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.receipts.delete(id);
  }

  async deleteAllEvidence(walletAddress: string): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.receipts) {
      if (record.walletAddress === walletAddress) {
        this.receipts.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  async appendEvidenceAuditEvent(_walletAddress: string, event: EvidenceAuditEvent): Promise<void> {
    this.auditEvents.push(clone(event));
  }

  snapshotAuditEvents(): EvidenceAuditEvent[] {
    return this.auditEvents.map(clone);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
