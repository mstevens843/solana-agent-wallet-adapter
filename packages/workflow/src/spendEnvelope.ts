import type {
  ApprovalRequestRecord,
  ApprovalStatus,
  RecurringScheduleRecord,
  RecurringScheduleStatus,
  StreamingSessionRecord,
  StreamingSessionStatus,
} from './index.js';

export type PreparedAction = ApprovalRequestRecord;
export type SessionGrant = StreamingSessionRecord;

export type SpendEnvelope =
  | { kind: 'one-time'; action: PreparedAction }
  | { kind: 'recurring'; schedule: RecurringScheduleRecord }
  | { kind: 'streaming'; session: SessionGrant };

export type SpendEnvelopeStatus =
  | 'needs_approval'
  | 'active'
  | 'paused'
  | 'settled'
  | 'expired'
  | 'cancelled'
  | 'failed';

export interface SpendEnvelopeRemaining {
  label: string;
  amount?: string;
  token?: string;
  spent?: string;
  cap?: string;
  remaining?: string;
  remainingOccurrences?: number;
}

export interface SpendEnvelopeNextEvent {
  label: string;
  at?: string;
}

export interface SpendEnvelopeProtocolBadge {
  id: string;
  label: string;
}

const ACTIVE_APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'pending',
  'scheduled',
  'ready',
  'overdue',
  'approval_pending',
]);

const FAILED_APPROVAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'blocked',
  'failed',
]);

export function envelopeStatus(envelope: SpendEnvelope): SpendEnvelopeStatus {
  switch (envelope.kind) {
    case 'one-time':
      return approvalEnvelopeStatus(envelope.action.status);
    case 'recurring':
      return recurringEnvelopeStatus(envelope.schedule.status);
    case 'streaming':
      return streamingEnvelopeStatus(envelope.session.status);
  }
}

export function envelopeRemaining(envelope: SpendEnvelope): SpendEnvelopeRemaining {
  switch (envelope.kind) {
    case 'one-time':
      return oneTimeRemaining(envelope.action);
    case 'recurring':
      return recurringRemaining(envelope.schedule);
    case 'streaming':
      return streamingRemaining(envelope.session);
  }
}

export function envelopeNextEvent(envelope: SpendEnvelope): SpendEnvelopeNextEvent {
  switch (envelope.kind) {
    case 'one-time':
      return oneTimeNextEvent(envelope.action);
    case 'recurring':
      return recurringNextEvent(envelope.schedule);
    case 'streaming':
      return streamingNextEvent(envelope.session);
  }
}

export function envelopeProtocolBadge(envelope: SpendEnvelope): SpendEnvelopeProtocolBadge {
  switch (envelope.kind) {
    case 'one-time': {
      const connectorId = stringFromRecord(envelope.action.metadata, 'connectorId');
      const connectorName = stringFromRecord(envelope.action.metadata, 'connectorName');
      if (connectorId === 'mpp') return { id: 'mpp', label: 'MPP' };
      if (connectorId === 'ap2') return { id: 'ap2', label: 'AP2' };
      if (connectorId === 'acp') return { id: 'acp', label: 'ACP' };
      if (connectorName) return { id: normalizedBadgeId(connectorName), label: connectorName };
      return { id: 'wallet', label: 'Wallet' };
    }
    case 'recurring': {
      const connectorId = stringFromRecord(envelope.schedule.metadata, 'connectorId')
        ?? stringFromRecord(envelope.schedule.riskMetadata, 'connectorId');
      if (connectorId) return { id: normalizedBadgeId(connectorId), label: connectorId.toUpperCase() };
      return { id: 'recurring', label: 'Recurring' };
    }
    case 'streaming':
      return { id: 'streaming', label: 'Streaming' };
  }
}

export function envelopeId(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return envelope.action.id;
    case 'recurring':
      return envelope.schedule.id;
    case 'streaming':
      return envelope.session.id;
  }
}

export function envelopeUpdatedAt(envelope: SpendEnvelope): string {
  switch (envelope.kind) {
    case 'one-time':
      return envelope.action.updatedAt || envelope.action.createdAt;
    case 'recurring':
      return envelope.schedule.updatedAt || envelope.schedule.createdAt;
    case 'streaming':
      return envelope.session.updatedAt || envelope.session.createdAt;
  }
}

function approvalEnvelopeStatus(status: ApprovalStatus): SpendEnvelopeStatus {
  if (ACTIVE_APPROVAL_STATUSES.has(status)) return 'needs_approval';
  if (status === 'approved') return 'settled';
  if (status === 'expired') return 'expired';
  if (status === 'cancelled' || status === 'denied' || status === 'rejected') return 'cancelled';
  if (FAILED_APPROVAL_STATUSES.has(status)) return 'failed';
  return 'active';
}

