import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Cluster } from '@solana-agent-wallet-adapter/core';

export type PreparedActionKind = 'transfer_sol' | 'transfer_spl' | 'swap';
export type PreparedActionTxStatus = 'pending' | 'confirmed' | 'failed';
export type RecurringCadence = 'weekly' | 'monthly' | 'interval_days' | 'interval_hours' | 'interval_minutes';

export type PreparedActionStatus =
  | 'scheduled'
  | 'ready'
  | 'overdue'
  | 'approval_pending'
  | 'approved'
  | 'rejected'
  | 'blocked'
  | 'failed';

export interface PreparedAction {
  id: string;
  kind: PreparedActionKind;
  status: PreparedActionStatus;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: Record<string, unknown>;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  activeRequestId?: string;
  txid?: string;
  txStatus?: PreparedActionTxStatus;
  confirmedAt?: string;
  txError?: string;
  error?: string;
  note?: string;
  recurringId?: string;
  occurrenceKey?: string;
  archived?: boolean;
  archivedAt?: string;
}

export interface RecurringPayment {
  id: string;
  status: 'active' | 'paused';
  walletAddress: string;
  cluster: Cluster;
  token: string;
  recipient: string;
  amount: string;
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  maxOccurrences?: number;
  occurrencesCreated?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringPaymentView extends RecurringPayment {
  nextDueAt?: string;
}

export interface ActionReceipt {
  actionId: string;
  status: PreparedActionStatus;
  txStatus?: PreparedActionTxStatus;
  txid?: string;
  explorerUrl?: string;
  summary: string;
  note?: string;
  walletAddress: string;
  recipient?: string;
  amount?: string;
  token?: string;
  cluster: Cluster;
  createdAt: string;
  completedAt: string;
  error?: string;
  recurringId?: string;
  occurrenceKey?: string;
}

interface PreparedActionState {
  actions: PreparedAction[];
  recurringPayments: RecurringPayment[];
}

export interface AddPreparedActionInput {
  kind: PreparedActionKind;
  walletAddress: string;
  cluster: Cluster;
  summary: string;
  params: Record<string, unknown>;
  dueAt?: string;
  status?: PreparedActionStatus;
  note?: string;
  recurringId?: string;
  occurrenceKey?: string;
}

export interface PreparedActionStore {
  addAction(input: AddPreparedActionInput): Promise<PreparedAction>;
  listActions(): Promise<PreparedAction[]>;
  getAction(id: string): Promise<PreparedAction | null>;
  updateAction(id: string, patch: Partial<PreparedAction>): Promise<PreparedAction>;
  deleteAction(id: string): Promise<boolean>;
  archiveAction(id: string): Promise<PreparedAction>;
  addRecurringPayment(input: Omit<RecurringPayment, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Promise<RecurringPayment>;
  listRecurringPayments(): Promise<RecurringPayment[]>;
  listRecurringPaymentViews(now?: Date): Promise<RecurringPaymentView[]>;
  updateRecurringPayment(id: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment>;
  deleteRecurringPayment(id: string): Promise<boolean>;
  materializeDueRecurring(now?: Date): Promise<PreparedAction[]>;
  listReceipts(): Promise<ActionReceipt[]>;
  getStoragePath?(): string;
}

export class JsonPreparedActionStore implements PreparedActionStore {
  private readonly path: string;
  private queue = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async addAction(input: AddPreparedActionInput): Promise<PreparedAction> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const dueAt = input.dueAt ?? now;
      const action: PreparedAction = {
        id: newId('pa'),
        kind: input.kind,
        status: input.status ?? statusForDueAt(dueAt, new Date(now)),
        walletAddress: input.walletAddress,
        cluster: input.cluster,
        summary: input.summary,
        params: input.params,
        dueAt,
        createdAt: now,
        updatedAt: now,
        ...(input.note !== undefined && { note: input.note }),
        ...(input.recurringId !== undefined && { recurringId: input.recurringId }),
        ...(input.occurrenceKey !== undefined && { occurrenceKey: input.occurrenceKey }),
      };
      state.actions.push(action);
      return action;
    });
  }

