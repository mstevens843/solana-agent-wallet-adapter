import type { SchedulerDecision, SchedulerInput } from './types.js';

export type PriceTriggerOp = 'lt' | 'gt' | 'lte' | 'gte' | 'eq';

export interface PriceTriggerSpec {
  feed: string;
  op: PriceTriggerOp;
  threshold: number;
}

export interface CronExpr {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  doms: ReadonlySet<number>;
  months: ReadonlySet<number>;
  dows: ReadonlySet<number>;
}

const INTERVAL_RE = /^(\d+)([smhd])$/;
const ISO_INTERVAL_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const PRICE_TRIGGER_RE = /^(\S+):(lt|gt|lte|gte|eq):(-?\d+(?:\.\d+)?)$/;
const JSON_PRICE_TRIGGER_OPS: Record<string, PriceTriggerOp> = {
  '<': 'lt',
  '<=': 'lte',
  '>': 'gt',
  '>=': 'gte',
  '=': 'eq',
  '==': 'eq',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  eq: 'eq',
};
const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};
const CRON_FORBIDDEN_FIELD_SUBSTRS = ['?', '#'];
// Walk back this many minutes when searching for the most-recent cron
// firing. 35 days covers monthly-on-the-1st in the worst case (Feb has 28
// days, so reading back >31 covers it).
const CRON_LOOKBACK_MINUTES = 35 * 24 * 60;
// Walk forward far enough to cover yearly-ish cron expressions while keeping
// malformed or impossible expressions bounded.
const CRON_LOOKAHEAD_MINUTES = 370 * 24 * 60;

export function parseIntervalSpec(spec: string): number | { error: string } {
  const trimmed = spec.trim();
  const iso = parseIsoIntervalSpec(trimmed);
  if (typeof iso === 'number' || iso.error !== 'invalid-interval-spec') return iso;
  const match = INTERVAL_RE.exec(trimmed);
  if (!match) return { error: 'invalid-interval-spec' };
  const n = Number.parseInt(match[1] ?? '', 10);
  const unit = match[2];
  if (!Number.isFinite(n) || n <= 0) return { error: 'invalid-interval-spec' };
  switch (unit) {
    case 's': return n * 1_000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: return { error: 'invalid-interval-spec' };
  }
}

function parseIsoIntervalSpec(spec: string): number | { error: string } {
  const match = ISO_INTERVAL_RE.exec(spec);
  if (!match) return { error: 'invalid-interval-spec' };
  const weeks = Number.parseInt(match[1] ?? '0', 10);
  const days = Number.parseInt(match[2] ?? '0', 10);
  const hours = Number.parseInt(match[3] ?? '0', 10);
  const minutes = Number.parseInt(match[4] ?? '0', 10);
  const seconds = Number.parseInt(match[5] ?? '0', 10);
  const total = weeks * 7 * 86_400_000
    + days * 86_400_000
    + hours * 3_600_000
    + minutes * 60_000
    + seconds * 1_000;
  if (!Number.isFinite(total) || total <= 0) return { error: 'invalid-interval-spec' };
  return total;
}

export function parsePriceTriggerSpec(spec: string): PriceTriggerSpec | { error: string } {
  const trimmed = spec.trim();
  if (trimmed.startsWith('{')) {
    return parseJsonPriceTriggerSpec(trimmed);
  }
  const match = PRICE_TRIGGER_RE.exec(trimmed);
  if (!match) return { error: 'invalid-price-trigger-spec' };
  const feed = (match[1] ?? '').toUpperCase();
  const op = match[2] as PriceTriggerOp;
  const threshold = Number.parseFloat(match[3] ?? '');
  if (!feed || !Number.isFinite(threshold)) return { error: 'invalid-price-trigger-spec' };
  return { feed, op, threshold };
}

