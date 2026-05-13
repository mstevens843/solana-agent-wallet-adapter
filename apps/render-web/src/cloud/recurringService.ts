import { randomBytes, randomUUID } from 'node:crypto';

import * as workflowCadence from '@solana-agent-wallet-adapter/workflow';
import {
  formatOccurrenceStatus,
  type CreateRecurringRequest,
  type JsonObject,
  type JsonValue,
  type MaterializeResult,
  type RecurringListResponse,
  type RecurringOccurrenceRecord,
  type RecurringScheduleRecord,
  type UpdateRecurringRequest,
  type StatusLabel,
} from '@solana-agent-wallet-adapter/workflow';

import { redactSecrets } from './redaction.js';
import { assertWebhookUrlAllowed, WebhookSecurityError } from './webhookSecurity.js';
import {
  scrubNotificationDeliveryForResponse,
  type RecurringNotificationDeliveryRecord,
} from './notificationService.js';

export function scrubScheduleForResponse(record: RecurringScheduleRecord): RecurringScheduleRecord {
  if (!record.notifications?.webhookSecret) return record;
  const { webhookSecret, ...safeNotifications } = record.notifications;
  return { ...record, notifications: safeNotifications };
}

export function scrubSchedulesForResponse(records: RecurringScheduleRecord[]): RecurringScheduleRecord[] {
  return records.map(scrubScheduleForResponse);
}

const NEXT_RUNS_PREVIEW_COUNT = 5;

export interface ScheduleView {
  schedule: RecurringScheduleRecord;
  lifetimeSpend: workflowCadence.LifetimeSpend;
  nextRuns: string[];
}

export interface ScheduleMutationResult {
  schedule: RecurringScheduleRecord;
  webhookSecretOnce?: string;
  previousStatus?: RecurringScheduleRecord['status'];
}

export interface RecurringNotificationStatusView {
  enabled: boolean;
  webhookUrl?: string;
  lastDelivery?: RecurringNotificationDeliveryRecord;
  deliveries: RecurringNotificationDeliveryRecord[];
}

export function buildScheduleView(
  record: RecurringScheduleRecord,
  now: Date = new Date(),
): ScheduleView {
  const safe = scrubScheduleForResponse(record);
  return {
    schedule: safe,
    lifetimeSpend: workflowCadence.lifetimeSpendEstimate(safe, safe.amount, now),
    nextRuns: workflowCadence.previewUpcoming(safe, now, NEXT_RUNS_PREVIEW_COUNT).map((o) =>
      o.dueAt.toISOString(),
    ),
  };
}

const RECOVERABLE_OCCURRENCE_AGE_MS = 30_000;

export {
  RECURRING_CADENCES,
  RECURRING_OCCURRENCE_STATUSES,
  RECURRING_SCHEDULE_STATUSES,
  RecurringValidationError,
  WorkflowValidationError,
  WORKFLOW_CLUSTERS,
  validateCreateRecurringRequest,
  validateRecurringId,
  validateUpdateRecurringRequest,
} from '@solana-agent-wallet-adapter/workflow';

export type {
  CreateRecurringRequest,
  JsonObject,
  MaterializeResult,
  MaterializeResponse,
  RecurringCadence,
  RecurringListResponse,
  RecurringOccurrenceRecord,
  RecurringOccurrenceStatus,
  RecurringScheduleRecord,
  RecurringScheduleStatus,
  UpdateRecurringRequest,
  WorkflowCluster,
} from '@solana-agent-wallet-adapter/workflow';

export interface RecurringSession {
  walletAddress: string;
}

export class RecurringServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecurringServiceError';
  }
}

export interface RecurringStore {
  listSchedules(walletAddress: string): Promise<RecurringScheduleRecord[]>;
  getSchedule(walletAddress: string, id: string): Promise<RecurringScheduleRecord | undefined>;
  saveSchedule(walletAddress: string, record: RecurringScheduleRecord): Promise<void>;
  deleteSchedule(walletAddress: string, id: string): Promise<boolean>;
  deleteAllRecurringData(walletAddress: string): Promise<RecurringDeleteCounts>;
  listOccurrences(walletAddress: string, scheduleId?: string): Promise<RecurringOccurrenceRecord[]>;
  getOccurrence(walletAddress: string, id: string): Promise<RecurringOccurrenceRecord | undefined>;
  claimOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<RecurringOccurrenceClaim>;
  saveOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<void>;
  findOccurrenceByKey(walletAddress: string, scheduleId: string, occurrenceKey: string): Promise<RecurringOccurrenceRecord | undefined>;
  appendAuditEvent(walletAddress: string, record: RecurringAuditEvent): Promise<void>;
  listNotificationDeliveries?(
    walletAddress: string,
    scheduleId: string,
    limit: number,
  ): Promise<RecurringNotificationDeliveryRecord[]>;
  listKnownWallets?(): Promise<string[]>;
}

export interface RecurringDeleteCounts {
  recurringSchedules: number;
  recurringOccurrences: number;
  recurringNotificationDeliveries: number;
}

export interface RecurringOccurrenceClaim {
  created: boolean;
  occurrence: RecurringOccurrenceRecord;
}

export interface RecurringOccurrenceApprovalSummary {
  id: string;
  status: string;
  decidedAt?: string;
  txid?: string;
  txStatus?: string;
  explorerUrl?: string;
}

export interface RecurringOccurrenceCompletedSummary {
  id: string;
  status: string;
  completedAt: string;
  txid?: string;
  explorerUrl?: string;
}

export interface RecurringOccurrenceHydration {
  occurrenceId: string;
  approval?: RecurringOccurrenceApprovalSummary;
  completed?: RecurringOccurrenceCompletedSummary;
}

