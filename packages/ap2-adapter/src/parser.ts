import {
  Ap2ParseError,
  type Ap2Cluster,
  type Ap2IntentDetails,
  type Ap2IntentMandate,
  type Ap2Mandate,
  type Ap2MandateType,
  type Ap2PaymentDetails,
  type Ap2PaymentMandate,
  type Ap2VerifiedAgent,
  type JsonObject,
  type JsonValue,
} from './types.js';

const AP2_CLUSTERS: readonly Ap2Cluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];
const MANDATE_TYPES: readonly Ap2MandateType[] = ['intent_mandate', 'payment_mandate'];
const AMOUNT_PATTERN = /^\d+(\.\d{1,18})?$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DEFAULT_MAX_BYTES = 64 * 1024;

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

export function parseAp2Mandate(raw: string | unknown, opts: { maxBytes?: number } = {}): Ap2Mandate {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let value: unknown;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new Ap2ParseError('mandate_too_large', `mandate exceeds ${maxBytes} bytes.`, '$');
    }
    try {
      value = JSON.parse(raw);
    } catch (err) {
      throw new Ap2ParseError('invalid_json', `mandate is not valid JSON: ${(err as Error).message}`, '$');
    }
  } else {
    value = raw;
  }

  assertNoForbiddenAp2Secrets(value, '$');
  const object = requireObject(value, '$');
  const mandateType = requireStringEnum(object, 'mandateType', MANDATE_TYPES, '$');

  if (mandateType === 'intent_mandate') {
    return parseIntentMandate(object);
  }
  return parsePaymentMandate(object);
}

export function assertNoForbiddenAp2Secrets(value: unknown, path = '$'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenAp2Secrets(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_KEY_TOKENS.has(normalized) || normalized.includes('privatekey') || normalized.includes('secretkey')) {
      throw new Ap2ParseError('forbidden_secret', `${path}.${key} is not accepted by AP2 inbound mandates.`, `${path}.${key}`);
    }
    assertNoForbiddenAp2Secrets(entry, `${path}.${key}`);
  }
}

interface Ap2MandateCommonParsed {
  mandateId: string;
  protocolVersion: string;
  issuedAt: string;
  expiresAt: string;
  agent: Ap2VerifiedAgent;
  signature: string;
  signedFields: JsonObject;
}

function parseIntentMandate(object: Record<string, unknown>): Ap2IntentMandate {
  const common = parseCommonFields(object, 'intent_mandate');
  const rawIntent = requireObjectField(object, 'intent', '$');
  const intent = parseIntentDetails(rawIntent, '$.intent');
  assertSignedSubtreeMirror(common.signedFields, 'intent', coerceJsonObject(rawIntent, '$.intent'));
  return {
    ...common,
    mandateType: 'intent_mandate',
    intent,
  };
}

function parsePaymentMandate(object: Record<string, unknown>): Ap2PaymentMandate {
  const common = parseCommonFields(object, 'payment_mandate');
  const intentMandateId = requireString(object, 'intentMandateId', '$');
  if (common.signedFields.intentMandateId !== intentMandateId) {
    throw new Ap2ParseError(
      'signed_fields_mismatch',
      'signedFields.intentMandateId must mirror top-level intentMandateId.',
      '$.signedFields.intentMandateId',
    );
  }
  const rawPayment = requireObjectField(object, 'payment', '$');
  const payment = parsePaymentDetails(rawPayment, '$.payment');
  assertSignedSubtreeMirror(common.signedFields, 'payment', coerceJsonObject(rawPayment, '$.payment'));
  return {
    ...common,
    mandateType: 'payment_mandate',
    intentMandateId,
    payment,
  };
}

function assertSignedSubtreeMirror(signedFields: JsonObject, key: string, expected: JsonObject): void {
  const signed = signedFields[key];
  if (signed === undefined) {
    throw new Ap2ParseError(
      'signed_fields_mismatch',
      `signedFields.${key} is required.`,
      `$.signedFields.${key}`,
    );
  }
  if (!isJsonObjectValue(signed) || !deepJsonEqual(signed, expected)) {
    throw new Ap2ParseError(
      'signed_fields_mismatch',
      `signedFields.${key} must mirror top-level ${key}.`,
      `$.signedFields.${key}`,
    );
  }
}

function isJsonObjectValue(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepJsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepJsonEqual(a[i] as JsonValue, b[i] as JsonValue)) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
    }
    for (const key of aKeys) {
      if (!deepJsonEqual((a as JsonObject)[key] as JsonValue, (b as JsonObject)[key] as JsonValue)) return false;
    }
    return true;
  }
  return false;
}

function parseCommonFields(object: Record<string, unknown>, mandateType: Ap2MandateType): Ap2MandateCommonParsed {
  const mandateId = requireString(object, 'mandateId', '$');
  const protocolVersion = requireString(object, 'protocolVersion', '$');
  const issuedAt = requireIsoDate(object, 'issuedAt', '$');
  const expiresAt = requireIsoDate(object, 'expiresAt', '$');
  const agent = parseAgent(requireObjectField(object, 'agent', '$'), '$.agent');
  const signature = requireBase58(object, 'signature', '$');
  const signedFields = requireJsonObject(requireObjectField(object, 'signedFields', '$'), '$.signedFields');
  assertSignedFieldsMirror(signedFields, { mandateId, mandateType, protocolVersion, issuedAt, expiresAt });
  return {
    mandateId,
    protocolVersion,
    issuedAt,
    expiresAt,
    agent,
    signature,
    signedFields,
  };
}