  async listActions(): Promise<PreparedAction[]> {
    const state = await this.read();
    const now = new Date();
    return state.actions
      .map((action) =>
        action.status === 'scheduled' && new Date(action.dueAt).getTime() <= now.getTime()
          ? { ...action, status: 'overdue' as const }
          : action,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getAction(id: string): Promise<PreparedAction | null> {
    const actions = await this.listActions();
    return actions.find((action) => action.id === id) ?? null;
  }

  async updateAction(id: string, patch: Partial<PreparedAction>): Promise<PreparedAction> {
    return this.mutate((state) => {
      const index = state.actions.findIndex((action) => action.id === id);
      if (index < 0) {
        throw new Error(`Unknown prepared action: ${id}`);
      }
      const current = state.actions[index];
      if (!current) {
        throw new Error(`Unknown prepared action: ${id}`);
      }
      const updated: PreparedAction = {
        ...current,
        ...patch,
        id,
        updatedAt: new Date().toISOString(),
      };
      state.actions[index] = updated;
      return updated;
    });
  }

  async deleteAction(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.actions.length;
      state.actions = state.actions.filter((action) => action.id !== id);
      return state.actions.length !== before;
    });
  }

  async archiveAction(id: string): Promise<PreparedAction> {
    return this.updateAction(id, {
      archived: true,
      archivedAt: new Date().toISOString(),
    });
  }

  async addRecurringPayment(
    input: Omit<RecurringPayment, 'id' | 'status' | 'createdAt' | 'updatedAt'>,
  ): Promise<RecurringPayment> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const payment: RecurringPayment = {
        id: newId('rp'),
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ...input,
        startAt: input.startAt ?? now,
      };
      state.recurringPayments.push(payment);
      return payment;
    });
  }

  async listRecurringPayments(): Promise<RecurringPayment[]> {
    const state = await this.read();
    return [...state.recurringPayments];
  }

  async listRecurringPaymentViews(now = new Date()): Promise<RecurringPaymentView[]> {
    const state = await this.read();
    return state.recurringPayments
      .map((payment) => ({
        ...payment,
        ...(nextRecurringOccurrence(payment, now) ? { nextDueAt: nextRecurringOccurrence(payment, now)!.dueAt.toISOString() } : {}),
      }))
      .sort((left, right) => {
        const leftDue = left.nextDueAt ?? '9999-12-31T23:59:59.999Z';
        const rightDue = right.nextDueAt ?? '9999-12-31T23:59:59.999Z';
        return leftDue.localeCompare(rightDue);
      });
  }

  async updateRecurringPayment(id: string, patch: Partial<RecurringPayment>): Promise<RecurringPayment> {
    return this.mutate((state) => {
      const index = state.recurringPayments.findIndex((payment) => payment.id === id);
      if (index < 0) {
        throw new Error(`Unknown recurring payment: ${id}`);
      }
      const current = state.recurringPayments[index];
      if (!current) {
        throw new Error(`Unknown recurring payment: ${id}`);
      }
      const updated: RecurringPayment = {
        ...current,
        ...patch,
        id,
        updatedAt: new Date().toISOString(),
      };
      state.recurringPayments[index] = updated;
      return updated;
    });
  }

  async deleteRecurringPayment(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.recurringPayments.length;
      state.recurringPayments = state.recurringPayments.filter((payment) => payment.id !== id);
      return state.recurringPayments.length !== before;
    });
  }

  async materializeDueRecurring(now = new Date()): Promise<PreparedAction[]> {
    return this.mutate((state) => {
      const created: PreparedAction[] = [];
      for (const payment of state.recurringPayments) {
        if (payment.status !== 'active') continue;
        if (payment.maxOccurrences !== undefined && (payment.occurrencesCreated ?? 0) >= payment.maxOccurrences) {
          continue;
        }
        const occurrence = latestRecurringOccurrence(payment, now);
        if (!occurrence || occurrence.dueAt.getTime() > now.getTime()) continue;
        const exists = state.actions.some(
          (action) => action.recurringId === payment.id && action.occurrenceKey === occurrence.key,
        );
        if (exists) continue;
        const timestamp = new Date().toISOString();
        const action: PreparedAction = {
          id: newId('pa'),
          kind: payment.token.toUpperCase() === 'SOL' ? 'transfer_sol' : 'transfer_spl',
          status: occurrence.dueAt.getTime() < now.getTime() ? 'overdue' : 'ready',
          walletAddress: payment.walletAddress,
          cluster: payment.cluster,
          summary: `Recurring ${payment.amount} ${payment.token} payment to ${payment.recipient}`,
          params:
            payment.token.toUpperCase() === 'SOL'
              ? { recipient: payment.recipient, amountSol: payment.amount }
              : {
                  token: payment.token,
                  recipient: payment.recipient,
                  amount: payment.amount,
                },
          dueAt: occurrence.dueAt.toISOString(),
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(payment.note !== undefined && { note: payment.note }),
          recurringId: payment.id,
          occurrenceKey: occurrence.key,
        };
        state.actions.push(action);
        payment.occurrencesCreated = (payment.occurrencesCreated ?? 0) + 1;
        payment.updatedAt = timestamp;
        created.push(action);
      }
      return created;
    });
  }

  async listReceipts(): Promise<ActionReceipt[]> {
    const state = await this.read();
    return state.actions
      .filter((action) => ['approved', 'rejected', 'failed', 'blocked'].includes(action.status))
      .map((action) => actionReceipt(action))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  getStoragePath(): string {
    return this.path;
  }

  private async mutate<T>(mutator: (state: PreparedActionState) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.read();
      const result = mutator(state);
      await this.write(state);
      return result;
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async read(): Promise<PreparedActionState> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PreparedActionState>;
      return normalizeState({
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        recurringPayments: Array.isArray(parsed.recurringPayments) ? parsed.recurringPayments : [],
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { actions: [], recurringPayments: [] };
      }
      throw err;
    }
  }

  private async write(state: PreparedActionState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.path);
  }
}

