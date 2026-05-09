import type { RecurringCadence } from './index.js';

export interface CadenceFields {
  cadence: RecurringCadence;
  dayOfWeek?: number;
  dayOfMonth?: number;
  intervalDays?: number;
  intervalHours?: number;
  intervalMinutes?: number;
  localTime?: string;
  startAt?: string;
  createdAt: string;
  maxOccurrences?: number;
  occurrencesCreated?: number;
  expiresAt?: string;
}

export interface OccurrenceInfo {
  dueAt: Date;
  key: string;
}

export type ExhaustionReason = 'max_occurrences' | 'expired';

export function exhaustionReason(schedule: CadenceFields, now: Date): ExhaustionReason | null {
  if (
    schedule.maxOccurrences !== undefined &&
    (schedule.occurrencesCreated ?? 0) >= schedule.maxOccurrences
  ) {
    return 'max_occurrences';
  }
  if (schedule.expiresAt) {
    const expiry = new Date(schedule.expiresAt);
    if (!Number.isNaN(expiry.getTime()) && now.getTime() >= expiry.getTime()) {
      return 'expired';
    }
  }
  return null;
}

export function nextFutureOccurrence(schedule: CadenceFields, now: Date): OccurrenceInfo | null {
  const startAt = recurringStartAt(schedule);
  if (!startAt) return null;
  const candidate = nextFutureByCadence(schedule, now, startAt);
  if (!candidate) return null;
  if (schedule.expiresAt) {
    const expiry = new Date(schedule.expiresAt);
    if (!Number.isNaN(expiry.getTime()) && candidate.dueAt.getTime() >= expiry.getTime()) {
      return null;
    }
  }
  return candidate;
}

export function latestDueOccurrence(schedule: CadenceFields, now: Date): OccurrenceInfo | null {
  const startAt = recurringStartAt(schedule);
  if (!startAt) return null;
  const candidate = latestDueByCadence(schedule, now, startAt);
  if (!candidate || candidate.dueAt.getTime() < startAt.getTime()) return null;
  if (schedule.expiresAt) {
    const expiry = new Date(schedule.expiresAt);
    if (!Number.isNaN(expiry.getTime()) && candidate.dueAt.getTime() >= expiry.getTime()) {
      return null;
    }
  }
  return candidate;
}

export function previewUpcoming(
  schedule: CadenceFields,
  now: Date,
  count: number,
): OccurrenceInfo[] {
  if (count <= 0) return [];
  const results: OccurrenceInfo[] = [];
  let cursorNow = now;
  let occurrencesCreated = schedule.occurrencesCreated ?? 0;
  for (let i = 0; i < count; i += 1) {
    const probe: CadenceFields = { ...schedule, occurrencesCreated };
    if (exhaustionReason(probe, cursorNow)) break;
    const next = nextFutureOccurrence(probe, cursorNow);
    if (!next) break;
    results.push(next);
    occurrencesCreated += 1;
    cursorNow = new Date(next.dueAt.getTime());
  }
  return results;
}

export function recurringStartAt(schedule: CadenceFields): Date | null {
  const value = new Date(schedule.startAt ?? schedule.createdAt);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function parseLocalTime(value: string | undefined): { hour: number; minute: number } | null {
  if (!value) return null;
  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
}

export function clampedMonthlyDate(
  year: number,
  month: number,
  dayOfMonth: number,
  hour: number,
  minute: number,
): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(dayOfMonth, lastDay), hour, minute, 0, 0);
}

export function monthlyKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function intervalKey(dueAt: Date, cadence: RecurringCadence): string {
  if (cadence === 'interval_days') return monthlyKey(dueAt);
  return dueAt.toISOString();
}

