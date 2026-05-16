import { MppParseError } from './errors.js';
import {
  MPP_PROTOCOL_VERSION,
  type JsonObject,
  type JsonValue,
  type MppChallenge,
  type MppCluster,
  type MppMerchant,
  type MppPaymentMethod,
  type MppPaymentRail,
} from './types.js';

export interface ParseMppChallengeOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const AMOUNT_PATTERN = /^\d+(\.\d{1,18})?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const MPP_CLUSTERS: readonly MppCluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];
const PAYMENT_RAILS: readonly MppPaymentRail[] = ['solana-sol', 'solana-spl'];

const FORBIDDEN_KEY_TOKENS = new Set([
  'seedphrase',
  'recoveryphrase',
  'mnemonic',
  'privatekey',
  'secretkey',
  'delegatedsigner',
  'delegatesigner',
  'unlimitedapproval',
]);

/**
 * Parse + structurally validate an MPP HTTP-402 payment challenge.
 *
 * This performs JSON validation and local safety checks only. Call
 * `verifyMppChallenge` afterwards to enforce expiry, rail support, amount caps,
 * cluster expectations, and mint allowlists.
 */
export function parseMppChallenge(raw: string | unknown, opts: ParseMppChallengeOptions = {}): MppChallenge {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let value: unknown;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new MppParseError('oversize_payload', `challenge exceeds ${maxBytes} bytes.`, '$');
    }
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new MppParseError('invalid_json', `challenge is not valid JSON: ${(err as Error).message}`, '$');
    }
  } else {
    value = raw;
  }

  assertNoForbiddenMppSecrets(value, '$');
  const object = requireObject(value, '$');
  const protocolVersion = requireString(object, 'protocolVersion', '$');
  const nonce = requireString(object, 'nonce', '$');
  const amount = requireAmount(object, 'amount', '$');
  const currency = requireString(object, 'currency', '$');
  const resourceUrl = requireHttpUrl(object, 'resourceUrl', '$');
  const expiresAt = requireIsoDate(object, 'expiresAt', '$');
  const paymentMethods = parsePaymentMethods(requireArray(object, 'paymentMethods', '$'), '$.paymentMethods');
  const merchant = optionalMerchant(object.merchant, '$.merchant');
  const metadata = optionalJsonObject(object.metadata, '$.metadata');

  return {
    protocolVersion,
    nonce,
    amount,
    currency,
    resourceUrl,
    expiresAt,
    paymentMethods,
    ...(merchant ? { merchant } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function assertNoForbiddenMppSecrets(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenMppSecrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_KEY_TOKENS.has(normalized) || normalized.includes('privatekey') || normalized.includes('secretkey')) {
      throw new MppParseError('forbidden_secret', `${path}.${key} is not accepted by MPP challenges.`, `${path}.${key}`);
    }
    assertNoForbiddenMppSecrets(entry, `${path}.${key}`);
  }
}

function parsePaymentMethods(values: unknown[], path: string): MppPaymentMethod[] {
  if (values.length === 0) {
    throw new MppParseError('missing_field', `${path} must include at least one payment method.`, path);
  }
  if (values.length > 16) {
    throw new MppParseError('invalid_field', `${path} must include at most 16 payment methods.`, path);
  }
  return values.map((value, index) => parsePaymentMethod(requireObject(value, `${path}[${index}]`), `${path}[${index}]`));
}

function parsePaymentMethod(object: Record<string, unknown>, path: string): MppPaymentMethod {
  const kind = requireStringEnum(object, 'kind', PAYMENT_RAILS, path);
  const recipient = requireBase58String(object, 'recipient', path);
  const network = requireStringEnum(object, 'network', MPP_CLUSTERS, path);
  const mint = optionalBase58String(object, 'mint', path);
  if (kind === 'solana-spl' && !mint) {
    throw new MppParseError('missing_field', `${path}.mint is required for solana-spl payment methods.`, `${path}.mint`);
  }
  return {
    kind,
    recipient,
    network,
    ...(mint ? { mint } : {}),
  };
}

function optionalMerchant(value: unknown, path: string): MppMerchant | undefined {
  if (value === undefined || value === null) return undefined;
  const object = requireObject(value, path);
  const merchant: MppMerchant = {};
  const id = optionalString(object, 'id', path);
  const name = optionalString(object, 'name', path);
  const url = optionalHttpUrl(object, 'url', path);
  if (id) merchant.id = id;
  if (name) merchant.name = name;
  if (url) merchant.url = url;
  return Object.keys(merchant).length > 0 ? merchant : undefined;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new MppParseError('invalid_schema', `${path} must be a JSON object.`, path);
  }
  return value;
}

