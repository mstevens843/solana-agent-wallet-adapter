import type {
  EvaluatorDecision,
  EvaluatorInput,
  EvaluatorSkipReason,
  JsonObject,
  JsonValue,
  SkillCaps,
} from './types.js';

const AMOUNT_KEYS = ['amount', 'amountSol', 'inputAmount', 'sourceAmount', 'totalAmount'] as const;
const TOKEN_KEYS = [
  'token',
  'inputToken',
  'outputToken',
  'inputMint',
  'outputMint',
  'sourceMint',
  'mint',
  'mintAddress',
] as const;
const RECIPIENT_KEYS = ['recipient', 'to', 'destinationAddress', 'destinationRecipient', 'recipientAddress'] as const;

export function evaluateCaps(input: EvaluatorInput): EvaluatorDecision {
  const { install, manifest, executionCount, totalExecutedAmount, now } = input;
  if (install.status !== 'active') return skip('not-active');

  const caps = install.caps;
  if (caps.expiresAt) {
    const expiresMs = Date.parse(caps.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) return skip('expired');
  }
  if (caps.maxExecutions !== undefined && executionCount >= caps.maxExecutions) {
    return skip('max-executions-reached');
  }
  if (caps.lifetimeMaxAmount && compareDecimalStrings(totalExecutedAmount, caps.lifetimeMaxAmount) >= 0) {
    return skip('lifetime-cap-reached');
  }

  const template = input.params ?? manifest.action.paramsTemplate;
  const tokens = extractTemplateTokens(template);
  if (tokens.length === 0 || tokens.some((token) => !isTokenAllowed(token, caps.allowlistedTokens))) {
    return skip('token-not-allowlisted');
  }
  const recipient = extractTemplateRecipient(template);
  if (!isRecipientAllowed(recipient, caps.allowlistedRecipients)) {
    return skip('recipient-not-allowlisted');
  }
  const amountDecision = extractStrictTemplateAmount(template);
  if (!amountDecision.ok) return skip(amountDecision.reason);
  const amount = amountDecision.amount;
  if (compareDecimalStrings(addDecimalStrings(totalExecutedAmount, amount), caps.lifetimeMaxAmount) > 0) {
    return skip('lifetime-cap-reached');
  }
  if (compareDecimalStrings(amount, caps.perRunMaxAmount) > 0) {
    return skip('per-run-cap-exceeded');
  }
  return { allowed: true };
}

export function extractTemplateAmount(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, AMOUNT_KEYS);
}

export function extractTemplateToken(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, TOKEN_KEYS);
}

function extractTemplateTokens(template: JsonObject | undefined): string[] {
  if (!template) return [];
  return collectStringFields(template, TOKEN_KEYS);
}

export function extractTemplateRecipient(template: JsonObject | undefined): string | undefined {
  return pickStringField(template, RECIPIENT_KEYS);
}

export function isTokenAllowed(token: string | undefined, allowlist: readonly string[]): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
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
  if (recipient.includes('{{')) return true;
  const needle = recipient.trim();
  if (!needle) return false;
  return allowlist.some((entry) => entry.trim() === needle);
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
  const left = normalizeDecimal(a);
  const right = normalizeDecimal(b);
  const fracWidth = Math.max(left.frac.length, right.frac.length);
  const leftInt = BigInt((left.negative ? '-' : '') + left.int + left.frac.padEnd(fracWidth, '0'));
  const rightInt = BigInt((right.negative ? '-' : '') + right.int + right.frac.padEnd(fracWidth, '0'));
  const sum = leftInt + rightInt;
  if (fracWidth === 0) return sum.toString();
  const negative = sum < 0n;
  const abs = (negative ? -sum : sum).toString().padStart(fracWidth + 1, '0');
  const intPart = abs.slice(0, abs.length - fracWidth);
  const fracPart = abs.slice(abs.length - fracWidth).replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
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
  const nested = collectStringFields(template, keys);
  if (nested[0]) return nested[0];
  return undefined;
}

function collectStringFields(template: JsonValue | undefined, keys: readonly string[]): string[] {
  if (template === undefined || template === null) return [];
  if (Array.isArray(template)) {
    return template.flatMap((entry) => collectStringFields(entry, keys));
  }
  if (typeof template !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(template)) {
    if (keys.includes(key) && typeof value === 'string' && value.trim()) {
      out.push(value.trim());
    }
    out.push(...collectStringFields(value, keys));
  }
  return out;
}

function extractStrictTemplateAmount(
  template: JsonObject | undefined,
): { ok: true; amount: string } | { ok: false; reason: EvaluatorSkipReason } {
  const values = collectFieldValues(template, AMOUNT_KEYS);
  if (values.length === 0) return { ok: false, reason: 'amount-missing' };
  if (values.length > 1) return { ok: false, reason: 'amount-ambiguous' };
  const raw = values[0];
  if (typeof raw !== 'string') return { ok: false, reason: 'amount-invalid' };
  const amount = raw.trim();
  if (!isNonNegativeDecimalString(amount)) return { ok: false, reason: 'amount-invalid' };
  return { ok: true, amount };
}

function collectFieldValues(template: JsonValue | undefined, keys: readonly string[]): JsonValue[] {
  if (template === undefined || template === null) return [];
  if (Array.isArray(template)) {
    return template.flatMap((entry) => collectFieldValues(entry, keys));
  }
  if (typeof template !== 'object') return [];
  const out: JsonValue[] = [];
  for (const [key, value] of Object.entries(template)) {
    if (keys.includes(key)) out.push(value as JsonValue);
    out.push(...collectFieldValues(value, keys));
  }
  return out;
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

function isNonNegativeDecimalString(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

function skip(reason: EvaluatorSkipReason): EvaluatorDecision {
  return { allowed: false, reason };
}

export type { SkillCaps };
