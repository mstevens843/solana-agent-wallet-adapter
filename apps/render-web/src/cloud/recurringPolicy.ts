import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { lifetimeSpendEstimate, type RecurringScheduleRecord } from '@solana-agent-wallet-adapter/workflow';

import type { RecurringPolicyEnforcer } from './recurringService.js';
import { effectiveScheduleTotalAmount } from './treasuryConfig.js';

export interface RecurringPolicyConfig {
  maxLifetimeAmount?: Record<string, string>;
  maxPerWeekAmount?: Record<string, string>;
  maxPerMonthAmount?: Record<string, string>;
}

export function loadRecurringPolicyFromEnv(): RecurringPolicyConfig | undefined {
  const configPath = process.env.AGENTIC_RECURRING_CONFIG ?? process.env.AGENT_WALLET_CONFIG;
  const candidates = configPath ? [configPath] : recurringConfigCandidates();
  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { recurring?: RecurringPolicyConfig };
      return normalizeRecurringPolicy(parsed.recurring);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function recurringConfigCandidates(): string[] {
  const candidates: string[] = [];
  let cursor = process.cwd();
  while (true) {
    candidates.push(resolve(cursor, 'agent-wallet.config.json'));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return [...new Set(candidates)];
}

export function createRecurringPolicyEnforcer(
  policy: RecurringPolicyConfig | undefined,
): RecurringPolicyEnforcer | undefined {
  const normalized = normalizeRecurringPolicy(policy);
  if (!normalized) return undefined;
  return (schedule) => recurringPolicyViolation(normalized, schedule);
}

function normalizeRecurringPolicy(policy: RecurringPolicyConfig | undefined): RecurringPolicyConfig | undefined {
  if (!policy || typeof policy !== 'object') return undefined;
  const normalized: RecurringPolicyConfig = {};
  if (isAmountMap(policy.maxLifetimeAmount)) normalized.maxLifetimeAmount = normalizeAmountMap(policy.maxLifetimeAmount);
  if (isAmountMap(policy.maxPerWeekAmount)) normalized.maxPerWeekAmount = normalizeAmountMap(policy.maxPerWeekAmount);
  if (isAmountMap(policy.maxPerMonthAmount)) normalized.maxPerMonthAmount = normalizeAmountMap(policy.maxPerMonthAmount);
  return normalized.maxLifetimeAmount || normalized.maxPerWeekAmount || normalized.maxPerMonthAmount
    ? normalized
    : undefined;
}

function recurringPolicyViolation(
  policy: RecurringPolicyConfig,
  schedule: RecurringScheduleRecord,
): { code: string; message: string } | null {
  const token = schedule.token.toUpperCase();
  const lifetime = policy.maxLifetimeAmount?.[token];
  const perWeek = policy.maxPerWeekAmount?.[token];
  const perMonth = policy.maxPerMonthAmount?.[token];
  if (!lifetime && !perWeek && !perMonth) return null;

  // For skill-monetization schedules with a platform split, the user actually
  // pays `metadata.totalAmount`, not `schedule.amount` (which holds only the
  // author portion). Evaluate caps against what the user actually spends.
  const estimate = lifetimeSpendEstimate(schedule, effectiveScheduleTotalAmount(schedule), new Date());
  if (lifetime && estimate.bounded && estimate.totalAmount && compareDecimal(estimate.totalAmount, lifetime) > 0) {
    return {
      code: 'recurring_exceeds_policy',
      message: `This schedule would spend up to ${estimate.totalAmount} ${token} total, exceeding your configured lifetime cap of ${lifetime} ${token}.`,
    };
  }
  if (perWeek && compareDecimal(estimate.perWeek, perWeek) > 0) {
    return {
      code: 'recurring_exceeds_policy',
      message: `This schedule would spend up to ${estimate.perWeek} ${token} per week, exceeding your configured cap of ${perWeek} ${token} per week.`,
    };
  }
  if (perMonth && compareDecimal(estimate.perMonth, perMonth) > 0) {
    return {
      code: 'recurring_exceeds_policy',
      message: `This schedule would spend up to ${estimate.perMonth} ${token} per month, exceeding your configured cap of ${perMonth} ${token} per month.`,
    };
  }
  return null;
}

function isAmountMap(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string' && entry.trim()),
  );
}

function normalizeAmountMap(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([token, amount]) => [token.toUpperCase(), amount.trim()]));
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  if (!a || !b) return 0;
  if (a.whole.length !== b.whole.length) return a.whole.length < b.whole.length ? -1 : 1;
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const fractionLength = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(fractionLength, '0');
  const bf = b.fraction.padEnd(fractionLength, '0');
  if (af === bf) return 0;
  return af < bf ? -1 : 1;
}

function decimalParts(value: string): { whole: string; fraction: string } | null {
  const match = /^0*(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    whole: match[1]!.replace(/^0+(?=\d)/, '') || '0',
    fraction: (match[2] ?? '').replace(/0+$/, ''),
  };
}