function requireArray(object: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new MppParseError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  if (!Array.isArray(value)) {
    throw new MppParseError('invalid_field', `${path}.${key} must be an array.`, `${path}.${key}`);
  }
  return value;
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new MppParseError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MppParseError('invalid_field', `${path}.${key} must be a non-empty string.`, `${path}.${key}`);
  }
  return value.trim();
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MppParseError('invalid_field', `${path}.${key} must be a string.`, `${path}.${key}`);
  }
  return value.trim();
}

function requireAmount(object: Record<string, unknown>, key: string, path: string): string {
  const amount = requireString(object, key, path);
  if (!AMOUNT_PATTERN.test(amount) || compareDecimalStrings(amount, '0') <= 0) {
    throw new MppParseError('invalid_field', `${path}.${key} must be a positive decimal string.`, `${path}.${key}`);
  }
  return amount;
}

function requireIsoDate(object: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(object, key, path);
  if (!ISO_DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new MppParseError('invalid_field', `${path}.${key} must be an ISO-8601 timestamp.`, `${path}.${key}`);
  }
  return value;
}

function requireStringEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
): T {
  const raw = requireString(object, key, path);
  if (!values.includes(raw as T)) {
    throw new MppParseError('invalid_field', `${path}.${key} must be one of: ${values.join(', ')}.`, `${path}.${key}`);
  }
  return raw as T;
}

function requireBase58String(object: Record<string, unknown>, key: string, path: string): string {
  const raw = requireString(object, key, path);
  assertBase58(raw, `${path}.${key}`);
  return raw;
}

function optionalBase58String(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const raw = optionalString(object, key, path);
  if (raw === undefined) return undefined;
  assertBase58(raw, `${path}.${key}`);
  return raw;
}

function assertBase58(raw: string, path: string): void {
  if (!BASE58_PATTERN.test(raw) || raw.length < 32 || raw.length > 64) {
    throw new MppParseError('invalid_field', `${path} must be a base58 Solana address or mint.`, path);
  }
}

function requireHttpUrl(object: Record<string, unknown>, key: string, path: string): string {
  const raw = requireString(object, key, path);
  assertHttpUrl(raw, `${path}.${key}`);
  return raw;
}

function optionalHttpUrl(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const raw = optionalString(object, key, path);
  if (raw === undefined) return undefined;
  assertHttpUrl(raw, `${path}.${key}`);
  return raw;
}

function assertHttpUrl(raw: string, path: string): void {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
  } catch {
    throw new MppParseError('invalid_field', `${path} must be a valid http(s) URL.`, path);
  }
}

function optionalJsonObject(value: unknown, path: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new MppParseError('invalid_field', `${path} must be a JSON object.`, path);
  }
  return coerceJsonObject(value, path);
}

function coerceJsonObject(value: Record<string, unknown>, path: string): JsonObject {
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = coerceJsonValue(entry, `${path}.${key}`);
  }
  return out;
}

function coerceJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MppParseError('invalid_field', `${path} must not be NaN or Infinity.`, path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => coerceJsonValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return coerceJsonObject(value, path);
  }
  throw new MppParseError('invalid_field', `${path} must be JSON-serializable.`, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareDecimalStrings(left: string, right: string): number {
  const [leftIntRaw = '0', leftFracRaw = ''] = left.split('.');
  const [rightIntRaw = '0', rightFracRaw = ''] = right.split('.');
  const leftInt = leftIntRaw.replace(/^0+(?=\d)/, '');
  const rightInt = rightIntRaw.replace(/^0+(?=\d)/, '');
  if (leftInt.length !== rightInt.length) return leftInt.length > rightInt.length ? 1 : -1;
  const intCompare = leftInt.localeCompare(rightInt);
  if (intCompare !== 0) return intCompare > 0 ? 1 : -1;
  const maxFrac = Math.max(leftFracRaw.length, rightFracRaw.length);
  const leftFrac = leftFracRaw.padEnd(maxFrac, '0');
  const rightFrac = rightFracRaw.padEnd(maxFrac, '0');
  const fracCompare = leftFrac.localeCompare(rightFrac);
  return fracCompare === 0 ? 0 : fracCompare > 0 ? 1 : -1;
}

export const __mppParserInternalsForTests = {
  compareDecimalStrings,
  expectedProtocolVersion: MPP_PROTOCOL_VERSION,
};
