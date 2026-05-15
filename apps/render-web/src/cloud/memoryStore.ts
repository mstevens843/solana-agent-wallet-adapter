import type {
  AggregatorSnapshotStoreRecord,
  AggregatorStore,
  CloudPreferenceNamespace,
  CloudPreferenceRecord,
  CloudPreferencesStore,
  CloudWorkspaceDeleteCounts,
  CloudWorkspaceDeleteStore,
  AuditEventRecord,
  AuthNonceRecord,
  SignalEmissionStoreRecord,
  SignalFeedStoreRecord,
  SignalSubscriptionStoreRecord,
  SignalsStore,
  SkillExecutionStoreRecord,
  SkillInstallStoreRecord,
  SkillManifestStoreRecord,
  SkillsStore,
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
import type {
  EvidenceAuditEvent,
  EvidenceReceiptRecord,
  EvidenceStore,
} from './evidenceService.js';
import type { WorkflowStore as OneTimeWorkflowStore } from './workflowService.js';
import { emptyCloudWorkspaceDeleteCounts } from './store.js';

export interface AgentPolicyStore {
  getAgentPolicies(walletAddress: string): Promise<AgentPolicyState | undefined>;
  saveAgentPolicies(walletAddress: string, state: AgentPolicyState): Promise<AgentPolicyState>;
}

export interface AgentPolicyState {
  policies: unknown[];
  updatedAt: string;
  version: number;
}

export class MemoryWorkflowStore implements SessionWorkflowStore, OneTimeWorkflowStore, EvidenceStore, CloudWorkspaceDeleteStore, CloudPreferencesStore, AgentPolicyStore, SkillsStore, SignalsStore, AggregatorStore {
  private readonly nonces = new Map<string, AuthNonceRecord>();
  private readonly sessions = new Map<string, WalletSessionRecord>();
  private readonly auditEvents = new Map<string, AuditEventRecord[]>();
  private readonly plans = new Map<string, PlanDraftRecord>();
  private readonly approvals = new Map<string, ApprovalRequestRecord>();
  private readonly completed = new Map<string, CompletedRecord>();
  private readonly finalizations = new Map<string, TransactionFinalizationRecord>();
  private readonly evidenceReceipts = new Map<string, EvidenceReceiptRecord>();
  private readonly preferences = new Map<string, CloudPreferenceRecord>();
  // Layer 2 Skills Hub maps.
  private readonly skillManifests = new Map<string, SkillManifestStoreRecord>();
  private readonly skillInstalls = new Map<string, SkillInstallStoreRecord>();
  private readonly skillExecutions = new Map<string, SkillExecutionStoreRecord>();
  private readonly signalFeeds = new Map<string, SignalFeedStoreRecord>();
  private readonly signalSubscriptions = new Map<string, SignalSubscriptionStoreRecord>();
  private readonly signalEmissions = new Map<string, SignalEmissionStoreRecord>();
  private readonly aggregatorSnapshots = new Map<string, AggregatorSnapshotStoreRecord>();

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

  async getAgentPolicies(walletAddress: string): Promise<AgentPolicyState | undefined> {
    const record = await this.getPreference(walletAddress, 'agent-policies');
    if (!record) return undefined;
    return {
      policies: Array.isArray(record.payload) ? record.payload : [],
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  async saveAgentPolicies(walletAddress: string, state: AgentPolicyState): Promise<AgentPolicyState> {
    const saved = await this.savePreference(walletAddress, {
      namespace: 'agent-policies',
      payload: state.policies,
      updatedAt: state.updatedAt,
      version: state.version,
    });
    return {
      policies: Array.isArray(saved.payload) ? saved.payload : [],
      updatedAt: saved.updatedAt,
      version: saved.version,
    };
  }

  async listPreferences(
    walletAddress: string,
    namespaces?: CloudPreferenceNamespace[],
  ): Promise<CloudPreferenceRecord[]> {
    const namespaceSet = namespaces ? new Set(namespaces) : undefined;
    return [...this.preferences.entries()]
      .filter(([key, record]) => key.startsWith(`${walletAddress}:`) && (!namespaceSet || namespaceSet.has(record.namespace)))
      .map(([, record]) => clone(record))
      .sort((left, right) => left.namespace.localeCompare(right.namespace));
  }

  async getPreference(
    walletAddress: string,
    namespace: CloudPreferenceNamespace,
  ): Promise<CloudPreferenceRecord | undefined> {
    const record = this.preferences.get(preferenceKey(walletAddress, namespace));
    return record ? clone(record) : undefined;
  }

  async savePreference(walletAddress: string, record: CloudPreferenceRecord): Promise<CloudPreferenceRecord> {
    const stored = clone(record);
    this.preferences.set(preferenceKey(walletAddress, record.namespace), stored);
    return clone(stored);
  }

  async listApprovals(walletAddress: string): Promise<ApprovalRequestRecord[]> {
    return [...this.approvals.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async listApprovalsByIds(walletAddress: string, ids: string[]): Promise<ApprovalRequestRecord[]> {
    const idSet = new Set(ids);
    return [...this.approvals.values()]
      .filter((record) => record.walletAddress === walletAddress && idSet.has(record.id))
      .map(clone);
  }

  async listApprovalsByRecurringOccurrenceIds(
    walletAddress: string,
    occurrenceIds: string[],
  ): Promise<ApprovalRequestRecord[]> {
    const idSet = new Set(occurrenceIds);
    return [...this.approvals.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => Boolean(record.recurringOccurrenceId && idSet.has(record.recurringOccurrenceId)))
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

  async listCompletedByIds(walletAddress: string, ids: string[]): Promise<CompletedRecord[]> {
    const idSet = new Set(ids);
    return [...this.completed.values()]
      .filter((record) => record.walletAddress === walletAddress && idSet.has(record.id))
      .map(clone);
  }

  async listCompletedByRecurringOccurrenceIds(
    walletAddress: string,
    occurrenceIds: string[],
  ): Promise<CompletedRecord[]> {
    const idSet = new Set(occurrenceIds);
    return [...this.completed.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => Boolean(record.recurringOccurrenceId && idSet.has(record.recurringOccurrenceId)))
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

  async deleteCloudWorkspace(walletAddress: string): Promise<CloudWorkspaceDeleteCounts> {
    const counts = emptyCloudWorkspaceDeleteCounts();
    const authoredSkillIds = new Set(
      [...this.skillManifests.values()]
        .filter((record) => record.authorWallet === walletAddress)
        .map((record) => record.id),
    );
    counts.nonces = deleteOwned(this.nonces, (record) => record.walletAddress === walletAddress);
    counts.sessions = deleteOwned(this.sessions, (record) => record.walletAddress === walletAddress);
    counts.auditEvents = this.auditEvents.get(walletAddress)?.length ?? 0;
    this.auditEvents.delete(walletAddress);
    counts.preferences = deleteOwned(this.preferences, (_record, key) => key.startsWith(`${walletAddress}:`));
    counts.plans = deleteOwned(this.plans, (record) => record.walletAddress === walletAddress);
    counts.approvals = deleteOwned(this.approvals, (record) => record.walletAddress === walletAddress);
    counts.completedRecords = deleteOwned(this.completed, (record) => record.walletAddress === walletAddress);
    counts.transactionFinalizations = deleteOwned(this.finalizations, (record) => record.walletAddress === walletAddress);
    counts.evidenceReceipts = deleteOwned(this.evidenceReceipts, (record) => record.walletAddress === walletAddress);
    counts.skillInstalls = deleteOwned(this.skillInstalls, (record) => record.walletAddress === walletAddress);
    counts.skillExecutions = deleteOwned(this.skillExecutions, (record) => record.walletAddress === walletAddress);
    counts.signalSubscriptions = deleteOwned(this.signalSubscriptions, (record) => record.followerWallet === walletAddress);
    counts.signalEmissions = deleteOwned(this.signalEmissions, (record) => record.publisherWallet === walletAddress);
    counts.signalFeeds = deleteOwned(this.signalFeeds, (record) => record.publisherWallet === walletAddress);
    counts.skillManifests = deleteOwned(this.skillManifests, (record) => record.authorWallet === walletAddress);
    counts.aggregatorSnapshots = deleteOwned(
      this.aggregatorSnapshots,
      (_record, key) => key === `wallet:${walletAddress}` || (
        key.startsWith('skill:') && authoredSkillIds.has(key.slice('skill:'.length))
      ),
    );
    return counts;
  }

  // ───── EvidenceStore ─────
  async listEvidence(walletAddress: string): Promise<EvidenceReceiptRecord[]> {
    return [...this.evidenceReceipts.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getEvidence(walletAddress: string, id: string): Promise<EvidenceReceiptRecord | undefined> {
    return ownerClone(this.evidenceReceipts.get(id), walletAddress);
  }

  async saveEvidence(walletAddress: string, record: EvidenceReceiptRecord): Promise<void> {
    this.evidenceReceipts.set(record.id, clone({ ...record, walletAddress }));
  }

  async deleteEvidence(walletAddress: string, id: string): Promise<boolean> {
    const record = this.evidenceReceipts.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    return this.evidenceReceipts.delete(id);
  }

  async deleteAllEvidence(walletAddress: string): Promise<number> {
    return deleteOwned(this.evidenceReceipts, (record) => record.walletAddress === walletAddress);
  }

  async appendEvidenceAuditEvent(walletAddress: string, event: EvidenceAuditEvent): Promise<void> {
    await this.forWallet(walletAddress).insertAuditEvent({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      metadata: {
        ...event.metadata,
        recordType: event.recordType,
        recordId: event.recordId,
      },
    });
  }

  // ───── Layer 2: SkillsStore ─────
  async saveSkillManifest(record: SkillManifestStoreRecord): Promise<SkillManifestStoreRecord> {
    this.skillManifests.set(record.id, clone(record));
    return clone(record);
  }
  async getSkillManifest(skillId: string): Promise<SkillManifestStoreRecord | undefined> {
    const found = this.skillManifests.get(skillId);
    return found ? clone(found) : undefined;
  }
  async listSkillManifests(): Promise<SkillManifestStoreRecord[]> {
    return Array.from(this.skillManifests.values()).map((r) => clone(r));
  }
  async saveSkillInstall(record: SkillInstallStoreRecord): Promise<SkillInstallStoreRecord> {
    this.skillInstalls.set(record.id, clone(record));
    return clone(record);
  }
  async getSkillInstall(installId: string): Promise<SkillInstallStoreRecord | undefined> {
    const found = this.skillInstalls.get(installId);
    return found ? clone(found) : undefined;
  }
  async listSkillInstallsForWallet(walletAddress: string): Promise<SkillInstallStoreRecord[]> {
    return Array.from(this.skillInstalls.values())
      .filter((r) => r.walletAddress === walletAddress)
      .map((r) => clone(r));
  }
  async listActiveSkillInstalls(): Promise<SkillInstallStoreRecord[]> {
    return Array.from(this.skillInstalls.values())
      .filter((r) => r.status === 'active')
      .map((r) => clone(r));
  }
  async saveSkillExecution(record: SkillExecutionStoreRecord): Promise<SkillExecutionStoreRecord> {
    this.skillExecutions.set(record.id, clone(record));
    return clone(record);
  }
  async getSkillExecutionByApprovalRequestId(
    walletAddress: string,
    approvalRequestId: string,
  ): Promise<SkillExecutionStoreRecord | undefined> {
    const found = Array.from(this.skillExecutions.values())
      .find((r) => r.walletAddress === walletAddress && r.approvalRequestId === approvalRequestId);
    return found ? clone(found) : undefined;
  }
  async listSkillExecutionsByInstall(installId: string): Promise<SkillExecutionStoreRecord[]> {
    return Array.from(this.skillExecutions.values())
      .filter((r) => r.installId === installId)
      .map((r) => clone(r));
  }
  async listSkillExecutionsForSkill(
    skillId: string,
    sinceIso?: string,
  ): Promise<SkillExecutionStoreRecord[]> {
    const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
    return Array.from(this.skillExecutions.values())
      .filter((r) => r.skillId === skillId)
      .filter((r) => Date.parse(r.proposedAt) >= sinceMs)
      .map((r) => clone(r));
  }

  // ───── Layer 2: SignalsStore ─────
  async saveSignalFeed(record: SignalFeedStoreRecord): Promise<SignalFeedStoreRecord> {
    this.signalFeeds.set(record.id, clone(record));
    return clone(record);
  }
  async getSignalFeed(feedId: string): Promise<SignalFeedStoreRecord | undefined> {
    const found = this.signalFeeds.get(feedId);
    return found ? clone(found) : undefined;
  }
  async listSignalFeedsByPublisher(publisherWallet: string): Promise<SignalFeedStoreRecord[]> {
    return Array.from(this.signalFeeds.values())
      .filter((r) => r.publisherWallet === publisherWallet)
      .map((r) => clone(r));
  }
  async saveSignalSubscription(
    record: SignalSubscriptionStoreRecord,
  ): Promise<SignalSubscriptionStoreRecord> {
    this.signalSubscriptions.set(record.id, clone(record));
    return clone(record);
  }
  async listSignalSubscriptionsForFollower(
    followerWallet: string,
  ): Promise<SignalSubscriptionStoreRecord[]> {
    return Array.from(this.signalSubscriptions.values())
      .filter((r) => r.followerWallet === followerWallet)
      .map((r) => clone(r));
  }
  async listSignalSubscriptionsForFeed(feedId: string): Promise<SignalSubscriptionStoreRecord[]> {
    return Array.from(this.signalSubscriptions.values())
      .filter((r) => r.feedId === feedId)
      .map((r) => clone(r));
  }
  async saveSignalEmission(record: SignalEmissionStoreRecord): Promise<SignalEmissionStoreRecord> {
    const normalized = normalizeSignalEmissionRecord(record);
    this.signalEmissions.set(record.id, clone(normalized));
    return clone(normalized);
  }
  async listUndeliveredSignalEmissions(limit = 200): Promise<SignalEmissionStoreRecord[]> {
    return Array.from(this.signalEmissions.values())
      .filter((r) => !r.fanoutProcessedAt)
      .sort((a, b) => a.emittedAt.localeCompare(b.emittedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => clone(r));
  }
  async markSignalEmissionFanoutProcessed(
    emissionId: string,
    delivered: number,
    fanoutProcessedAt: string,
  ): Promise<void> {
    const found = this.signalEmissions.get(emissionId);
    if (!found) return;
    this.signalEmissions.set(
      emissionId,
      normalizeSignalEmissionRecord({
        ...clone(found),
        delivered,
        fanoutProcessedAt,
      }),
    );
  }

  // ───── Layer 2: AggregatorStore ─────
  async saveAggregatorSnapshot(
    record: AggregatorSnapshotStoreRecord,
  ): Promise<AggregatorSnapshotStoreRecord> {
    this.aggregatorSnapshots.set(record.key, clone(record));
    return clone(record);
  }
  async getAggregatorSnapshot(key: string): Promise<AggregatorSnapshotStoreRecord | undefined> {
    const found = this.aggregatorSnapshots.get(key);
    return found ? clone(found) : undefined;
  }
  async listAggregatorSnapshotsByKind(
    kind: 'skill' | 'wallet',
  ): Promise<AggregatorSnapshotStoreRecord[]> {
    return Array.from(this.aggregatorSnapshots.values())
      .filter((r) => r.kind === kind)
      .map((r) => clone(r));
  }
}

function ownerClone<T extends { walletAddress: string }>(record: T | undefined, walletAddress: string): T | undefined {
  if (!record || record.walletAddress !== walletAddress) return undefined;
  return clone(record);
}

function preferenceKey(walletAddress: string, namespace: CloudPreferenceNamespace): string {
  return `${walletAddress}:${namespace}`;
}

function deleteOwned<T>(records: Map<string, T>, predicate: (record: T, key: string) => boolean): number {
  let deleted = 0;
  for (const [id, record] of records) {
    if (predicate(record, id)) {
      records.delete(id);
      deleted += 1;
    }
  }
  return deleted;
}

function normalizeSignalEmissionRecord(record: SignalEmissionStoreRecord): SignalEmissionStoreRecord {
  const emission = record.emission && typeof record.emission === 'object' && !Array.isArray(record.emission)
    ? {
        ...(record.emission as Record<string, unknown>),
        delivered: record.delivered,
        ...(record.fanoutProcessedAt ? { fanoutProcessedAt: record.fanoutProcessedAt } : {}),
      }
    : record.emission;
  return {
    ...record,
    emission,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
