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
  // IANA timezone (e.g. "America/New_York") in which `localTime`, `dayOfWeek`,
  // and `dayOfMonth` are interpreted. When present, weekly/monthly occurrences
  // are computed in this zone (DST-aware) so the same instant is produced no
  // matter where the code runs (browser preview vs server scheduler). When
  // absent, the legacy environment-local interpretation is used.
  timezone?: string;
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

// ---- Timezone-aware wall-clock helpers (DST-correct, no external library) ----
//
// When a schedule carries an IANA `timezone`, weekly/monthly occurrences (and the
// time-of-day of interval_days) are computed in that zone so the same UTC instant
// is produced no matter where the code runs — the browser preview and the server
// scheduler agree, and DST transitions keep the wall-clock time stable.

export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    // Throws RangeError for an unknown time zone.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0=Sun .. 6=Sat
}

const ZONED_WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function zonedParts(timeZone: string, date: Date): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const hour = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hour === 24 ? 0 : hour, // some engines emit 24 for midnight under h23
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: ZONED_WEEKDAY[map.weekday ?? 'Sun'] ?? 0,
  };
}

// Offset (ms) added to a UTC instant to obtain its wall-clock in `timeZone`.
function zoneOffsetMs(timeZone: string, date: Date): number {
  const p = zonedParts(timeZone, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

// The UTC instant whose wall-clock in `timeZone` is the given Y-M-D H:M (DST-aware).
// Re-resolves the offset once so a DST transition between the naive guess and the
// corrected instant is accounted for.
function zonedWallClockToUtc(
  timeZone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset1 = zoneOffsetMs(timeZone, new Date(naive));
  let utc = naive - offset1;
  const offset2 = zoneOffsetMs(timeZone, new Date(utc));
  if (offset2 !== offset1) utc = naive - offset2;
  return new Date(utc);
}

// Calendar arithmetic in the wall-clock frame — UTC Date used purely as a
// proleptic-Gregorian calculator (no timezone involved here).
function addCalendarDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function addCalendarMonths(year: number, month: number, count: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + count, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function clampDayToMonth(year: number, month: number, dayOfMonth: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(dayOfMonth, lastDay);
}

function zonedDateKey(timeZone: string, date: Date): string {
  const p = zonedParts(timeZone, date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function nextFutureWeeklyZoned(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
  timeZone: string,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek === undefined) return null;
  const p = zonedParts(timeZone, now);
  const daysForward = (schedule.dayOfWeek - p.weekday + 7) % 7;
  let wc = addCalendarDays(p.year, p.month, p.day, daysForward);
  let candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
  if (candidate.getTime() <= now.getTime()) {
    wc = addCalendarDays(wc.year, wc.month, wc.day, 7);
    candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
  }
  while (candidate.getTime() < startAt.getTime()) {
    wc = addCalendarDays(wc.year, wc.month, wc.day, 7);
    candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
  }
  return { dueAt: candidate, key: zonedDateKey(timeZone, candidate) };
}

function latestDueWeeklyZoned(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
  timeZone: string,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfWeek) || schedule.dayOfWeek === undefined) return null;
  const p = zonedParts(timeZone, now);
  const daysBack = (p.weekday - schedule.dayOfWeek + 7) % 7;
  let wc = addCalendarDays(p.year, p.month, p.day, -daysBack);
  let candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
  if (candidate.getTime() < startAt.getTime()) {
    while (candidate.getTime() < startAt.getTime()) {
      wc = addCalendarDays(wc.year, wc.month, wc.day, 7);
      candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
    }
  } else if (candidate.getTime() > now.getTime()) {
    wc = addCalendarDays(wc.year, wc.month, wc.day, -7);
    candidate = zonedWallClockToUtc(timeZone, wc.year, wc.month, wc.day, time.hour, time.minute);
  }
  if (candidate.getTime() < startAt.getTime()) return null;
  return { dueAt: candidate, key: zonedDateKey(timeZone, candidate) };
}

function nextFutureMonthlyZoned(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
  timeZone: string,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  const p = zonedParts(timeZone, now);
  let year = p.year;
  let month = p.month;
  let candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  if (candidate.getTime() <= now.getTime()) {
    ({ year, month } = addCalendarMonths(year, month, 1));
    candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  }
  while (candidate.getTime() < startAt.getTime()) {
    ({ year, month } = addCalendarMonths(year, month, 1));
    candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  }
  return { dueAt: candidate, key: zonedDateKey(timeZone, candidate) };
}

function latestDueMonthlyZoned(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
  timeZone: string,
): OccurrenceInfo | null {
  const time = parseLocalTime(schedule.localTime);
  if (!time) return null;
  if (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth === undefined) return null;
  const p = zonedParts(timeZone, now);
  let year = p.year;
  let month = p.month;
  let candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  if (candidate.getTime() > now.getTime()) {
    ({ year, month } = addCalendarMonths(year, month, -1));
    candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  }
  while (candidate.getTime() < startAt.getTime()) {
    ({ year, month } = addCalendarMonths(year, month, 1));
    candidate = zonedWallClockToUtc(timeZone, year, month, clampDayToMonth(year, month, schedule.dayOfMonth), time.hour, time.minute);
  }
  return { dueAt: candidate, key: zonedDateKey(timeZone, candidate) };
}

// For interval_days, override the anchor's time-of-day at the schedule's localTime
// in its timezone (DST-aware) when a timezone is present.
function applyZonedTimeOfDay(timeZone: string, dueAt: Date, time: { hour: number; minute: number }): Date {
  const p = zonedParts(timeZone, dueAt);
  return zonedWallClockToUtc(timeZone, p.year, p.month, p.day, time.hour, time.minute);
}

// interval_days uses a per-day key; in a timezone it must reflect the zone-local
// day so the key is stable regardless of where the code runs.
function intervalOccurrenceKey(schedule: CadenceFields, dueAt: Date): string {
  if (schedule.cadence === 'interval_days' && isValidTimeZone(schedule.timezone)) {
    return zonedDateKey(schedule.timezone, dueAt);
  }
  return intervalKey(dueAt, schedule.cadence);
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
  if (isValidTimeZone(schedule.timezone)) {
    return nextFutureWeeklyZoned(schedule, now, startAt, schedule.timezone);
  }
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
  if (isValidTimeZone(schedule.timezone)) {
    return nextFutureMonthlyZoned(schedule, now, startAt, schedule.timezone);
  }
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
  const zoned = time && isValidTimeZone(schedule.timezone) ? schedule.timezone : undefined;
  const dueAt = new Date(anchor.getTime());
  if (time) {
    if (zoned) dueAt.setTime(applyZonedTimeOfDay(zoned, dueAt, time).getTime());
    else dueAt.setHours(time.hour, time.minute, 0, 0);
  }
  const totalIntervalMs = interval * intervalMs;
  if (dueAt.getTime() > now.getTime()) {
    return { dueAt, key: intervalOccurrenceKey(schedule, dueAt) };
  }
  const elapsedMs = now.getTime() - dueAt.getTime();
  const intervalsToAdvance = Math.floor(elapsedMs / totalIntervalMs) + 1;
  dueAt.setTime(dueAt.getTime() + intervalsToAdvance * totalIntervalMs);
  return { dueAt, key: intervalOccurrenceKey(schedule, dueAt) };
}

function latestDueWeekly(
  schedule: CadenceFields,
  now: Date,
  startAt: Date,
): OccurrenceInfo | null {
  if (isValidTimeZone(schedule.timezone)) {
    return latestDueWeeklyZoned(schedule, now, startAt, schedule.timezone);
  }
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
  if (isValidTimeZone(schedule.timezone)) {
    return latestDueMonthlyZoned(schedule, now, startAt, schedule.timezone);
  }
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
  const zoned = time && isValidTimeZone(schedule.timezone) ? schedule.timezone : undefined;
  const dueAt = new Date(anchor.getTime());
  if (time) {
    if (zoned) dueAt.setTime(applyZonedTimeOfDay(zoned, dueAt, time).getTime());
    else dueAt.setHours(time.hour, time.minute, 0, 0);
  }
  const totalIntervalMs = interval * intervalMs;
  if (dueAt.getTime() > now.getTime()) {
    return { dueAt, key: intervalOccurrenceKey(schedule, dueAt) };
  }
  const elapsedMs = now.getTime() - dueAt.getTime();
  const intervalsElapsed = Math.floor(elapsedMs / totalIntervalMs);
  dueAt.setTime(dueAt.getTime() + intervalsElapsed * totalIntervalMs);
  return { dueAt, key: intervalOccurrenceKey(schedule, dueAt) };
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