function normalizeState(state: PreparedActionState): PreparedActionState {
  return {
    actions: state.actions.map(normalizePreparedAction),
    recurringPayments: state.recurringPayments,
  };
}

function normalizePreparedAction(action: PreparedAction): PreparedAction {
  if (
    action.kind !== 'transfer_sol' ||
    typeof action.params.amountSol === 'string' ||
    typeof action.params.amount !== 'string'
  ) {
    return action;
  }
  return {
    ...action,
    params: {
      ...action.params,
      amountSol: action.params.amount,
    },
  };
}

export function defaultPreparedActionStorePath(): string {
  return resolve(process.cwd(), '.agent-wallet', 'prepared-actions.json');
}

function latestRecurringOccurrence(
  payment: RecurringPayment,
  now: Date,
): { dueAt: Date; key: string } | null {
  const startAt = recurringStartAt(payment);
  if (!startAt) {
    return null;
  }
  let occurrence: { dueAt: Date; key: string } | null;
  switch (payment.cadence) {
    case 'weekly':
      occurrence = latestWeeklyOccurrence(payment, now);
      break;
    case 'monthly':
      occurrence = latestMonthlyOccurrence(payment, now);
      break;
    case 'interval_days':
      occurrence = latestIntervalOccurrence(payment, now, payment.intervalDays, 24 * 60 * 60 * 1000);
      break;
    case 'interval_hours':
      occurrence = latestIntervalOccurrence(payment, now, payment.intervalHours, 60 * 60 * 1000);
      break;
    case 'interval_minutes':
      occurrence = latestIntervalOccurrence(payment, now, payment.intervalMinutes, 60 * 1000);
      break;
  }
  if (!occurrence || occurrence.dueAt.getTime() < startAt.getTime()) {
    return null;
  }
  return occurrence;
}

export function nextRecurringDueAt(payment: RecurringPayment, now = new Date()): string | null {
  return nextRecurringOccurrence(payment, now)?.dueAt.toISOString() ?? null;
}