function parseJsonPriceTriggerSpec(spec: string): PriceTriggerSpec | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    return { error: 'invalid-price-trigger-spec' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'invalid-price-trigger-spec' };
  }
  const record = parsed as Record<string, unknown>;
  const feedRaw = typeof record.feedId === 'string'
    ? record.feedId
    : typeof record.feed === 'string'
      ? record.feed
      : undefined;
  const opRaw = typeof record.op === 'string' ? record.op : undefined;
  const thresholdRaw = typeof record.threshold === 'string' || typeof record.threshold === 'number'
    ? record.threshold
    : undefined;
  const op = opRaw ? JSON_PRICE_TRIGGER_OPS[opRaw] : undefined;
  const threshold = typeof thresholdRaw === 'number'
    ? thresholdRaw
    : Number.parseFloat(thresholdRaw ?? '');
  const feed = feedRaw?.trim().toUpperCase() ?? '';
  if (!feed || !op || !Number.isFinite(threshold)) {
    return { error: 'invalid-price-trigger-spec' };
  }
  return { feed, op, threshold };
}

export function parseCronSpec(spec: string): CronExpr | { error: string } {
  const trimmed = spec.trim();
  if (trimmed.startsWith('@')) return { error: 'cron-feature-not-supported' };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return { error: 'cron-must-have-5-fields' };
  for (const field of fields) {
    if (isForbiddenCronField(field)) return { error: 'cron-feature-not-supported' };
  }
  const [minStr, hourStr, domStr, monthStr, dowStr] = fields as [string, string, string, string, string];
  const minutes = parseCronField(minStr, 0, 59);
  if ('error' in minutes) return { error: `cron-minute-${minutes.error}` };
  const hours = parseCronField(hourStr, 0, 23);
  if ('error' in hours) return { error: `cron-hour-${hours.error}` };
  const doms = parseCronField(domStr, 1, 31);
  if ('error' in doms) return { error: `cron-dom-${doms.error}` };
  const months = parseCronField(monthStr, 1, 12);
  if ('error' in months) return { error: `cron-month-${months.error}` };
  const dows = parseCronField(dowStr, 0, 6, DOW_NAMES);
  if ('error' in dows) return { error: `cron-dow-${dows.error}` };
  return {
    minutes: minutes.values,
    hours: hours.values,
    doms: doms.values,
    months: months.values,
    dows: dows.values,
  };
}

export function cronMatches(expr: CronExpr, date: Date): boolean {
  return expr.minutes.has(date.getUTCMinutes())
    && expr.hours.has(date.getUTCHours())
    && expr.doms.has(date.getUTCDate())
    && expr.months.has(date.getUTCMonth() + 1)
    && expr.dows.has(date.getUTCDay());
}

export function nextCronFiringBefore(expr: CronExpr, now: Date): Date | undefined {
  let candidate = new Date(now.getTime());
  candidate.setUTCSeconds(0, 0);
  for (let i = 0; i < CRON_LOOKBACK_MINUTES; i++) {
    if (cronMatches(expr, candidate)) return candidate;
    candidate = new Date(candidate.getTime() - 60_000);
  }
  return undefined;
}

