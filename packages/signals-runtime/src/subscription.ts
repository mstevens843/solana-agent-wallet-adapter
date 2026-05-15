import type { JsonObject, JsonValue } from '@solana-agent-wallet-adapter/workflow';

import type { SignalSubscriptionRecord, SignalSubscriptionUsage, SkipReason } from './types.js';

export type SubscriptionVerdict = { kind: 'active' } | { kind: 'skip'; reason: SkipReason };

export function evaluateSubscription(
  subscription: SignalSubscriptionRecord,
  nowIso: string,
  usage?: SignalSubscriptionUsage,
): SubscriptionVerdict {
  if (subscription.status === 'paused') return { kind: 'skip', reason: 'subscription_paused' };
  if (subscription.status === 'revoked') return { kind: 'skip', reason: 'subscription_revoked' };
  const expiresAt = subscription.caps.expiresAt;
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(nowIso)) {
    return { kind: 'skip', reason: 'subscription_expired' };
  }
  if (
    subscription.caps.maxExecutions !== undefined &&
    usage &&
    usage.executionCount >= subscription.caps.maxExecutions
  ) {
    return { kind: 'skip', reason: 'max_executions_reached' };
  }
  if (
    usage &&
    compareDecimalStrings(usage.lifetimeAmount, subscription.caps.lifetimeMaxAmount) >= 0
  ) {
    return { kind: 'skip', reason: 'lifetime_cap_exhausted' };
  }
  return { kind: 'active' };
}

const AMOUNT_KEYS = ['amount', 'amountSol', 'inputAmount'] as const;
const TOKEN_KEYS = ['token', 'inputToken', 'mint'] as const;
const RECIPIENT_KEYS = ['recipient', 'to'] as const;

export function extractTemplateAmount(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, AMOUNT_KEYS);
}

export function extractTemplateToken(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, TOKEN_KEYS);
}

export function extractTemplateRecipient(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, RECIPIENT_KEYS);
}

export function isTokenAllowed(token: string | undefined, allowlist: readonly string[]): boolean {
  if (!token) return false;
  const needle = token.trim().toUpperCase();
  if (!needle) return false;
  return allowlist.some((entry) => entry.trim().toUpperCase() === needle);
}

export function isRecipientAllowed(
  recipient: string | undefined,
  allowlist: readonly string[] | undefined,
): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  if (!recipient) return false;
  const needle = recipient.trim();
  if (!needle) return false;
  return allowlist.some((entry) => entry.trim() === needle);
}

export function clampAmount(value: string, perRunMax: string): string {
  return compareDecimalStrings(value, perRunMax) > 0 ? perRunMax : value;
}

export function clampToSubscriptionCaps(
  value: string,
  subscription: SignalSubscriptionRecord,
  usage?: SignalSubscriptionUsage,
): string {
  let clamped = clampAmount(value, subscription.caps.perRunMaxAmount);
  if (usage) {
    const remaining = subtractDecimalStrings(subscription.caps.lifetimeMaxAmount, usage.lifetimeAmount);
    clamped = clampAmount(clamped, remaining);
  }
  return clamped;
}

export function overrideTemplateAmount(
  template: JsonObject,
  clamped: string,
): { template: JsonObject; key: string } {
  for (const key of AMOUNT_KEYS) {
    if (typeof template[key] === 'string') {
      return { template: { ...template, [key]: clamped }, key };
    }
  }
  return { template: { ...template, amount: clamped }, key: 'amount' };
}

function pickStringField(
  template: JsonObject | undefined,
  keys: readonly string[],
): string | undefined {
  if (!template) return undefined;
  for (const key of keys) {
    const value: JsonValue | undefined = template[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function compareDecimalStrings(a: string, b: string): number {
  const left = normalizeDecimal(a);
  const right = normalizeDecimal(b);
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const sign = left.negative ? -1 : 1;
  const fracWidth = Math.max(left.frac.length, right.frac.length);
  const leftInt = BigInt(left.int + left.frac.padEnd(fracWidth, '0'));
  const rightInt = BigInt(right.int + right.frac.padEnd(fracWidth, '0'));
  if (leftInt === rightInt) return 0;
  return leftInt > rightInt ? sign : -sign;
}

export function addDecimalStrings(a: string, b: string): string {
  const width = decimalScale(a, b);
  return formatScaledDecimal(toScaledDecimal(a, width) + toScaledDecimal(b, width), width);
}

export function subtractDecimalStrings(a: string, b: string): string {
  if (compareDecimalStrings(a, b) < 0) {
    throw new Error(`Cannot subtract ${b} from ${a}.`);
  }
  const width = decimalScale(a, b);
  return formatScaledDecimal(toScaledDecimal(a, width) - toScaledDecimal(b, width), width);
}

function normalizeDecimal(value: string): { negative: boolean; int: string; frac: string } {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal string: ${value}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const int = (intPart ?? '').replace(/^0+(?=\d)/, '') || '0';
  return { negative, int, frac: fracPart };
}

function decimalScale(a: string, b: string): number {
  return Math.max(normalizeDecimal(a).frac.length, normalizeDecimal(b).frac.length);
}

function toScaledDecimal(value: string, width: number): bigint {
  const normalized = normalizeDecimal(value);
  if (normalized.negative) {
    throw new Error(`Expected a non-negative decimal string: ${value}`);
  }
  return BigInt(normalized.int + normalized.frac.padEnd(width, '0'));
}

function formatScaledDecimal(value: bigint, width: number): string {
  if (value < 0n) {
    throw new Error('Expected a non-negative decimal value.');
  }
  if (width === 0) return value.toString();
  const scale = 10n ** BigInt(width);
  const intPart = value / scale;
  const fracPart = (value % scale).toString().padStart(width, '0').replace(/0+$/, '');
  return fracPart ? `${intPart.toString()}.${fracPart}` : intPart.toString();
}