function recurringEnvelopeStatus(status: RecurringScheduleStatus): SpendEnvelopeStatus {
  if (status === 'active') return 'active';
  if (status === 'paused') return 'paused';
  if (status === 'completed') return 'settled';
  return 'cancelled';
}

function streamingEnvelopeStatus(status: StreamingSessionStatus): SpendEnvelopeStatus {
  if (status === 'pending') return 'needs_approval';
  if (status === 'active') return 'active';
  if (status === 'settled') return 'settled';
  if (status === 'expired') return 'expired';
  return 'cancelled';
}

function oneTimeRemaining(action: PreparedAction): SpendEnvelopeRemaining {
  const amount = action.amount ?? stringFromRecord(action.params, 'amount') ?? stringFromRecord(action.params, 'amountSol');
  const token = action.token ?? stringFromRecord(action.params, 'token') ?? stringFromRecord(action.params, 'tokenSymbol');
  const label = amount
    ? token ? `${amount} ${token}` : amount
    : 'Approval amount unavailable';
  return {
    label,
    ...(amount ? { amount } : {}),
    ...(token ? { token } : {}),
  };
}

function recurringRemaining(schedule: RecurringScheduleRecord): SpendEnvelopeRemaining {
  const token = schedule.outputToken ?? schedule.token;
  const amount = schedule.amount;
  const remainingOccurrences = schedule.maxOccurrences === undefined
    ? undefined
    : Math.max(0, schedule.maxOccurrences - (schedule.occurrencesCreated ?? 0));
  const label = remainingOccurrences === undefined
    ? `${amount} ${token} per run`
    : `${amount} ${token} per run, ${remainingOccurrences} left`;
  return {
    label,
    amount,
    token,
    ...(remainingOccurrences !== undefined ? { remainingOccurrences } : {}),
  };
}

function streamingRemaining(session: SessionGrant): SpendEnvelopeRemaining {
  const token = stringFromRecord(session.metadata, 'tokenSymbol') ?? 'USDC';
  const remaining = subtractDecimalStrings(session.capAmount, session.spentAmount);
  return {
    label: `${remaining} ${token} remaining`,
    token,
    spent: session.spentAmount,
    cap: session.capAmount,
    remaining,
  };
}

function oneTimeNextEvent(action: PreparedAction): SpendEnvelopeNextEvent {
  if (action.confirmedAt) return { label: 'Confirmed', at: action.confirmedAt };
  if (action.decidedAt) return { label: 'Decided', at: action.decidedAt };
  if (action.dueAt) return { label: 'Approval due', at: action.dueAt };
  return { label: 'Updated', at: action.updatedAt };
}

function recurringNextEvent(schedule: RecurringScheduleRecord): SpendEnvelopeNextEvent {
  if (schedule.status === 'active' && schedule.nextDueAt) return { label: 'Next run', at: schedule.nextDueAt };
  if (schedule.expiresAt) return { label: 'Expires', at: schedule.expiresAt };
  return { label: schedule.status === 'paused' ? 'Paused' : 'Updated', at: schedule.updatedAt };
}

function streamingNextEvent(session: SessionGrant): SpendEnvelopeNextEvent {
  if (session.status === 'pending') return { label: 'Grant pending', at: session.updatedAt };
  if (session.status === 'active') return { label: 'Expires', at: session.expiresAt };
  if (session.status === 'settled') return { label: 'Settled', at: session.updatedAt };
  if (session.status === 'revoked') return { label: 'Revoked', at: session.updatedAt };
  return { label: 'Expired', at: session.expiresAt };
}

function stringFromRecord(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedBadgeId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'protocol';
}

function subtractDecimalStrings(left: string, right: string): string {
  const scale = Math.max(decimalScale(left), decimalScale(right));
  const result = decimalToScaledBigInt(left, scale) - decimalToScaledBigInt(right, scale);
  if (result <= 0n) return '0';
  return scaledBigIntToDecimal(result, scale);
}

function decimalScale(value: string): number {
  const [, fraction = ''] = value.split('.');
  return fraction.length;
}

function decimalToScaledBigInt(value: string, scale: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return 0n;
  const [whole, fraction = ''] = normalized.split('.');
  const padded = `${fraction}${'0'.repeat(scale)}`.slice(0, scale);
  return BigInt(`${whole}${padded}` || '0');
}

function scaledBigIntToDecimal(value: bigint, scale: number): string {
  if (scale <= 0) return value.toString();
  const raw = value.toString().padStart(scale + 1, '0');
  const whole = raw.slice(0, -scale);
  const fraction = raw.slice(-scale).replace(/0+$/g, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