export interface RecurringOccurrenceView extends RecurringOccurrenceRecord {
  statusLabel: StatusLabel;
  approval?: RecurringOccurrenceApprovalSummary;
  completed?: RecurringOccurrenceCompletedSummary;
}

export type RecurringOccurrenceHistoryHydrator = (
  walletAddress: string,
  occurrences: RecurringOccurrenceRecord[],
) => Promise<RecurringOccurrenceHydration[]>;

export class MemoryRecurringStore implements RecurringStore {
  private readonly schedules = new Map<string, RecurringScheduleRecord>();
  private readonly occurrences = new Map<string, RecurringOccurrenceRecord>();
  private readonly auditEvents: RecurringAuditEvent[] = [];

  async listSchedules(walletAddress: string): Promise<RecurringScheduleRecord[]> {
    return [...this.schedules.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .map(clone);
  }

  async getSchedule(walletAddress: string, id: string): Promise<RecurringScheduleRecord | undefined> {
    const record = this.schedules.get(id);
    if (!record || record.walletAddress !== walletAddress) return undefined;
    return clone(record);
  }

  async saveSchedule(_walletAddress: string, record: RecurringScheduleRecord): Promise<void> {
    this.schedules.set(record.id, clone(record));
  }

  async deleteSchedule(walletAddress: string, id: string): Promise<boolean> {
    const record = this.schedules.get(id);
    if (!record || record.walletAddress !== walletAddress) return false;
    this.schedules.delete(id);
    for (const [occurrenceId, occurrence] of this.occurrences) {
      if (occurrence.recurringScheduleId === id && occurrence.walletAddress === walletAddress) {
        this.occurrences.delete(occurrenceId);
      }
    }
    return true;
  }

  async deleteAllRecurringData(walletAddress: string): Promise<RecurringDeleteCounts> {
    let recurringSchedules = 0;
    let recurringOccurrences = 0;
    for (const [occurrenceId, occurrence] of this.occurrences) {
      if (occurrence.walletAddress === walletAddress) {
        this.occurrences.delete(occurrenceId);
        recurringOccurrences += 1;
      }
    }
    for (const [scheduleId, schedule] of this.schedules) {
      if (schedule.walletAddress === walletAddress) {
        this.schedules.delete(scheduleId);
        recurringSchedules += 1;
      }
    }
    return {
      recurringSchedules,
      recurringOccurrences,
      recurringNotificationDeliveries: 0,
    };
  }

  async listOccurrences(walletAddress: string, scheduleId?: string): Promise<RecurringOccurrenceRecord[]> {
    return [...this.occurrences.values()]
      .filter((record) => record.walletAddress === walletAddress)
      .filter((record) => (scheduleId ? record.recurringScheduleId === scheduleId : true))
      .map(clone);
  }

  async getOccurrence(walletAddress: string, id: string): Promise<RecurringOccurrenceRecord | undefined> {
    const record = this.occurrences.get(id);
    if (!record || record.walletAddress !== walletAddress) return undefined;
    return clone(record);
  }

  async saveOccurrence(_walletAddress: string, record: RecurringOccurrenceRecord): Promise<void> {
    this.occurrences.set(record.id, clone(record));
  }

  async claimOccurrence(_walletAddress: string, record: RecurringOccurrenceRecord): Promise<RecurringOccurrenceClaim> {
    for (const existing of this.occurrences.values()) {
      if (
        existing.walletAddress === record.walletAddress &&
        existing.recurringScheduleId === record.recurringScheduleId &&
        existing.occurrenceKey === record.occurrenceKey
      ) {
        return { created: false, occurrence: clone(existing) };
      }
    }
    await this.saveOccurrence(record.walletAddress, record);
    return { created: true, occurrence: clone(record) };
  }

  async findOccurrenceByKey(
    walletAddress: string,
    scheduleId: string,
    occurrenceKey: string,
  ): Promise<RecurringOccurrenceRecord | undefined> {
    for (const record of this.occurrences.values()) {
      if (
        record.walletAddress === walletAddress &&
        record.recurringScheduleId === scheduleId &&
        record.occurrenceKey === occurrenceKey
      ) {
        return clone(record);
      }
    }
    return undefined;
  }

  async appendAuditEvent(_walletAddress: string, record: RecurringAuditEvent): Promise<void> {
    this.auditEvents.push(clone(record));
  }

  async listKnownWallets(): Promise<string[]> {
    const wallets = new Set<string>();
    for (const record of this.schedules.values()) wallets.add(record.walletAddress);
    return [...wallets];
  }

  getAuditEvents(): RecurringAuditEvent[] {
    return this.auditEvents.map(clone);
  }
}

export interface RecurringAuditEvent {
  id: string;
  walletAddress: string;
  type: string;
  scheduleId: string;
  occurrenceId?: string;
  occurrenceKey?: string;
  createdAt: string;
  metadata?: JsonObject;
}

export interface ApprovalSinkInput {
  walletAddress: string;
  schedule: RecurringScheduleRecord;
  occurrence: RecurringOccurrenceRecord;
}

export type ApprovalSink = (input: ApprovalSinkInput) => Promise<{ approvalId: string } | undefined>;

export type ApprovalStatusReader = (
  walletAddress: string,
  approvalId: string,
) => Promise<{ status: string } | undefined>;

export type RecurringPolicyEnforcer = (
  schedule: RecurringScheduleRecord,
) => { code: string; message: string } | null;

export type RecurringNotificationSink = (input: {
  walletAddress: string;
  schedule: RecurringScheduleRecord;
  occurrence: RecurringOccurrenceRecord;
}) => Promise<void>;

interface RecurringServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  approvalSink?: ApprovalSink;
  approvalStatusReader?: ApprovalStatusReader;
  policyEnforcer?: RecurringPolicyEnforcer;
  occurrenceHistoryHydrator?: RecurringOccurrenceHistoryHydrator;
  notificationSink?: RecurringNotificationSink;
}

