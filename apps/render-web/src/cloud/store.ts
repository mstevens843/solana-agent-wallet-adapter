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
});

export interface CloudWorkspaceDeleteStore {
  deleteCloudWorkspace(walletAddress: string): Promise<CloudWorkspaceDeleteCounts>;
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
