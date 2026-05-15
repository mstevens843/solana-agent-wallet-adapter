import { parseIntervalSpec } from '@solana-agent-wallet-adapter/skills-runtime';
import { skills } from '@solana-agent-wallet-adapter/workflow/dev';

type SkillSchedule = skills.SkillSchedule;

export function previewNextRuns(
  schedule: SkillSchedule,
  fromIso: string,
  count: number,
): string[] {
  if (count <= 0) return [];

  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw new Error(`previewNextRuns: invalid fromIso "${fromIso}"`);
  }

  if (schedule.kind === 'price-trigger') {
    return [];
  }

  if (schedule.kind === 'interval') {
    const intervalMs = intervalToMs(schedule.spec);
    const result: string[] = [];
    let next = from.getTime();
    for (let i = 0; i < count; i += 1) {
      next += intervalMs;
      result.push(new Date(next).toISOString());
    }
    return result;
  }

  if (schedule.kind === 'cron') {
    return previewCron(schedule.spec, from, count);
  }

  return [];
}

export function isSubMinuteSchedule(schedule: SkillSchedule): boolean {
  if (schedule.kind === 'price-trigger') return false;

  if (schedule.kind === 'interval') {
    const intervalMs = parseIntervalSpec(schedule.spec);
    return typeof intervalMs === 'number' && intervalMs < 60_000;
  }

  if (schedule.kind === 'cron') {
    const parts = schedule.spec.trim().split(/\s+/);
    if (parts.length >= 6) {
      return true;
    }
    if (parts.length === 5) {
      const minute = parts[0]!;
      if (minute === '*' || minute === '*/1' || /^\*\/0*1$/.test(minute)) {
        return true;
      }
    }
    return false;
  }

  return false;
}

function intervalToMs(spec: string): number {
  const intervalMs = parseIntervalSpec(spec);
  if (typeof intervalMs === 'number') return intervalMs;
  throw new Error(
    `Unsupported interval spec "${spec}". Supported runtime interval specs include 15m, 2h, 7d, P1D, P1W, and PT15M.`,
  );
}

function previewCron(spec: string, from: Date, count: number): string[] {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) {
    return [];
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];

  if (minute === '0' && hour === '0' && dom === '*' && month === '*' && /^[0-6]$/.test(dow)) {
    const target = Number.parseInt(dow, 10);
    return weeklyMidnightRuns(from, target, count);
  }

  if (minute === '0' && hour === '0' && dom === '*' && month === '*' && dow === '*') {
    return dailyMidnightRuns(from, count);
  }

  return [];
}

function weeklyMidnightRuns(from: Date, targetDow: number, count: number): string[] {
  const result: string[] = [];
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  );
  while (next.getUTCDay() !== targetDow || next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  for (let i = 0; i < count; i += 1) {
    result.push(next.toISOString());
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return result;
}

function dailyMidnightRuns(from: Date, count: number): string[] {
  const result: string[] = [];
  const next = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  );
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  for (let i = 0; i < count; i += 1) {
    result.push(next.toISOString());
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return result;
}
