import { randomUUID } from 'node:crypto';

import {
  type CreateRecurringRequest,
  type JsonObject,
  type MaterializeResult,
  type RecurringCadence,
  type RecurringListResponse,
  type RecurringOccurrenceRecord,
  type RecurringScheduleRecord,
  type UpdateRecurringRequest,
} from '@solana-agent-wallet-adapter/workflow';

import { redactSecrets } from './redaction.js';

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
  listOccurrences(walletAddress: string, scheduleId?: string): Promise<RecurringOccurrenceRecord[]>;
  getOccurrence(walletAddress: string, id: string): Promise<RecurringOccurrenceRecord | undefined>;
  claimOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<RecurringOccurrenceClaim>;
  saveOccurrence(walletAddress: string, record: RecurringOccurrenceRecord): Promise<void>;
  findOccurrenceByKey(walletAddress: string, scheduleId: string, occurrenceKey: string): Promise<RecurringOccurrenceRecord | undefined>;
  appendAuditEvent(walletAddress: string, record: RecurringAuditEvent): Promise<void>;
  listKnownWallets?(): Promise<string[]>;
}

export interface RecurringOccurrenceClaim {
  created: boolean;
  occurrence: RecurringOccurrenceRecord;
}

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

interface RecurringServiceOptions {
  clock?: () => Date;
  idFactory?: () => string;
  approvalSink?: ApprovalSink;
  approvalStatusReader?: ApprovalStatusReader;
}

export class RecurringService {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly approvalSink: ApprovalSink | undefined;
  private readonly approvalStatusReader: ApprovalStatusReader | undefined;

  constructor(
    private readonly store: RecurringStore,
    options: RecurringServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.approvalSink = options.approvalSink;
    this.approvalStatusReader = options.approvalStatusReader;
  }