function nextFutureByCadence(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
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

function latestDueByCadence(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
  switch (schedule.cadence) {
    case 'weekly':
      return latestDueWeekly(schedule, now, startAt);
    case 'monthly':
      return latestDueMonthly(schedule, now, startAt);
    case 'interval_days':
      return latestDueInterval(schedule, now, schedule.intervalDays, 24 * 60 * 60 * 1000);
    case 'interval_hours':
      return latestDueInterval(schedule, now, schedule.intervalHours, 60 * 60 * 1000);
    case 'interval_minutes':
      return latestDueInterval(schedule, now, schedule.intervalMinutes, 60 * 1000);
    default:
      return assertNeverCadence(schedule.cadence);
  }
}

function nextFutureWeekly(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
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
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  let candidate = clampedMonthlyDate(
    now.getFullYear(),
    now.getMonth(),
    schedule.dayOfMonth,
    time.hour,
    time.minute,
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate = clampedMonthlyDate(
      candidate.getFullYear(),
      candidate.getMonth() + 1,
      schedule.dayOfMonth,
      time.hour,
      time.minute,
    );
  }
  while (candidate.getTime() < startAt.getTime()) {
    candidate = clampedMonthlyDate(
      candidate.getFullYear(),
      candidate.getMonth() + 1,
      schedule.dayOfMonth,
      time.hour,
      time.minute,
    );
  }
  return { dueAt: candidate, key: monthlyKey(candidate) };
}

function nextFutureInterval(
  schedule: CadenceFields,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): OccurrenceInfo | null {
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

function latestDueWeekly(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
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
  return { dueAt: candidate, key: candidate.toISOString().slice(0, 10) };
}

function latestDueMonthly(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  let candidate = clampedMonthlyDate(
    now.getFullYear(),
    now.getMonth(),
    schedule.dayOfMonth,
    time.hour,
    time.minute,
  );
  if (candidate.getTime() > now.getTime()) {
    candidate = clampedMonthlyDate(
      candidate.getFullYear(),
      candidate.getMonth() - 1,
      schedule.dayOfMonth,
      time.hour,
      time.minute,
    );
  }
  while (candidate.getTime() < startAt.getTime()) {
    candidate = clampedMonthlyDate(
      candidate.getFullYear(),
      candidate.getMonth() + 1,
      schedule.dayOfMonth,
      time.hour,
      time.minute,
    );
  }
  return { dueAt: candidate, key: monthlyKey(candidate) };
}

function latestDueInterval(
  schedule: CadenceFields,
  now: Date,
  interval: number | undefined,
  intervalMs: number,
): OccurrenceInfo | null {
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

function assertNeverCadence(cadence: never): never {
  throw new Error(`Unhandled recurring cadence: ${String(cadence)}`);
}

export interface LifetimeSpend {
  bounded: boolean;
  totalRuns?: number;
  totalAmount?: string;
  perWeek: string;
  perMonth: string;
}

const PREVIEW_CAP = 10_000;

export function lifetimeSpendEstimate(
  schedule: CadenceFields,
  amount: string,
  now: Date,
): LifetimeSpend {
  const isBounded = schedule.maxOccurrences !== undefined || schedule.expiresAt !== undefined;
  const perWeek = formatRate(amount, runsPerWeek(schedule));
  const perMonth = formatRate(amount, runsPerMonth(schedule));
  if (!isBounded) {
    return { bounded: false, perWeek, perMonth };
  }
  const remaining = previewUpcoming(schedule, now, PREVIEW_CAP).length;
  const totalAmount = multiplyDecimalString(amount, remaining);
  return { bounded: true, totalRuns: remaining, totalAmount, perWeek, perMonth };
}

function runsPerWeek(schedule: CadenceFields): number {
  switch (schedule.cadence) {
    case 'weekly':
      return 1;
    case 'monthly':
      return 7 / 30.4375;
    case 'interval_days':
      return schedule.intervalDays && schedule.intervalDays > 0 ? 7 / schedule.intervalDays : 0;
    case 'interval_hours':
      return schedule.intervalHours && schedule.intervalHours > 0 ? 168 / schedule.intervalHours : 0;
    case 'interval_minutes':
      return schedule.intervalMinutes && schedule.intervalMinutes > 0
        ? 10_080 / schedule.intervalMinutes
        : 0;
    default:
      return 0;
  }
}

function runsPerMonth(schedule: CadenceFields): number {
  switch (schedule.cadence) {
    case 'weekly':
      return 30.4375 / 7;
    case 'monthly':
      return 1;
    case 'interval_days':
      return schedule.intervalDays && schedule.intervalDays > 0
        ? 30.4375 / schedule.intervalDays
        : 0;
    case 'interval_hours':
      return schedule.intervalHours && schedule.intervalHours > 0
        ? 730.5 / schedule.intervalHours
        : 0;
    case 'interval_minutes':
      return schedule.intervalMinutes && schedule.intervalMinutes > 0
        ? 43_830 / schedule.intervalMinutes
        : 0;
    default:
      return 0;
  }
}

function formatRate(amount: string, multiplier: number): string {
  const value = Number(amount) * multiplier;
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(6).replace(/\.?0+$/, '');
}

export function multiplyDecimalString(value: string, factor: number): string {
  if (!Number.isInteger(factor) || factor < 0) return '0';
  if (factor === 0) return '0';
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return '0';
  const whole = match[1]!;
  const fraction = match[2] ?? '';
  const decimals = fraction.length;
  if (decimals === 0) return (BigInt(whole) * BigInt(factor)).toString();
  const raw = BigInt(whole + fraction) * BigInt(factor);
  const rawStr = raw.toString().padStart(decimals + 1, '0');
  const head = rawStr.slice(0, -decimals);
  const tail = rawStr.slice(-decimals).replace(/0+$/, '');
  return tail ? `${head}.${tail}` : head;
}
