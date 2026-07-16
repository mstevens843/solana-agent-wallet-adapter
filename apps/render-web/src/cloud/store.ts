import {
  capabilitiesForWorkflowMode,
  type SessionResponse as SharedSessionResponse,
  type WalletSession,
  type WorkflowUser,
} from '@solana-agent-wallet-adapter/workflow';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface AuthNonceRecord {
  nonce: string;
  walletAddress: string;
  domain: string;
  issuedAt: string;
  expiresAt: string;
  message: string;
  createdAt: string;
  consumedAt?: string;
}

export interface WalletSessionRecord {
  tokenHash: string;
  walletAddress: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export type SessionResponse = SharedSessionResponse & { expiresAt?: string };

export interface AuditEventRecord {
  id: string;
  walletAddress: string;
  type: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface WalletScopedWorkflowStore {
  readonly walletAddress: string;
  insertAuditEvent(event: Omit<AuditEventRecord, 'walletAddress'>): Promise<AuditEventRecord>;
  listAuditEvents(): Promise<AuditEventRecord[]>;
}

export interface CloudWorkspaceDeleteCounts {
  plans: number;
  approvals: number;
  transactionFinalizations: number;
  recurringSchedules: number;
  recurringOccurrences: number;
  recurringNotificationDeliveries: number;
  evidenceReceipts: number;
  completedRecords: number;
  auditEvents: number;
  nonces: number;
  sessions: number;
  users: number;
  preferences: number;
  skillManifests: number;
  skillInstalls: number;
  skillExecutions: number;
  signalFeeds: number;
  signalSubscriptions: number;
  signalEmissions: number;
  aggregatorSnapshots: number;
  chatSessions: number;
}

export const emptyCloudWorkspaceDeleteCounts = (): CloudWorkspaceDeleteCounts => ({
  plans: 0,
  approvals: 0,
  transactionFinalizations: 0,
  recurringSchedules: 0,
  recurringOccurrences: 0,
  recurringNotificationDeliveries: 0,
  evidenceReceipts: 0,
  completedRecords: 0,
  auditEvents: 0,
  nonces: 0,
  sessions: 0,
  users: 0,
  preferences: 0,
  skillManifests: 0,
  skillInstalls: 0,
  skillExecutions: 0,
  signalFeeds: 0,
  signalSubscriptions: 0,
  signalEmissions: 0,
  aggregatorSnapshots: 0,
  chatSessions: 0,
});

export interface CloudWorkspaceDeleteStore {
  deleteCloudWorkspace(walletAddress: string): Promise<CloudWorkspaceDeleteCounts>;
}

export const CLOUD_PREFERENCE_NAMESPACES = [
  'agent-policies',
  'protocol-connectors',
  'protocol-connector-secrets',
  'safety-rails',
  'failure-policies',
  'custom-tokens',
  'ai-settings',
  'agent-payment-profile',
  'mpp-config',
  'recipient-rules',
  // Server-side push bookkeeping, never read by the client: the last borrow-health bucket we notified
  // per position, so a loan sitting at_risk doesn't re-buzz on every 5-minute poll. Reserved by
  // migration 020 (schema-neutral — wallet_preferences already takes arbitrary namespaces).
  'push-state',
] as const;

export type CloudPreferenceNamespace = (typeof CLOUD_PREFERENCE_NAMESPACES)[number];

export interface CloudPreferenceRecord {
  namespace: CloudPreferenceNamespace;
  payload: unknown;
  updatedAt: string;
  version: number;
}

export interface CloudPreferencesStore {
  listPreferences(walletAddress: string, namespaces?: CloudPreferenceNamespace[]): Promise<CloudPreferenceRecord[]>;
  getPreference(walletAddress: string, namespace: CloudPreferenceNamespace): Promise<CloudPreferenceRecord | undefined>;
  savePreference(walletAddress: string, record: CloudPreferenceRecord): Promise<CloudPreferenceRecord>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat history cloud sync. One row per (wallet, session). `messagesLz` is an
// opaque client-compressed (LZString) blob the server never decompresses — the
// list query returns metadata only so the session list loads cheaply and full
// messages are fetched/decompressed lazily when a chat is opened.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatSessionMetaRecord {
  sessionId: string;
  title: string;
  cluster: string;
  messageCount: number;
  version: number;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionRecord extends ChatSessionMetaRecord {
  messagesLz: string;
}

export interface ChatHistoryStore {
  listChatSessions(walletAddress: string): Promise<ChatSessionMetaRecord[]>;
  getChatSession(walletAddress: string, sessionId: string): Promise<ChatSessionRecord | undefined>;
  saveChatSession(walletAddress: string, record: ChatSessionRecord): Promise<ChatSessionMetaRecord>;
  deleteChatSession(walletAddress: string, sessionId: string): Promise<boolean>;
  clearChatSessions(walletAddress: string): Promise<number>;
}

export function isChatHistoryStore(value: unknown): value is ChatHistoryStore {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChatHistoryStore>;
  return typeof candidate.listChatSessions === 'function'
    && typeof candidate.getChatSession === 'function'
    && typeof candidate.saveChatSession === 'function'
    && typeof candidate.deleteChatSession === 'function'
    && typeof candidate.clearChatSessions === 'function';
}

export interface WorkflowStore {
  createAuthNonce(record: AuthNonceRecord): Promise<void>;
  getAuthNonce(nonce: string): Promise<AuthNonceRecord | undefined>;
  consumeAuthNonce(nonce: string, consumedAt: string): Promise<AuthNonceRecord | undefined>;
  createSession(record: WalletSessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<WalletSessionRecord | undefined>;
  touchSession(tokenHash: string, lastSeenAt: string): Promise<void>;
  deleteSession(tokenHash: string, revokedAt: string): Promise<void>;
  cleanupExpired(nowIso: string): Promise<void>;
  forWallet(walletAddress: string): WalletScopedWorkflowStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 Skills Hub store contracts shared by memory and Postgres stores.
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillManifestStoreRecord {
  id: string;
  version: string;
  authorWallet: string;
  createdAt: string;
  updatedAt: string;
  manifestHash?: string;
  manifest: unknown; // shape: SkillManifest from @solana-agent-wallet-adapter/workflow DevLayer1.skills
}

export interface SkillInstallStoreRecord {
  id: string;
  walletAddress: string;
  skillId: string;
  status: 'active' | 'paused' | 'expired' | 'revoked';
  installedAt: string;
  updatedAt: string;
  install: unknown; // shape: SkillInstallRecord
}

export interface SkillExecutionStoreRecord {
  id: string;
  installId: string;
  walletAddress: string;
  skillId: string;
  proposedAt: string;
  result?: 'pending' | 'success' | 'failed' | 'rejected';
  approvalRequestId?: string;
  evidenceReceiptId?: string;
  execution: unknown; // shape: SkillExecutionRecord
}

export interface SkillsStore {
  saveSkillManifest(record: SkillManifestStoreRecord): Promise<SkillManifestStoreRecord>;
  getSkillManifest(skillId: string): Promise<SkillManifestStoreRecord | undefined>;
  listSkillManifests(): Promise<SkillManifestStoreRecord[]>;
  saveSkillInstall(record: SkillInstallStoreRecord): Promise<SkillInstallStoreRecord>;
  getSkillInstall(installId: string): Promise<SkillInstallStoreRecord | undefined>;
  listSkillInstallsForWallet(walletAddress: string): Promise<SkillInstallStoreRecord[]>;
  listActiveSkillInstalls(): Promise<SkillInstallStoreRecord[]>;
  saveSkillExecution(record: SkillExecutionStoreRecord): Promise<SkillExecutionStoreRecord>;
  getSkillExecutionByApprovalRequestId(
    walletAddress: string,
    approvalRequestId: string,
  ): Promise<SkillExecutionStoreRecord | undefined>;
  listSkillExecutionsByInstall(installId: string): Promise<SkillExecutionStoreRecord[]>;
  listSkillExecutionsForSkill(skillId: string, sinceIso?: string): Promise<SkillExecutionStoreRecord[]>;
}

export interface SignalFeedStoreRecord {
  id: string;
  publisherWallet: string;
  status: 'active' | 'paused' | 'archived';
  createdAt: string;
  updatedAt: string;
  feed: unknown; // shape: SignalFeedRecord
}

export interface SignalSubscriptionStoreRecord {
  id: string;
  followerWallet: string;
  feedId: string;
  status: 'active' | 'paused' | 'revoked';
  subscribedAt: string;
  updatedAt: string;
  subscription: unknown; // shape: SignalSubscriptionRecord
}

export interface SignalEmissionStoreRecord {
  id: string;
  feedId: string;
  publisherWallet: string;
  emittedAt: string;
  delivered: number;
  fanoutProcessedAt?: string;
  emission: unknown; // shape: SignalEmissionRecord
}

export interface SignalsStore {
  saveSignalFeed(record: SignalFeedStoreRecord): Promise<SignalFeedStoreRecord>;
  getSignalFeed(feedId: string): Promise<SignalFeedStoreRecord | undefined>;
  listSignalFeedsByPublisher(publisherWallet: string): Promise<SignalFeedStoreRecord[]>;
  saveSignalSubscription(record: SignalSubscriptionStoreRecord): Promise<SignalSubscriptionStoreRecord>;
  listSignalSubscriptionsForFollower(followerWallet: string): Promise<SignalSubscriptionStoreRecord[]>;
  listSignalSubscriptionsForFeed(feedId: string): Promise<SignalSubscriptionStoreRecord[]>;
  saveSignalEmission(record: SignalEmissionStoreRecord): Promise<SignalEmissionStoreRecord>;
  listUndeliveredSignalEmissions(limit?: number): Promise<SignalEmissionStoreRecord[]>;
  markSignalEmissionFanoutProcessed(
    emissionId: string,
    delivered: number,
    fanoutProcessedAt: string,
  ): Promise<void>;
}

export interface AggregatorSnapshotStoreRecord {
  key: string; // 'skill:friday-dca' | 'wallet:<addr>'
  kind: 'skill' | 'wallet';
  computedAt: string;
  snapshot: unknown; // shape: SkillStatsSnapshot | WalletStatsSnapshot
}

export interface AggregatorStore {
  saveAggregatorSnapshot(record: AggregatorSnapshotStoreRecord): Promise<AggregatorSnapshotStoreRecord>;
  getAggregatorSnapshot(key: string): Promise<AggregatorSnapshotStoreRecord | undefined>;
  listAggregatorSnapshotsByKind(
    kind: 'skill' | 'wallet',
  ): Promise<AggregatorSnapshotStoreRecord[]>;
}

export function isSkillsStore(value: unknown): value is SkillsStore {
  return Boolean(value)
    && typeof (value as SkillsStore).saveSkillManifest === 'function'
    && typeof (value as SkillsStore).getSkillManifest === 'function'
    && typeof (value as SkillsStore).listSkillManifests === 'function'
    && typeof (value as SkillsStore).saveSkillInstall === 'function'
    && typeof (value as SkillsStore).getSkillInstall === 'function'
    && typeof (value as SkillsStore).listSkillInstallsForWallet === 'function'
    && typeof (value as SkillsStore).listActiveSkillInstalls === 'function'
    && typeof (value as SkillsStore).saveSkillExecution === 'function'
    && typeof (value as SkillsStore).getSkillExecutionByApprovalRequestId === 'function'
    && typeof (value as SkillsStore).listSkillExecutionsByInstall === 'function'
    && typeof (value as SkillsStore).listSkillExecutionsForSkill === 'function';
}

export function isSignalsStore(value: unknown): value is SignalsStore {
  return Boolean(value)
    && typeof (value as SignalsStore).saveSignalFeed === 'function'
    && typeof (value as SignalsStore).getSignalFeed === 'function'
    && typeof (value as SignalsStore).listSignalFeedsByPublisher === 'function'
    && typeof (value as SignalsStore).saveSignalSubscription === 'function'
    && typeof (value as SignalsStore).listSignalSubscriptionsForFollower === 'function'
    && typeof (value as SignalsStore).listSignalSubscriptionsForFeed === 'function'
    && typeof (value as SignalsStore).saveSignalEmission === 'function'
    && typeof (value as SignalsStore).listUndeliveredSignalEmissions === 'function'
    && typeof (value as SignalsStore).markSignalEmissionFanoutProcessed === 'function';
}

export function isAggregatorStore(value: unknown): value is AggregatorStore {
  return Boolean(value)
    && typeof (value as AggregatorStore).saveAggregatorSnapshot === 'function'
    && typeof (value as AggregatorStore).getAggregatorSnapshot === 'function'
    && typeof (value as AggregatorStore).listAggregatorSnapshotsByKind === 'function';
}

export function sessionResponse(session: WalletSessionRecord | undefined): SessionResponse {
  if (!session) {
    return {
      signedIn: false,
      capabilities: capabilitiesForWorkflowMode('agentic_cloud'),
    };
  }
  const user = workflowUserFromSession(session);
  const walletSession = walletSessionFromRecord(session, user);
  return {
    signedIn: true,
    capabilities: capabilitiesForWorkflowMode('agentic_cloud'),
    session: walletSession,
    user,
    expiresAt: session.expiresAt,
  };
}

function walletSessionFromRecord(session: WalletSessionRecord, user: WorkflowUser): WalletSession {
  return {
    id: sessionIdFromHash(session.tokenHash),
    walletAddress: session.walletAddress,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    userId: user.id,
    lastSeenAt: session.lastSeenAt,
  };
}

function workflowUserFromSession(session: WalletSessionRecord): WorkflowUser {
  return {
    id: `wallet:${session.walletAddress}`,
    walletAddress: session.walletAddress,
    createdAt: session.createdAt,
    updatedAt: session.lastSeenAt,
    lastSeenAt: session.lastSeenAt,
  };
}

function sessionIdFromHash(tokenHash: string): string {
  return `session:${tokenHash.slice(0, 16)}`;
}
