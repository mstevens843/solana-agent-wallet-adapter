import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { lifetimeSpendEstimate, type RecurringScheduleRecord } from '@solana-agent-wallet-adapter/workflow';

import type { RecurringPolicyEnforcer } from './recurringService.js';

export interface RecurringPolicyConfig {
  maxLifetimeAmount?: Record<string, string>;
  maxPerWeekAmount?: Record<string, string>;
  maxPerMonthAmount?: Record<string, string>;
}

export function loadRecurringPolicyFromEnv(): RecurringPolicyConfig | undefined {
  const configPath = process.env.AGENTIC_RECURRING_CONFIG ?? process.env.AGENT_WALLET_CONFIG;
  const candidates = configPath ? [configPath] : ['agent-wallet.config.json'];
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

  const estimate = lifetimeSpendEstimate(schedule, schedule.amount, new Date());
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
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