  async createSchedule(session: RecurringSession, input: CreateRecurringRequest): Promise<RecurringScheduleRecord> {
    const now = this.now();
    const record: RecurringScheduleRecord = {
      id: this.id('recurring'),
      status: 'active',
      walletAddress: session.walletAddress,
      cluster: input.cluster,
      token: input.token,
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
      ...(input.riskMetadata !== undefined ? { riskMetadata: input.riskMetadata } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    record.nextDueAt = this.computeNextDueAtIso(record) ?? undefined;

    await this.store.saveSchedule(session.walletAddress, record);
    await this.audit(session, 'recurring.schedule.created', record.id);
    return record;
  }

  async listSchedules(session: RecurringSession): Promise<RecurringListResponse> {
    const schedules = sortByCreatedAt(await this.store.listSchedules(session.walletAddress));
    const occurrences = sortByDueAt(await this.store.listOccurrences(session.walletAddress));
    return { schedules, occurrences };
  }

  async getSchedule(session: RecurringSession, id: string): Promise<RecurringScheduleRecord> {
    return this.requireSchedule(session, id);
  }

  async updateSchedule(
    session: RecurringSession,
    id: string,
    input: UpdateRecurringRequest,
  ): Promise<RecurringScheduleRecord> {
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
    assertCadenceFieldsForUpdate(updated);
    updated.nextDueAt = this.computeNextDueAtIso(updated) ?? undefined;

    await this.store.saveSchedule(session.walletAddress, updated);
    await this.audit(session, `recurring.schedule.updated`, updated.id, undefined, undefined, {
      status: updated.status,
    });
    return updated;
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

    const dueOccurrence = computeDueOccurrence(schedule, this.clock());
    if (!dueOccurrence) {
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
      return {
        scheduleId: schedule.id,
        occurrenceKey,
        occurrenceId: existing.id,
        reason: 'duplicate',
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
    const next = nextFutureOccurrence(schedule, referenceNow);
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

function computeDueOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
): { dueAt: Date; key: string } | null {
  return computeNextOccurrence(schedule, now);
}

function nextFutureOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
): { dueAt: Date; key: string } | null {
  const startAt = recurringStartAt(schedule);
  if (!startAt) return null;
  switch (schedule.cadence) {
    case 'weekly':
      return nextFutureWeekly(schedule, now, startAt);
    case 'monthly':
      return nextFutureMonthly(schedule, now, startAt);
    case 'interval_days':
      return nextFutureInterval(schedule, now, schedule.intervalDays, 24 * 60 * 60 * 1000);
    case 'interval_hours':
      return nextFutureInterval(schedule, now, schedule.intervalHours, 60 * 60 * 1000);
    case 'interval_minutes':
      return nextFutureInterval(schedule, now, schedule.intervalMinutes, 60 * 1000);
    default:
      return assertNeverCadence(schedule.cadence);
  }
}

function nextFutureWeekly(
  schedule: RecurringScheduleRecord,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek === undefined) return null;
  const candidate = new Date(now.getTime());
  candidate.setHours(time.hour, time.minute, 0, 0);
  const daysForward = (schedule.dayOfWeek - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + daysForward);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  while (candidate.getTime() < startAt.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return { dueAt: candidate, key: candidate.toISOString().slice(0, 10) };
}

function nextFutureMonthly(
  schedule: RecurringScheduleRecord,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  let candidate = clampedMonthlyDate(now.getFullYear(), now.getMonth(), schedule.dayOfMonth, time.hour, time.minute);
  if (candidate.getTime() <= now.getTime()) {
    candidate = clampedMonthlyDate(candidate.getFullYear(), candidate.getMonth() + 1, schedule.dayOfMonth, time.hour, time.minute);
  }
  while (candidate.getTime() < startAt.getTime()) {
    candidate = clampedMonthlyDate(candidate.getFullYear(), candidate.getMonth() + 1, schedule.dayOfMonth, time.hour, time.minute);
  }
  return { dueAt: candidate, key: monthlyKey(candidate) };
}

function nextFutureInterval(
  schedule: RecurringScheduleRecord,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): { dueAt: Date; key: string } | null {
  if (!Number.isInteger(interval) || interval === undefined || interval < 1) return null;
  const anchor = recurringStartAt(schedule);
  if (!anchor) return null;
  const time = schedule.cadence === 'interval_days' ? parseLocalTime(schedule.localTime) : null;
  const dueAt = new Date(anchor.getTime());
  if (time) dueAt.setHours(time.hour, time.minute, 0, 0);
  const totalIntervalMs = interval * intervalMs;
  if (dueAt.getTime() > now.getTime()) {
    return { dueAt, key: intervalKey(dueAt, schedule.cadence) };
  }
  const elapsedMs = now.getTime() - dueAt.getTime();
  const intervalsToAdvance = Math.floor(elapsedMs / totalIntervalMs) + 1;
  dueAt.setTime(dueAt.getTime() + intervalsToAdvance * totalIntervalMs);
  return { dueAt, key: intervalKey(dueAt, schedule.cadence) };
}

function computeNextOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
): { dueAt: Date; key: string } | null {
  const startAt = recurringStartAt(schedule);
  if (!startAt) return null;
  switch (schedule.cadence) {
    case 'weekly':
      return nextWeeklyOccurrence(schedule, now, startAt);
    case 'monthly':
      return nextMonthlyOccurrence(schedule, now, startAt);
    case 'interval_days':
      return nextIntervalOccurrence(schedule, now, schedule.intervalDays, 24 * 60 * 60 * 1000);
    case 'interval_hours':
      return nextIntervalOccurrence(schedule, now, schedule.intervalHours, 60 * 60 * 1000);
    case 'interval_minutes':
      return nextIntervalOccurrence(schedule, now, schedule.intervalMinutes, 60 * 1000);
    default:
      return assertNeverCadence(schedule.cadence);
  }
}

function nextWeeklyOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek === undefined) return null;
  const candidate = new Date(now.getTime());
  candidate.setHours(time.hour, time.minute, 0, 0);
  const daysBack = (candidate.getDay() - schedule.dayOfWeek + 7) % 7;
  candidate.setDate(candidate.getDate() - daysBack);
  if (candidate.getTime() < startAt.getTime()) {
    while (candidate.getTime() < startAt.getTime()) {
      candidate.setDate(candidate.getDate() + 7);
    }
  } else if (candidate.getTime() > now.getTime()) {
    candidate.setDate(candidate.getDate() - 7);
  }
  if (candidate.getTime() < startAt.getTime()) return null;
  if (candidate.getTime() > now.getTime()) {
    return { dueAt: candidate, key: candidate.toISOString().slice(0, 10) };
  }
  return { dueAt: candidate, key: candidate.toISOString().slice(0, 10) };
}

function nextMonthlyOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  let candidate = clampedMonthlyDate(now.getFullYear(), now.getMonth(), schedule.dayOfMonth, time.hour, time.minute);
  if (candidate.getTime() > now.getTime()) {
    candidate = clampedMonthlyDate(candidate.getFullYear(), candidate.getMonth() - 1, schedule.dayOfMonth, time.hour, time.minute);
  }
  while (candidate.getTime() < startAt.getTime()) {
    candidate = clampedMonthlyDate(candidate.getFullYear(), candidate.getMonth() + 1, schedule.dayOfMonth, time.hour, time.minute);
  }
  if (candidate.getTime() > now.getTime()) {
    return { dueAt: candidate, key: monthlyKey(candidate) };
  }
  return { dueAt: candidate, key: monthlyKey(candidate) };
}

function nextIntervalOccurrence(
  schedule: RecurringScheduleRecord,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): { dueAt: Date; key: string } | null {
  if (!Number.isInteger(interval) || interval === undefined || interval < 1) return null;
  const anchor = recurringStartAt(schedule);
  if (!anchor) return null;
  const time = schedule.cadence === 'interval_days' ? parseLocalTime(schedule.localTime) : null;
  const dueAt = new Date(anchor.getTime());
  if (time) dueAt.setHours(time.hour, time.minute, 0, 0);
  const totalIntervalMs = interval * intervalMs;
  if (dueAt.getTime() > now.getTime()) {
    return { dueAt, key: intervalKey(dueAt, schedule.cadence) };
  }
  const elapsedMs = now.getTime() - dueAt.getTime();
  const intervalsElapsed = Math.floor(elapsedMs / totalIntervalMs);
  dueAt.setTime(dueAt.getTime() + intervalsElapsed * totalIntervalMs);
  return { dueAt, key: intervalKey(dueAt, schedule.cadence) };
}

function recurringStartAt(schedule: RecurringScheduleRecord): Date | null {
  const value = new Date(schedule.startAt ?? schedule.createdAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

function parseLocalTime(value: string | undefined): { hour: number; minute: number } | null {
  if (!value) return null;
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function clampedMonthlyDate(year: number, month: number, dayOfMonth: number, hour: number, minute: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dayOfMonth, lastDay), hour, minute, 0, 0);
}

function monthlyKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function intervalKey(dueAt: Date, cadence: RecurringCadence): string {
  if (cadence === 'interval_days') {
    return monthlyKey(dueAt);
  }
  return dueAt.toISOString();
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
