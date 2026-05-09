import type {
  AuditEventRecord,
  AuthNonceRecord,
  WalletScopedWorkflowStore,
  WalletSessionRecord,
  WorkflowStore as SessionWorkflowStore,
} from './store.js';
import type {
  ApprovalRequestRecord,
  AuditEventRecord as WorkflowAuditEventRecord,
  CompletedRecord,
  PlanDraftRecord,
  TransactionFinalizationRecord,
} from '@solana-agent-wallet-adapter/workflow';
import type { WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';

export class MemoryWorkflowStore implements SessionWorkflowStore, OneTimeWorkflowStore {
  private readonly nonces = new Map<string, AuthNonceRecord>();
  private readonly sessions = new Map<string, WalletSessionRecord>();
  private readonly auditEvents = new Map<string, AuditEventRecord[]>();
  private readonly plans = new Map<string, PlanDraftRecord>();
  private readonly approvals = new Map<string, ApprovalRequestRecord>();
  private readonly completed = new Map<string, CompletedRecord>();
  private readonly finalizations = new Map<string, TransactionFinalizationRecord>();

  async createAuthNonce(record: AuthNonceRecord): Promise<void> {
    await this.cleanupExpired(record.createdAt);
    this.nonces.set(record.nonce, clone(record));
  }

  async getAuthNonce(nonce: string): Promise<AuthNonceRecord | undefined> {
    const record = this.nonces.get(nonce);
    return record ? clone(record) : undefined;
  }

  async consumeAuthNonce(nonce: string, consumedAt: string): Promise<AuthNonceRecord | undefined> {
    const record = this.nonces.get(nonce);
    if (!record || record.consumedAt || Date.parse(record.expiresAt) <= Date.parse(consumedAt)) {
      return undefined;
    }
    const consumed = { ...record, consumedAt };
    this.nonces.set(nonce, consumed);
    return clone(consumed);
  }

  async createSession(record: WalletSessionRecord): Promise<void> {
    await this.cleanupExpired(record.createdAt);
    this.sessions.set(record.tokenHash, clone(record));
  }

  async getSession(tokenHash: string): Promise<WalletSessionRecord | undefined> {
    const record = this.sessions.get(tokenHash);
    return record ? clone(record) : undefined;
  }

  async touchSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    const record = this.sessions.get(tokenHash);
    if (!record || record.revokedAt) return;
    this.sessions.set(tokenHash, { ...record, lastSeenAt });
  }

  async deleteSession(tokenHash: string, revokedAt: string): Promise<void> {
    const record = this.sessions.get(tokenHash);
    if (!record) return;
    this.sessions.set(tokenHash, { ...record, revokedAt });
  }

  async cleanupExpired(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    for (const [nonce, record] of this.nonces) {
      if (Date.parse(record.expiresAt) <= now || record.consumedAt) {
        this.nonces.delete(nonce);
      }
    }
    for (const [tokenHash, record] of this.sessions) {
      if (Date.parse(record.expiresAt) <= now || record.revokedAt) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  forWallet(walletAddress: string): WalletScopedWorkflowStore {
    return {
      walletAddress,
      insertAuditEvent: async (event) => {
        const record = { ...event, walletAddress };
        const events = this.auditEvents.get(walletAddress) ?? [];
        events.push(clone(record));
        this.auditEvents.set(walletAddress, events);
        return clone(record);
      },
      listAuditEvents: async () => {
        return (this.auditEvents.get(walletAddress) ?? []).map(clone);
      },
    };
  }

  async listPlans(walletAddress: string): Promise<PlanDraftRecord[]> {
    return [...this.plans.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getPlan(walletAddress: string, id: string): Promise<PlanDraftRecord | undefined> {
    return ownerClone(this.plans.get(id), walletAddress);
  }

  async savePlan(walletAddress: string, record: PlanDraftRecord): Promise<void> {
    this.plans.set(record.id, clone({ ...record, walletAddress }));
  }

  async deletePlan(walletAddress: string, id: string): Promise<boolean> {
    const record = this.plans.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.plans.delete(id);
  }

  async listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]> {
    return [...this.approvals.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getApproval(walletAddress: string, id: string): Promise<ApprovalRequestRecord | undefined> {
    return ownerClone(this.approvals.get(id), walletAddress);
  }

  async saveApproval(walletAddress: string, record: ApprovalRequestRecord): Promise<void> {
    this.approvals.set(record.id, clone({ ...record, walletAddress }));
  }

  async listCompleted(walletAddress: string): Promise<CompletedRecord[]> {
    return [...this.completed.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getCompleted(walletAddress: string, id: string): Promise<CompletedRecord | undefined> {
    return ownerClone(this.completed.get(id), walletAddress);
  }

  async saveCompleted(walletAddress: string, record: CompletedRecord): Promise<void> {
    this.completed.set(record.id, clone({ ...record, walletAddress }));
  }

  async deleteCompleted(walletAddress: string, id: string): Promise<boolean> {
    const record = this.completed.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.completed.delete(id);
  }

  async listFinalizations(walletAddress: string, approvalRequestId?: string): Promise<TransactionFinalizationRecord[]> {
    return [...this.finalizations.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => approvalRequestId === undefined || record.approvalRequestId === approvalRequestId)
      .map(clone);
  }

  async getFinalization(walletAddress: string, id: string): Promise<TransactionFinalizationRecord | undefined> {
    return ownerClone(this.finalizations.get(id), walletAddress);
  }

  async saveFinalization(walletAddress: string, record: TransactionFinalizationRecord): Promise<void> {
    this.finalizations.set(record.id, clone({ ...record, walletAddress }));
  }

  async appendAuditEvent(walletAddress: string, record: WorkflowAuditEventRecord): Promise<void> {
    await this.forWallet(walletAddress).insertAuditEvent({
      id: record.id,
      type: record.eventType ?? record.type,
      createdAt: record.createdAt,
      metadata: {
        ...(record.metadata ?? {}),
        ...(record.actor ? { actor: record.actor } : {}),
        ...(record.eventType ? { eventType: record.eventType } : {}),
        ...(record.recordType ? { recordType: record.recordType } : {}),
        ...(record.recordId ? { recordId: record.recordId } : {}),
        ...(record.subjectType ? { subjectType: record.subjectType } : {}),
        ...(record.subjectId ? { subjectId: record.subjectId } : {}),
        ...(record.outcome ? { outcome: record.outcome } : {}),
      },
    });
  }
}

function ownerClone<T extends { walletAddress: string }>(record: T | undefined, walletAddress: string): T | undefined {
  if (!record || record.walletAddress !== walletAddress) return undefined;
  return clone(record);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