function nextRecurringOccurrence(
  payment: RecurringPayment,
  now: Date,
): { dueAt: Date; key: string } | null {
  const startAt = recurringStartAt(payment);
  if (!startAt) return null;
  if (payment.status !== 'active') return null;
  if (payment.maxOccurrences !== undefined && (payment.occurrencesCreated ?? 0) >= payment.maxOccurrences) {
    return null;
  }
  switch (payment.cadence) {
    case 'weekly':
      return nextWeeklyOccurrence(payment, now, startAt);
    case 'monthly':
      return nextMonthlyOccurrence(payment, now, startAt);
    case 'interval_days':
      return nextIntervalOccurrence(payment, now, payment.intervalDays, 24 * 60 * 60 * 1000);
    case 'interval_hours':
      return nextIntervalOccurrence(payment, now, payment.intervalHours, 60 * 60 * 1000);
    case 'interval_minutes':
      return nextIntervalOccurrence(payment, now, payment.intervalMinutes, 60 * 1000);
  }
}

function nextWeeklyOccurrence(
  payment: RecurringPayment,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  if (!payment.localTime || !Number.isInteger(payment.dayOfWeek) || payment.dayOfWeek === undefined) return null;
  const time = parseLocalTime(payment.localTime);
  if (!time) return null;
  const dueAt = new Date(now);
  dueAt.setHours(time.hour, time.minute, 0, 0);
  const daysForward = (payment.dayOfWeek - dueAt.getDay() + 7) % 7;
  dueAt.setDate(dueAt.getDate() + daysForward);
  if (dueAt.getTime() <= now.getTime()) {
    dueAt.setDate(dueAt.getDate() + 7);
  }
  while (dueAt.getTime() < startAt.getTime()) {
    dueAt.setDate(dueAt.getDate() + 7);
  }
  return { dueAt, key: dueAt.toISOString().slice(0, 10) };
}

function nextMonthlyOccurrence(
  payment: RecurringPayment,
  now: Date,
  startAt: Date,
): { dueAt: Date; key: string } | null {
  if (!payment.localTime || !Number.isInteger(payment.dayOfMonth) || payment.dayOfMonth === undefined) return null;
  const time = parseLocalTime(payment.localTime);
  if (!time) return null;
  let dueAt = clampedMonthlyDate(now.getFullYear(), now.getMonth(), payment.dayOfMonth, time.hour, time.minute);
  if (dueAt.getTime() <= now.getTime()) {
    dueAt = clampedMonthlyDate(now.getFullYear(), now.getMonth() + 1, payment.dayOfMonth, time.hour, time.minute);
  }
  while (dueAt.getTime() < startAt.getTime()) {
    dueAt = clampedMonthlyDate(dueAt.getFullYear(), dueAt.getMonth() + 1, payment.dayOfMonth, time.hour, time.minute);
  }
  return { dueAt, key: dueAt.toISOString().slice(0, 10) };
}

function nextIntervalOccurrence(
  payment: RecurringPayment,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): { dueAt: Date; key: string } | null {
  if (!Number.isInteger(interval) || interval === undefined || interval < 1) return null;
  const anchor = recurringStartAt(payment);
  if (!anchor) return null;
  const totalIntervalMs = interval * intervalMs;
  const dueAt = new Date(anchor);
  if (dueAt.getTime() <= now.getTime()) {
    const elapsedMs = now.getTime() - dueAt.getTime();
    dueAt.setTime(dueAt.getTime() + (Math.floor(elapsedMs / totalIntervalMs) + 1) * totalIntervalMs);
  }
  return {
    dueAt,
    key: payment.cadence === 'interval_days' ? dueAt.toISOString().slice(0, 10) : dueAt.toISOString(),
  };
}

function actionReceipt(action: PreparedAction): ActionReceipt {
  const recipient =
    typeof action.params.recipient === 'string'
      ? action.params.recipient
      : undefined;
  const amount =
    typeof action.params.amountSol === 'string'
      ? action.params.amountSol
      : typeof action.params.amount === 'string'
        ? action.params.amount
        : undefined;
  const token =
    action.kind === 'transfer_sol'
      ? 'SOL'
      : typeof action.params.token === 'string'
        ? action.params.token
        : typeof action.params.inputToken === 'string'
          ? action.params.inputToken
          : undefined;
  return {
    actionId: action.id,
    status: action.status,
    ...(action.txStatus !== undefined && { txStatus: action.txStatus }),
    ...(action.txid !== undefined && { txid: action.txid }),
    ...(action.txid !== undefined && { explorerUrl: explorerUrl(action.txid, action.cluster) }),
    summary: action.summary,
    ...(action.note !== undefined && { note: action.note }),
    walletAddress: action.walletAddress,
    ...(recipient !== undefined && { recipient }),
    ...(amount !== undefined && { amount }),
    ...(token !== undefined && { token }),
    cluster: action.cluster,
    createdAt: action.createdAt,
    completedAt: action.confirmedAt ?? action.updatedAt,
    ...(action.error !== undefined && { error: action.error }),
    ...(action.recurringId !== undefined && { recurringId: action.recurringId }),
    ...(action.occurrenceKey !== undefined && { occurrenceKey: action.occurrenceKey }),
  };
}