function assertSignedFieldsMirror(
  signedFields: JsonObject,
  mandate: { mandateId: string; mandateType: Ap2MandateType; protocolVersion: string; issuedAt: string; expiresAt: string },
): void {
  for (const key of ['mandateId', 'mandateType', 'protocolVersion', 'issuedAt', 'expiresAt'] as const) {
    if (signedFields[key] !== mandate[key]) {
      throw new Ap2ParseError(
        'signed_fields_mismatch',
        `signedFields.${key} must mirror top-level ${key}.`,
        `$.signedFields.${key}`,
      );
    }
  }
}

function parseAgent(object: Record<string, unknown>, path: string): Ap2VerifiedAgent {
  return {
    agentId: requireString(object, 'agentId', path),
    agentLabel: requireString(object, 'agentLabel', path),
    publicKey: requireBase58(object, 'publicKey', path),
  };
}

function parsePaymentDetails(object: Record<string, unknown>, path: string): Ap2PaymentDetails {
  const amount = requireString(object, 'amount', path);
  if (!AMOUNT_PATTERN.test(amount)) {
    throw new Ap2ParseError('invalid_field', `${path}.amount must be a non-negative decimal string.`, `${path}.amount`);
  }
  const cluster = requireStringEnum(object, 'cluster', AP2_CLUSTERS, path);
  const tokenSymbol = requireString(object, 'tokenSymbol', path);
  const tokenMint = requireBase58(object, 'tokenMint', path);
  const recipient = requireBase58(object, 'recipient', path);
  const memo = optionalString(object, 'memo', path);
  return {
    amount,
    tokenSymbol,
    tokenMint,
    recipient,
    cluster,
    ...(memo === undefined ? {} : { memo }),
  };
}

function parseIntentDetails(object: Record<string, unknown>, path: string): Ap2IntentDetails {
  const description = requireString(object, 'description', path);
  const cap = parsePaymentDetails(requireObjectField(object, 'cap', path), `${path}.cap`);
  const maxRunsRaw = object.maxRuns;
  let maxRuns: number | undefined;
  if (maxRunsRaw !== undefined && maxRunsRaw !== null) {
    if (typeof maxRunsRaw !== 'number' || !Number.isFinite(maxRunsRaw) || !Number.isInteger(maxRunsRaw) || maxRunsRaw < 1) {
      throw new Ap2ParseError('invalid_field', `${path}.maxRuns must be a positive integer.`, `${path}.maxRuns`);
    }
    maxRuns = maxRunsRaw;
  }
  return {
    description,
    cap,
    ...(maxRuns === undefined ? {} : { maxRuns }),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Ap2ParseError('invalid_field', `${path} must be a JSON object.`, path);
  }
  return value;
}

function requireObjectField(object: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new Ap2ParseError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  return requireObject(value, `${path}.${key}`);
}

function requireJsonObject(object: Record<string, unknown>, path: string): JsonObject {
  return coerceJsonObject(object, path);
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new Ap2ParseError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  if (typeof value !== 'string') {
    throw new Ap2ParseError('invalid_field', `${path}.${key} must be a string.`, `${path}.${key}`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Ap2ParseError('invalid_field', `${path}.${key} must be a non-empty string.`, `${path}.${key}`);
  }
  return trimmed;
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Ap2ParseError('invalid_field', `${path}.${key} must be a string.`, `${path}.${key}`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function requireStringEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
): T {
  const raw = requireString(object, key, path);
  if (!values.includes(raw as T)) {
    throw new Ap2ParseError(
      'invalid_field',
      `${path}.${key} must be one of: ${values.join(', ')}.`,
      `${path}.${key}`,
    );
  }
  return raw as T;
}

function requireIsoDate(object: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(object, key, path);
  if (!ISO_DATE_PATTERN.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Ap2ParseError('invalid_field', `${path}.${key} must be a valid ISO-8601 timestamp.`, `${path}.${key}`);
  }
  return value;
}

function requireBase58(object: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(object, key, path);
  if (!BASE58_PATTERN.test(value)) {
    throw new Ap2ParseError('invalid_field', `${path}.${key} must be a base58 string.`, `${path}.${key}`);
  }
  return value;
}

function coerceJsonObject(value: unknown, path: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Ap2ParseError('invalid_field', `${path} must be a JSON object.`, path);
  }
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = coerceJsonValue(entry, `${path}.${key}`);
  }
  return output;
}

function coerceJsonValue(value: unknown, path: string): JsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Ap2ParseError('invalid_field', `${path} must be a finite number.`, path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => coerceJsonValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return coerceJsonObject(value, path);
  }
  throw new Ap2ParseError('invalid_field', `${path} must be JSON serializable.`, path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