export function nextCronFiringAfter(expr: CronExpr, now: Date): Date | undefined {
  let candidate = new Date(now.getTime());
  candidate.setUTCSeconds(0, 0);
  if (candidate.getTime() < now.getTime()) {
    candidate = new Date(candidate.getTime() + 60_000);
  }
  for (let i = 0; i < CRON_LOOKAHEAD_MINUTES; i++) {
    if (cronMatches(expr, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + 60_000);
  }
  return undefined;
}

export async function evaluateSchedule(input: SchedulerInput): Promise<SchedulerDecision> {
  const { manifest, lastExecutionAtIso, now } = input;
  const kind = manifest.schedule.kind;
  const spec = manifest.schedule.spec;
  if (kind === 'interval') {
    const parsed = parseIntervalSpec(spec);
    if (typeof parsed !== 'number') return { due: false, reason: parsed.error };
    if (!lastExecutionAtIso) return { due: true, reason: 'first-run' };
    const lastMs = Date.parse(lastExecutionAtIso);
    if (!Number.isFinite(lastMs)) return { due: true, reason: 'last-execution-unparseable' };
    const elapsed = now.getTime() - lastMs;
    if (elapsed >= parsed) return { due: true, reason: 'interval-elapsed' };
    return {
      due: false,
      reason: 'interval-not-elapsed',
      nextDueAtIso: new Date(lastMs + parsed).toISOString(),
    };
  }
  if (kind === 'cron') {
    const expr = parseCronSpec(spec);
    if ('error' in expr) return { due: false, reason: expr.error };
    const previous = nextCronFiringBefore(expr, now);
    if (!previous) return { due: false, reason: 'cron-no-firing-in-window' };
    if (!lastExecutionAtIso) {
      const installedAtMs = Date.parse(input.install.installedAt);
      if (Number.isFinite(installedAtMs) && previous.getTime() < installedAtMs) {
        return {
          due: false,
          reason: 'cron-before-install',
          nextDueAtIso: nextCronFiringAfter(expr, new Date(installedAtMs))?.toISOString(),
        };
      }
      return { due: true, reason: 'first-run' };
    }
    const lastMs = Date.parse(lastExecutionAtIso);
    if (!Number.isFinite(lastMs)) return { due: true, reason: 'last-execution-unparseable' };
    if (previous.getTime() > lastMs) return { due: true, reason: 'cron-fired' };
    return { due: false, reason: 'cron-already-fired' };
  }
  if (kind === 'price-trigger') {
    const parsed = parsePriceTriggerSpec(spec);
    if ('error' in parsed) return { due: false, reason: parsed.error };
    if (!input.priceLookup) {
      return { due: false, reason: 'price-trigger-no-lookup-available' };
    }
    let price: number;
    try {
      price = await input.priceLookup(parsed.feed, input.cluster);
    } catch (err) {
      return { due: false, reason: `price-trigger-lookup-failed:${errMsg(err)}` };
    }
    if (!Number.isFinite(price)) return { due: false, reason: 'price-trigger-price-not-finite' };
    if (compareOp(price, parsed.op, parsed.threshold)) {
      return { due: true, reason: `price-trigger-${parsed.op}` };
    }
    return { due: false, reason: 'price-trigger-threshold-not-met' };
  }
  return { due: false, reason: `unknown-schedule-kind:${String(kind)}` };
}

function compareOp(value: number, op: PriceTriggerOp, threshold: number): boolean {
  switch (op) {
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'eq': return value === threshold;
    default: return false;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/\s+/g, '_').slice(0, 80);
  return 'error';
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
): { values: ReadonlySet<number> } | { error: string } {
  const values = new Set<number>();
  const items = field.split(',');
  for (const itemRaw of items) {
    const item = itemRaw.trim();
    if (!item) return { error: 'empty-segment' };
    const slashIdx = item.indexOf('/');
    let core = item;
    let step = 1;
    if (slashIdx >= 0) {
      core = item.slice(0, slashIdx);
      const stepStr = item.slice(slashIdx + 1);
      const stepNum = Number.parseInt(stepStr, 10);
      if (!Number.isFinite(stepNum) || stepNum <= 0) return { error: 'bad-step' };
      step = stepNum;
    }
    let lo = min;
    let hi = max;
    if (core !== '*') {
      const dash = core.indexOf('-');
      if (dash >= 0) {
        const loStr = core.slice(0, dash);
        const hiStr = core.slice(dash + 1);
        const loVal = lookupValue(loStr, names);
        const hiVal = lookupValue(hiStr, names);
        if (loVal === undefined || hiVal === undefined) return { error: 'bad-range' };
        lo = loVal;
        hi = hiVal;
      } else {
        const val = lookupValue(core, names);
        if (val === undefined) return { error: 'bad-value' };
        lo = val;
        hi = val;
      }
    }
    if (lo < min || hi > max || lo > hi) return { error: 'out-of-range' };
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) return { error: 'empty-field' };
  return { values };
}

function isForbiddenCronField(field: string): boolean {
  if (field === 'L' || field === 'W') return true;
  if (CRON_FORBIDDEN_FIELD_SUBSTRS.some((s) => field.includes(s))) return true;
  if (/\d[LW]/i.test(field)) return true;
  return false;
}

function lookupValue(raw: string, names: Record<string, number>): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const named = names[trimmed.toUpperCase()];
  if (named !== undefined) return named;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}