function explorerUrl(txid: string, cluster: Cluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${txid}${clusterParam}`;
}

function latestWeeklyOccurrence(
  payment: RecurringPayment,
  now: Date,
): { dueAt: Date; key: string } | null {
  if (!payment.localTime) {
    return null;
  }
  const [hourRaw, minuteRaw] = payment.localTime.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  if (!Number.isInteger(payment.dayOfWeek) || payment.dayOfWeek === undefined) {
    return null;
  }
  const dueAt = new Date(now);
  dueAt.setHours(hour, minute, 0, 0);
  const daysBack = (dueAt.getDay() - payment.dayOfWeek + 7) % 7;
  dueAt.setDate(dueAt.getDate() - daysBack);
  if (dueAt.getTime() > now.getTime()) {
    dueAt.setDate(dueAt.getDate() - 7);
  }
  return { dueAt, key: dueAt.toISOString().slice(0, 10) };
}

function latestMonthlyOccurrence(
  payment: RecurringPayment,
  now: Date,
): { dueAt: Date; key: string } | null {
  if (!payment.localTime) {
    return null;
  }
  const time = parseLocalTime(payment.localTime);
  if (!time || !Number.isInteger(payment.dayOfMonth) || payment.dayOfMonth === undefined) {
    return null;
  }
  const dueAt = clampedMonthlyDate(now.getFullYear(), now.getMonth(), payment.dayOfMonth, time.hour, time.minute);
  if (dueAt.getTime() > now.getTime()) {
    dueAt.setMonth(dueAt.getMonth() - 1);
    const previous = clampedMonthlyDate(dueAt.getFullYear(), dueAt.getMonth(), payment.dayOfMonth, time.hour, time.minute);
    return { dueAt: previous, key: previous.toISOString().slice(0, 10) };
  }
  return { dueAt, key: dueAt.toISOString().slice(0, 10) };
}

function latestIntervalOccurrence(
  payment: RecurringPayment,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): { dueAt: Date; key: string } | null {
  if (!Number.isInteger(interval) || interval === undefined || interval < 1) {
    return null;
  }
  const anchor = new Date(payment.startAt ?? payment.createdAt);
  if (Number.isNaN(anchor.getTime())) {
    return null;
  }
  const dueAt = new Date(anchor);
  const time = payment.localTime ? parseLocalTime(payment.localTime) : null;
  if (time && payment.cadence === 'interval_days') {
    dueAt.setHours(time.hour, time.minute, 0, 0);
  }
  if (dueAt.getTime() > now.getTime()) {
    return null;
  }
  const elapsedMs = now.getTime() - dueAt.getTime();
  const totalIntervalMs = interval * intervalMs;
  const intervalsElapsed = Math.floor(elapsedMs / totalIntervalMs);
  dueAt.setTime(dueAt.getTime() + intervalsElapsed * totalIntervalMs);
  return {
    dueAt,
    key: payment.cadence === 'interval_days' ? dueAt.toISOString().slice(0, 10) : dueAt.toISOString(),
  };
}

function recurringStartAt(payment: RecurringPayment): Date | null {
  const startAt = new Date(payment.startAt ?? payment.createdAt);
  return Number.isNaN(startAt.getTime()) ? null : startAt;
}

function parseLocalTime(localTime: string): { hour: number; minute: number } | null {
  const [hourRaw, minuteRaw] = localTime.split(':');
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

function statusForDueAt(dueAt: string, now: Date): PreparedActionStatus {
  return new Date(dueAt).getTime() > now.getTime() ? 'scheduled' : 'ready';
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${suffix}`;
}