export class RecurringService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly approvalSink: ApprovalSink | undefined;
  private readonly approvalStatusReader: ApprovalStatusReader | undefined;
  private readonly policyEnforcer: RecurringPolicyEnforcer | undefined;
  private readonly occurrenceHistoryHydrator: RecurringOccurrenceHistoryHydrator | undefined;
  private readonly notificationSink: RecurringNotificationSink | undefined;

  constructor(
    private readonly store: RecurringStore,
    options: RecurringServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.approvalSink = options.approvalSink;
    this.approvalStatusReader = options.approvalStatusReader;
    this.policyEnforcer = options.policyEnforcer;
    this.occurrenceHistoryHydrator = options.occurrenceHistoryHydrator;
    this.notificationSink = options.notificationSink;
  }

  private enforcePolicy(schedule: RecurringScheduleRecord): void {
    if (!this.policyEnforcer) return;
    const violation = this.policyEnforcer(schedule);
    if (violation) {
      throw new RecurringServiceError(409, violation.code, violation.message);
    }
  }

  async createSchedule(session: RecurringSession, input: CreateRecurringRequest): Promise<RecurringScheduleRecord> {
    return (await this.createScheduleWithResult(session, input)).schedule;
  }

  async createScheduleWithResult(
    session: RecurringSession,
    input: CreateRecurringRequest,
  ): Promise<ScheduleMutationResult> {
    assertCreateRecurringScheduleStatus(input.status);
    assertCloudRecurringScheduleSupported(input);
    const now = this.now();
    const notificationResult = input.notifications !== undefined
      ? withWebhookSecret(assertSafeNotifications(input.notifications))
      : undefined;
    const record: RecurringScheduleRecord = {
      id: this.id('recurring'),
      status: input.status ?? 'active',
      walletAddress: session.walletAddress,
      cluster: input.cluster,
      ...(input.actionKind !== undefined ? { actionKind: input.actionKind } : {}),
      token: input.token,
      ...(input.inputToken !== undefined ? { inputToken: input.inputToken } : {}),
      ...(input.outputToken !== undefined ? { outputToken: input.outputToken } : {}),
      recipient: input.recipient,
      amount: input.amount,
      cadence: input.cadence,
      createdAt: now,
      updatedAt: now,
      ...(input.dayOfWeek !== undefined ? { dayOfWeek: input.dayOfWeek } : {}),
      ...(input.dayOfMonth !== undefined ? { dayOfMonth: input.dayOfMonth } : {}),
      ...(input.intervalDays !== undefined ? { intervalDays: input.intervalDays } : {}),
      ...(input.intervalHours !== undefined ? { intervalHours: input.intervalHours } : {}),
      ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
      ...(input.localTime !== undefined ? { localTime: input.localTime } : {}),
      ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
      ...(input.maxOccurrences !== undefined ? { maxOccurrences: input.maxOccurrences } : {}),
      occurrencesCreated: 0,
      ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(notificationResult ? { notifications: notificationResult.notifications } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    record.nextDueAt = this.computeNextDueAtIso(record) ?? undefined;
    record.riskMetadata = recurringRiskMetadata(record, this.clock(), input.riskMetadata);

    this.enforcePolicy(record);

    await this.store.saveSchedule(session.walletAddress, record);
    await this.audit(session, 'recurring.schedule.created', record.id, undefined, undefined, recurringScheduleAuditMetadata(
      undefined,
      record,
      scheduleTransitionSource(record.metadata),
    ));
    return {
      schedule: record,
      ...(notificationResult?.webhookSecretOnce ? { webhookSecretOnce: notificationResult.webhookSecretOnce } : {}),
    };
  }

  async listSchedules(session: RecurringSession): Promise<RecurringListResponse> {
    const schedules = sortByCreatedAt(await this.store.listSchedules(session.walletAddress));
    const occurrences = sortByDueAt(await this.store.listOccurrences(session.walletAddress));
    return { schedules, occurrences };
  }

  async getSchedule(session: RecurringSession, id: string): Promise<RecurringScheduleRecord> {
    return this.requireSchedule(session, id);
  }

  async listScheduleOccurrences(
    session: RecurringSession,
    scheduleId: string,
    opts: { status?: RecurringOccurrenceRecord['status']; cursor?: string; limit?: number } = {},
  ): Promise<{ occurrences: RecurringOccurrenceView[]; nextCursor?: string }> {
    await this.requireSchedule(session, scheduleId);
    const all = await this.store.listOccurrences(session.walletAddress, scheduleId);
    const filtered = opts.status ? all.filter((o) => o.status === opts.status) : all;
    const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = opts.limit ?? 50;
    const startIndex = opts.cursor ? sorted.findIndex((o) => o.id === opts.cursor) + 1 : 0;
    const page = sorted.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < sorted.length ? page[page.length - 1]?.id : undefined;
    return {
      occurrences: await this.hydrateOccurrenceViews(session.walletAddress, page),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private async hydrateOccurrenceViews(
    walletAddress: string,
    occurrences: RecurringOccurrenceRecord[],
  ): Promise<RecurringOccurrenceView[]> {
    const hydrationByOccurrence = new Map<string, RecurringOccurrenceHydration>();
    if (this.occurrenceHistoryHydrator && occurrences.length > 0) {
      for (const hydration of await this.occurrenceHistoryHydrator(walletAddress, occurrences)) {
        hydrationByOccurrence.set(hydration.occurrenceId, hydration);
      }
    }
    return occurrences.map((occurrence) => {
      const hydration = hydrationByOccurrence.get(occurrence.id);
      return {
        ...occurrence,
        statusLabel: formatOccurrenceStatus(occurrence.status, hydration?.approval),
        ...(hydration?.approval ? { approval: hydration.approval } : {}),
        ...(hydration?.completed ? { completed: hydration.completed } : {}),
      };
    });
  }

  async updateSchedule(
    session: RecurringSession,
    id: string,
    input: UpdateRecurringRequest,
  ): Promise<RecurringScheduleRecord> {
    return (await this.updateScheduleWithResult(session, id, input)).schedule;
  }

  async updateScheduleWithResult(
    session: RecurringSession,
    id: string,
    input: UpdateRecurringRequest,
  ): Promise<ScheduleMutationResult> {
    const existing = await this.requireSchedule(session, id);
    if (existing.status === 'cancelled' || existing.status === 'completed') {
      throw new RecurringServiceError(409, 'recurring_terminal', 'Schedule is no longer active.');
    }

    const updated: RecurringScheduleRecord = {
      ...existing,
      ...input,
      walletAddress: existing.walletAddress,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: this.now(),
    };
    let notificationResult: ReturnType<typeof withWebhookSecret> | undefined;
    if (input.notifications !== undefined) {
      const safeNotifications = assertSafeNotifications(input.notifications);
      const existingSecret = input.notifications.webhookUrl === existing.notifications?.webhookUrl
        ? existing.notifications?.webhookSecret
        : undefined;
      notificationResult = withWebhookSecret(safeNotifications, existingSecret);
      updated.notifications = notificationResult.notifications;
    }
    assertCloudRecurringScheduleSupported(updated);
    assertCadenceFieldsForUpdate(updated);
    updated.nextDueAt = this.computeNextDueAtIso(updated) ?? undefined;
    updated.riskMetadata = recurringRiskMetadata(updated, this.clock(), input.riskMetadata ?? existing.riskMetadata);

    this.enforcePolicy(updated);

    await this.store.saveSchedule(session.walletAddress, updated);
    await this.audit(session, `recurring.schedule.updated`, updated.id, undefined, undefined, {
      ...recurringScheduleAuditMetadata(
        existing.status,
        updated,
        scheduleUpdateTransitionSource(existing.metadata, input.metadata),
      ),
    });
    return {
      schedule: updated,
      previousStatus: existing.status,
      ...(notificationResult?.webhookSecretOnce ? { webhookSecretOnce: notificationResult.webhookSecretOnce } : {}),
    };
  }

  async pauseSchedule(session: RecurringSession, id: string): Promise<RecurringScheduleRecord> {
    const result = await this.updateScheduleWithResult(session, id, { status: 'paused' });
    await this.audit(session, 'recurring.schedule.paused', id, undefined, undefined, recurringScheduleAuditMetadata(
      result.previousStatus,
      result.schedule,
      'user',
    ));
    return result.schedule;
  }

  async resumeSchedule(session: RecurringSession, id: string): Promise<RecurringScheduleRecord> {
    const result = await this.updateScheduleWithResult(session, id, { status: 'active' });
    await this.audit(session, 'recurring.schedule.resumed', id, undefined, undefined, recurringScheduleAuditMetadata(
      result.previousStatus,
      result.schedule,
      'user',
    ));
    return result.schedule;
  }

  async rotateNotificationSecret(
    session: RecurringSession,
    id: string,
  ): Promise<ScheduleMutationResult> {
    const existing = await this.requireSchedule(session, id);
    if (!existing.notifications?.webhookUrl) {
      throw new RecurringServiceError(
        409,
        'notifications_disabled',
        'Webhook notifications are not enabled for this schedule.',
      );
    }
    const webhookSecretOnce = randomBytes(32).toString('hex');
    const updated: RecurringScheduleRecord = {
      ...existing,
      notifications: {
        ...existing.notifications,
        webhookSecret: webhookSecretOnce,
      },
      updatedAt: this.now(),
    };
    updated.riskMetadata = recurringRiskMetadata(updated, this.clock(), existing.riskMetadata);
    await this.store.saveSchedule(session.walletAddress, updated);
    await this.audit(session, 'recurring.notification.secret_rotated', id);
    return { schedule: updated, webhookSecretOnce };
  }

  async notificationStatus(
    session: RecurringSession,
    id: string,
    limit = 10,
  ): Promise<RecurringNotificationStatusView> {
    const schedule = await this.requireSchedule(session, id);
    const deliveries = this.store.listNotificationDeliveries
      ? await this.store.listNotificationDeliveries(session.walletAddress, id, limit)
      : [];
    const sorted = [...deliveries]
      .map(scrubNotificationDeliveryForResponse)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      enabled: Boolean(schedule.notifications?.webhookUrl),
      ...(schedule.notifications?.webhookUrl ? { webhookUrl: schedule.notifications.webhookUrl } : {}),
      ...(sorted[0] ? { lastDelivery: sorted[0] } : {}),
      deliveries: sorted,
    };
  }

  async deleteSchedule(session: RecurringSession, id: string): Promise<void> {
    await this.requireSchedule(session, id);
    const deleted = await this.store.deleteSchedule(session.walletAddress, id);
    if (!deleted) throw notFound('Recurring schedule was not found.');
    await this.audit(session, 'recurring.schedule.deleted', id);
  }

  async materializeDueOccurrences(session: RecurringSession): Promise<MaterializeResult[]> {
    await this.syncOccurrenceStatuses(session);
    const schedules = await this.store.listSchedules(session.walletAddress);
    const results: MaterializeResult[] = [];
    for (const schedule of schedules) {
      results.push(await this.materializeSchedule(session, schedule));
    }
    return results;
  }

  async syncOccurrenceStatuses(session: RecurringSession): Promise<number> {
    if (!this.approvalStatusReader) return 0;
    const occurrences = await this.store.listOccurrences(session.walletAddress);
    let synced = 0;
    for (const occurrence of occurrences) {
      if (!occurrence.approvalRequestId) continue;
      if (occurrence.status === 'completed' || occurrence.status === 'cancelled' || occurrence.status === 'failed' || occurrence.status === 'skipped') {
        continue;
      }
      let approval: { status: string } | undefined;
      try {
        approval = await this.approvalStatusReader(session.walletAddress, occurrence.approvalRequestId);
      } catch {
        continue;
      }
      if (!approval) continue;
      const next = mapApprovalStatusToOccurrence(approval.status);
      if (!next || next === occurrence.status) continue;
      const updated: RecurringOccurrenceRecord = {
        ...occurrence,
        status: next,
        updatedAt: this.now(),
      };
      await this.store.saveOccurrence(session.walletAddress, updated);
      await this.audit(
        session,
        'recurring.occurrence.synced',
        occurrence.recurringScheduleId,
        occurrence.id,
        occurrence.occurrenceKey,
        { occurrenceStatus: next, approvalStatus: approval.status },
      );
      synced += 1;
    }
    return synced;
  }

  private async materializeSchedule(
    session: RecurringSession,
    schedule: RecurringScheduleRecord,
  ): Promise<MaterializeResult> {
    if (schedule.status === 'paused') {
      return { scheduleId: schedule.id, reason: 'paused' };
    }
    if (schedule.status === 'cancelled') {
      return { scheduleId: schedule.id, reason: 'cancelled' };
    }
    if (schedule.status === 'completed') {
      return { scheduleId: schedule.id, reason: 'completed' };
    }
    if (
      schedule.maxOccurrences !== undefined &&
      (schedule.occurrencesCreated ?? 0) >= schedule.maxOccurrences
    ) {
      const ended: RecurringScheduleRecord = {
        ...schedule,
        status: 'completed',
        updatedAt: this.now(),
        nextDueAt: undefined,
      };
      await this.store.saveSchedule(session.walletAddress, ended);
      await this.audit(session, 'recurring.schedule.completed', schedule.id);
      return { scheduleId: schedule.id, reason: 'completed' };
    }

    if (schedule.expiresAt) {
      const expiry = new Date(schedule.expiresAt);
      if (!Number.isNaN(expiry.getTime()) && this.clock().getTime() >= expiry.getTime()) {
        const ended: RecurringScheduleRecord = {
          ...schedule,
          status: 'completed',
          updatedAt: this.now(),
          nextDueAt: undefined,
        };
        await this.store.saveSchedule(session.walletAddress, ended);
        await this.audit(session, 'recurring.schedule.expired', schedule.id);
        return { scheduleId: schedule.id, reason: 'completed' };
      }
    }

    const dueOccurrence = workflowCadence.latestDueOccurrence(schedule, this.clock());
    if (!dueOccurrence) {
      if (schedule.expiresAt && !workflowCadence.nextFutureOccurrence(schedule, this.clock())) {
        const ended: RecurringScheduleRecord = {
          ...schedule,
          status: 'completed',
          updatedAt: this.now(),
          nextDueAt: undefined,
        };
        await this.store.saveSchedule(session.walletAddress, ended);
        await this.audit(session, 'recurring.schedule.completed', schedule.id, undefined, undefined, {
          reason: 'no_future_runs_before_expiry',
        });
        return { scheduleId: schedule.id, reason: 'completed' };
      }
      return { scheduleId: schedule.id, reason: 'invalid' };
    }
    if (dueOccurrence.dueAt.getTime() > this.clock().getTime()) {
      const next: RecurringScheduleRecord = {
        ...schedule,
        nextDueAt: dueOccurrence.dueAt.toISOString(),
        updatedAt: this.now(),
      };
      if (next.nextDueAt !== schedule.nextDueAt) {
        await this.store.saveSchedule(session.walletAddress, next);
      }
      return { scheduleId: schedule.id, reason: 'not_due' };
    }

    const occurrenceKey = dueOccurrence.key;
    const existing = await this.store.findOccurrenceByKey(
      session.walletAddress,
      schedule.id,
      occurrenceKey,
    );
    if (existing) {
      await this.repairExistingOccurrence(session, schedule, existing, dueOccurrence.dueAt);
      await this.ensureNotificationDelivery(session, schedule, existing);
      return {
        scheduleId: schedule.id,
        occurrenceKey,
        occurrenceId: existing.id,
        reason: 'duplicate',
      };
    }

    const unresolved = await this.findUnresolvedOccurrence(session, schedule.id);
    if (unresolved) {
      if (this.isRecoverableInterruptedOccurrence(unresolved)) {
        await this.repairExistingOccurrence(session, schedule, unresolved, new Date(unresolved.dueAt));
      }
      return {
        scheduleId: schedule.id,
        occurrenceKey: unresolved.occurrenceKey,
        occurrenceId: unresolved.id,
        reason: 'pending_approval',
      };
    }

    const now = this.now();
    let occurrence: RecurringOccurrenceRecord = {
      id: this.id('occurrence'),
      recurringScheduleId: schedule.id,
      walletAddress: session.walletAddress,
      cluster: schedule.cluster,
      status: 'ready',
      occurrenceKey,
      dueAt: dueOccurrence.dueAt.toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    const claim = await this.store.claimOccurrence(session.walletAddress, occurrence);
    if (!claim.created) {
      await this.repairExistingOccurrence(session, schedule, claim.occurrence, dueOccurrence.dueAt);
      await this.ensureNotificationDelivery(session, schedule, claim.occurrence);
      return {
        scheduleId: schedule.id,
        occurrenceKey,
        occurrenceId: claim.occurrence.id,
        reason: 'duplicate',
      };
    }
    occurrence = claim.occurrence;

    occurrence = await this.attachApprovalRequest(session, schedule, occurrence);

    const occurrencesCreated = (schedule.occurrencesCreated ?? 0) + 1;
    const nextSchedule: RecurringScheduleRecord = {
      ...schedule,
      occurrencesCreated,
      lastMaterializedAt: now,
      updatedAt: now,
    };
    nextSchedule.nextDueAt =
      this.computeNextDueAtIso({ ...nextSchedule }, dueOccurrence.dueAt) ?? undefined;
    if (
      nextSchedule.maxOccurrences !== undefined &&
      occurrencesCreated >= nextSchedule.maxOccurrences
    ) {
      nextSchedule.status = 'completed';
      nextSchedule.nextDueAt = undefined;
    }
    await this.store.saveSchedule(session.walletAddress, nextSchedule);
    await this.audit(session, 'recurring.materialized', schedule.id, occurrence.id, occurrenceKey);
    await this.ensureNotificationDelivery(session, nextSchedule, occurrence);

    return {
      scheduleId: schedule.id,
      occurrenceKey,
      occurrenceId: occurrence.id,
      reason: 'created',
    };
  }

  private async repairExistingOccurrence(
    session: RecurringSession,
    schedule: RecurringScheduleRecord,
    occurrence: RecurringOccurrenceRecord,
    dueAt: Date,
  ): Promise<void> {
    if (!this.isRecoverableInterruptedOccurrence(occurrence)) return;
    const repaired = await this.attachApprovalRequest(session, schedule, occurrence);
    await this.repairScheduleMaterializationState(session, schedule, repaired, dueAt);
  }

  private async findUnresolvedOccurrence(
    session: RecurringSession,
    scheduleId: string,
  ): Promise<RecurringOccurrenceRecord | undefined> {
    const occurrences = await this.store.listOccurrences(session.walletAddress, scheduleId);
    return occurrences
      .filter((occurrence) => isUnresolvedOccurrence(occurrence))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.createdAt.localeCompare(right.createdAt))[0];
  }

  private async attachApprovalRequest(
    session: RecurringSession,
    schedule: RecurringScheduleRecord,
    occurrence: RecurringOccurrenceRecord,
  ): Promise<RecurringOccurrenceRecord> {
    if (!this.approvalSink || occurrence.approvalRequestId || occurrence.status !== 'ready') {
      return occurrence;
    }

    const updated: RecurringOccurrenceRecord = { ...occurrence };
    try {
      const result = await this.approvalSink({
        walletAddress: session.walletAddress,
        schedule,
        occurrence: updated,
      });
      if (result?.approvalId) {
        updated.approvalRequestId = result.approvalId;
        updated.status = 'approval_pending';
        delete updated.error;
      }
    } catch (err) {
      updated.error = err instanceof Error ? redactSecrets(err.message) : 'Failed to register approval request.';
      updated.status = 'failed';
    }
    updated.updatedAt = this.now();
    await this.store.saveOccurrence(session.walletAddress, updated);
    return updated;
  }

  private async repairScheduleMaterializationState(
    session: RecurringSession,
    schedule: RecurringScheduleRecord,
    occurrence: RecurringOccurrenceRecord,
    dueAt: Date,
  ): Promise<void> {
    const occurrences = await this.store.listOccurrences(session.walletAddress, schedule.id);
    const occurrencesCreated = Math.max(schedule.occurrencesCreated ?? 0, occurrences.length);
    if (occurrencesCreated <= (schedule.occurrencesCreated ?? 0)) return;

    const now = this.now();
    const nextSchedule: RecurringScheduleRecord = {
      ...schedule,
      occurrencesCreated,
      lastMaterializedAt: now,
      updatedAt: now,
    };
    nextSchedule.nextDueAt =
      this.computeNextDueAtIso({ ...nextSchedule }, dueAt) ?? undefined;
    if (
      nextSchedule.maxOccurrences !== undefined &&
      occurrencesCreated >= nextSchedule.maxOccurrences
    ) {
      nextSchedule.status = 'completed';
      nextSchedule.nextDueAt = undefined;
    }
    await this.store.saveSchedule(session.walletAddress, nextSchedule);
    await this.audit(session, 'recurring.materialized', schedule.id, occurrence.id, occurrence.occurrenceKey, {
      recovered: true,
    });
    await this.ensureNotificationDelivery(session, nextSchedule, occurrence);
  }

  private async ensureNotificationDelivery(
    session: RecurringSession,
    schedule: RecurringScheduleRecord,
    occurrence: RecurringOccurrenceRecord,
  ): Promise<void> {
    if (!this.notificationSink || (occurrence.status !== 'ready' && occurrence.status !== 'approval_pending')) {
      return;
    }
    try {
      await this.notificationSink({
        walletAddress: session.walletAddress,
        schedule,
        occurrence,
      });
    } catch (err) {
      await this.audit(session, 'recurring.notification.enqueue_failed', schedule.id, occurrence.id, occurrence.occurrenceKey, {
        error: err instanceof Error ? redactSecrets(err.message) : 'Failed to enqueue recurring notification.',
      });
    }
  }

  private isRecoverableInterruptedOccurrence(occurrence: RecurringOccurrenceRecord): boolean {
    if (occurrence.status !== 'ready' || occurrence.approvalRequestId) return false;
    const updatedAt = Date.parse(occurrence.updatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    return this.clock().getTime() - updatedAt >= RECOVERABLE_OCCURRENCE_AGE_MS;
  }

  private computeNextDueAtIso(
    schedule: RecurringScheduleRecord,
    after?: Date,
  ): string | null {
    const referenceNow = after ?? this.clock();
    const next = workflowCadence.nextFutureOccurrence(schedule, referenceNow);
    return next ? next.dueAt.toISOString() : null;
  }

  private async requireSchedule(session: RecurringSession, id: string): Promise<RecurringScheduleRecord> {
    const record = await this.store.getSchedule(session.walletAddress, id);
    if (!record) throw notFound('Recurring schedule was not found.');
    return record;
  }

  private async audit(
    session: RecurringSession,
    type: string,
    scheduleId: string,
    occurrenceId?: string,
    occurrenceKey?: string,
    metadata?: JsonObject,
  ): Promise<void> {
    await this.store.appendAuditEvent(session.walletAddress, {
      id: this.id('audit'),
      walletAddress: session.walletAddress,
      type,
      scheduleId,
      ...(occurrenceId ? { occurrenceId } : {}),
      ...(occurrenceKey ? { occurrenceKey } : {}),
      createdAt: this.now(),
      ...(metadata ? { metadata } : {}),
    });
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}_${this.idFactory()}`;
  }
}

function sortByCreatedAt<T extends { createdAt: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function sortByDueAt<T extends { dueAt: string }>(records: T[]): T[] {
  return [...records].sort((left, right) => left.dueAt.localeCompare(right.dueAt));
}

function notFound(message: string): RecurringServiceError {
  return new RecurringServiceError(404, 'not_found', message);
}

function recurringScheduleAuditMetadata(
  previousStatus: RecurringScheduleRecord['status'] | undefined,
  schedule: RecurringScheduleRecord,
  transitionSource: 'agent' | 'user',
): JsonObject {
  return {
    previousStatus: previousStatus ?? '',
    nextStatus: schedule.status,
    statusTransition: {
      from: previousStatus ?? '',
      to: schedule.status,
    },
    transitionSource,
    ...safeConnectorMetadata(schedule.metadata),
    ...safeAgentReviewMetadata(schedule.metadata),
  };
}

function scheduleTransitionSource(metadata: JsonObject | undefined): 'agent' | 'user' {
  return hasAgentReviewMetadata(metadata) ? 'agent' : 'user';
}

function scheduleUpdateTransitionSource(
  previousMetadata: JsonObject | undefined,
  patchMetadata: JsonObject | undefined,
): 'agent' | 'user' {
  if (!hasAgentReviewMetadata(patchMetadata)) return 'user';
  return agentReviewFingerprint(previousMetadata) === agentReviewFingerprint(patchMetadata)
    ? 'user'
    : 'agent';
}

function hasAgentReviewMetadata(metadata: JsonObject | undefined): boolean {
  return Boolean(
    metadata &&
    (
      typeof metadata.agentReviewStatus === 'string' ||
      typeof metadata.agentReviewDecision === 'string' ||
      isJsonRecord(metadata.agentReview)
    ),
  );
}

function agentReviewFingerprint(metadata: JsonObject | undefined): string {
  if (!metadata) return '';
  const review = isJsonRecord(metadata.agentReview) ? metadata.agentReview : undefined;
  const snapshot: JsonObject = {};
  for (const key of [
    'agentReviewStatus',
    'agentReviewDecision',
    'agentReviewCheckedAt',
    'agentReviewProvider',
    'agentReviewModel',
    'agentReviewSummary',
    'agentReviewReason',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string') snapshot[key] = value;
  }
  if (review) snapshot.agentReview = stableJsonValue(review) as JsonObject;
  const factLabels = metadata.factLabels;
  if (Array.isArray(factLabels) && factLabels.every((entry) => typeof entry === 'string')) {
    snapshot.factLabels = [...factLabels];
  }
  return JSON.stringify(stableJsonValue(snapshot));
}

function safeAgentReviewMetadata(metadata: JsonObject | undefined): JsonObject {
  if (!metadata) return {};
  const review = isJsonRecord(metadata.agentReview) ? metadata.agentReview : undefined;
  const summary = firstMetadataString(metadata, review, ['agentReviewSummary', 'reviewSummary', 'summary']);
  const reason = firstMetadataString(metadata, review, ['agentReviewReason', 'reason', 'decisionReason', 'denialReason']);
  const safe: JsonObject = {};
  copyString(metadata, safe, 'agentReviewStatus');
  copyString(metadata, safe, 'agentReviewDecision');
  copyString(metadata, safe, 'agentReviewCheckedAt');
  copyString(metadata, safe, 'agentReviewProvider');
  copyString(metadata, safe, 'agentReviewModel');
  if (summary) safe.agentReviewSummary = summary;
  if (reason) safe.agentReviewReason = reason;
  const factLabels = metadata.factLabels;
  if (Array.isArray(factLabels) && factLabels.every((entry) => typeof entry === 'string')) {
    safe.factLabels = factLabels.slice(0, 12);
  }
  return safe;
}

function safeConnectorMetadata(metadata: JsonObject | undefined): JsonObject {
  if (!metadata) return {};
  const safe: JsonObject = {};
  for (const key of ['connectorId', 'connectorName', 'capability', 'operation', 'actionSource', 'approvalBoundary']) {
    copyString(metadata, safe, key);
  }
  return safe;
}

function firstMetadataString(
  metadata: JsonObject,
  review: JsonObject | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return boundedMetadataString(value);
  }
  if (!review) return undefined;
  for (const key of keys) {
    const value = review[key];
    if (typeof value === 'string' && value.trim()) return boundedMetadataString(value);
  }
  return undefined;
}

function copyString(source: JsonObject, target: JsonObject, key: string): void {
  const value = source[key];
  if (typeof value === 'string' && value.trim()) {
    target[key] = boundedMetadataString(value);
  }
}

function boundedMetadataString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function isJsonRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (isJsonRecord(value)) {
    const output: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = stableJsonValue(value[key]!);
    }
    return output;
  }
  return value;
}

function assertCreateRecurringScheduleStatus(status: CreateRecurringRequest['status']): void {
  if (status === undefined || status === 'active' || status === 'paused') return;
  throw new RecurringServiceError(
    400,
    'invalid_status',
    'Recurring schedules can only be created as active or paused.',
  );
}

function assertCloudRecurringScheduleSupported(input: Pick<RecurringScheduleRecord | CreateRecurringRequest | UpdateRecurringRequest, 'actionKind' | 'token' | 'outputToken'>): void {
  if (input.actionKind === 'swap' || input.outputToken) return;
  if (input.token?.toUpperCase() === 'SOL') return;
  throw new RecurringServiceError(
    409,
    'unsupported_cloud_recurring_token',
    'Agentic Cloud recurring execution currently supports SOL schedules only.',
  );
}

function mapApprovalStatusToOccurrence(
  approvalStatus: string,
): RecurringOccurrenceRecord['status'] | undefined {
  switch (approvalStatus) {
    case 'approved':
      return 'completed';
    case 'denied':
    case 'rejected':
    case 'cancelled':
      return 'cancelled';
    case 'expired':
    case 'blocked':
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

function isUnresolvedOccurrence(occurrence: RecurringOccurrenceRecord): boolean {
  return occurrence.status === 'scheduled' ||
    occurrence.status === 'ready' ||
    occurrence.status === 'approval_pending';
}

function assertCadenceFieldsForUpdate(schedule: RecurringScheduleRecord): void {
  switch (schedule.cadence) {
    case 'weekly':
      if (
        !Number.isInteger(schedule.dayOfWeek) ||
        schedule.dayOfWeek === undefined ||
        schedule.dayOfWeek < 0 ||
        schedule.dayOfWeek > 6 ||
        !schedule.localTime
      ) {
        throw new RecurringServiceError(
          400,
          'invalid_cadence_fields',
          'weekly cadence requires dayOfWeek (0-6) and localTime.',
        );
      }
      break;
    case 'monthly':
      if (
        !Number.isInteger(schedule.dayOfMonth) ||
        schedule.dayOfMonth === undefined ||
        schedule.dayOfMonth < 1 ||
        schedule.dayOfMonth > 31 ||
        !schedule.localTime
      ) {
        throw new RecurringServiceError(
          400,
          'invalid_cadence_fields',
          'monthly cadence requires dayOfMonth (1-31) and localTime.',
        );
      }
      break;
    case 'interval_days':
      if (!Number.isInteger(schedule.intervalDays) || (schedule.intervalDays ?? 0) < 1) {
        throw new RecurringServiceError(400, 'invalid_cadence_fields', 'interval_days requires intervalDays >= 1.');
      }
      break;
    case 'interval_hours':
      if (!Number.isInteger(schedule.intervalHours) || (schedule.intervalHours ?? 0) < 1) {
        throw new RecurringServiceError(400, 'invalid_cadence_fields', 'interval_hours requires intervalHours >= 1.');
      }
      break;
    case 'interval_minutes':
      if (!Number.isInteger(schedule.intervalMinutes) || (schedule.intervalMinutes ?? 0) < 1) {
        throw new RecurringServiceError(400, 'invalid_cadence_fields', 'interval_minutes requires intervalMinutes >= 1.');
      }
      break;
    default:
      assertNeverCadence(schedule.cadence);
  }
}

function assertNeverCadence(cadence: never): never {
  throw new RecurringServiceError(
    500,
    'unhandled_cadence',
    `Unhandled recurring cadence: ${String(cadence)}`,
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withWebhookSecret(
  notifications: NonNullable<RecurringScheduleRecord['notifications']>,
  existingSecret?: string,
): {
  notifications: NonNullable<RecurringScheduleRecord['notifications']>;
  webhookSecretOnce?: string;
} {
  if (!notifications.webhookUrl) return { notifications: { ...notifications } };
  const webhookSecret = existingSecret ?? randomBytes(32).toString('hex');
  return {
    notifications: {
      ...notifications,
      webhookSecret,
    },
    ...(existingSecret ? {} : { webhookSecretOnce: webhookSecret }),
  };
}

function assertSafeNotifications(
  notifications: NonNullable<RecurringScheduleRecord['notifications']>,
): NonNullable<RecurringScheduleRecord['notifications']> {
  if (!notifications.webhookUrl) return notifications;
  try {
    assertWebhookUrlAllowed(notifications.webhookUrl);
  } catch (err) {
    if (err instanceof WebhookSecurityError) {
      throw new RecurringServiceError(400, 'invalid_notifications', err.message);
    }
    throw err;
  }
  return notifications;
}

function recurringRiskMetadata(
  schedule: RecurringScheduleRecord,
  now: Date,
  current?: JsonObject,
): JsonObject {
  const lifetimeSpend = workflowCadence.lifetimeSpendEstimate(schedule, schedule.amount, now);
  const nextRuns = workflowCadence.previewUpcoming(schedule, now, 5).map((entry) => entry.dueAt.toISOString());
  return {
    ...(current ?? {}),
    recurring: {
      lifetimeSpend: jsonObject(lifetimeSpend),
      nextRuns,
      nextRunCount: nextRuns.length,
      hasExpiry: Boolean(schedule.expiresAt),
      hasMaxOccurrences: schedule.maxOccurrences !== undefined,
      notificationsEnabled: Boolean(schedule.notifications?.webhookUrl),
      perRunWalletApproval: true,
    },
  };
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
