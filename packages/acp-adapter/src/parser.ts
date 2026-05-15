import { CART_VERSION, CLUSTER_ALIASES, MAX_CART_BYTES } from './constants.js';
import { AcpParseError } from './errors.js';
import type {
  AcpCart,
  AcpCluster,
  AcpCurrency,
  AcpLineItem,
  AcpMerchant,
  AcpPaymentToken,
} from './types.js';

const SUPPORTED_CURRENCIES: readonly AcpCurrency[] = ['USD'];
const SUPPORTED_PAYMENT_TOKENS: readonly AcpPaymentToken[] = ['USDC', 'USDT'];

export interface ParseAcpCartOptions {
  readonly maxBytes?: number;
}

export function parseAcpCart(input: unknown, opts: ParseAcpCartOptions = {}, path = '$'): AcpCart {
  const raw = coerceInput(input, opts.maxBytes ?? MAX_CART_BYTES, path);
  const record = expectObject(raw, path);

  const id = expectString(record, 'id', path);
  const cartVersion = expectString(record, 'cartVersion', path);
  if (cartVersion !== CART_VERSION) {
    throw new AcpParseError(
      'unsupported_version',
      `Unsupported cartVersion. Expected "${CART_VERSION}".`,
      `${path}.cartVersion`,
    );
  }

  const merchant = parseMerchant(expectField(record, 'merchant', path), `${path}.merchant`);
  const lineItems = parseLineItems(expectField(record, 'lineItems', path), `${path}.lineItems`);
  const totalAmount = expectString(record, 'totalAmount', path);
  const currency = expectEnum(record, 'currency', SUPPORTED_CURRENCIES, path) as AcpCurrency;
  const paymentToken = expectEnum(record, 'paymentToken', SUPPORTED_PAYMENT_TOKENS, path) as AcpPaymentToken;
  const cluster = parseCluster(record, path);

  const expiresAt = optionalString(record, 'expiresAt', path);
  const memo = optionalString(record, 'memo', path);
  const paymentTokenMint = optionalString(record, 'paymentTokenMint', path);
  const metadata = optionalStringRecord(record, 'metadata', path);

  const cart: AcpCart = Object.freeze({
    id,
    cartVersion: CART_VERSION,
    merchant,
    lineItems,
    totalAmount,
    currency,
    paymentToken,
    cluster,
    ...(paymentTokenMint !== undefined ? { paymentTokenMint } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(memo !== undefined ? { memo } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
  return cart;
}

function coerceInput(input: unknown, maxBytes: number, path: string): unknown {
  if (typeof input !== 'string') return input;
  const byteLength = Buffer.byteLength(input, 'utf8');
  if (byteLength > maxBytes) {
    throw new AcpParseError(
      'invalid_size',
      `Cart JSON exceeds ${maxBytes} bytes (got ${byteLength}).`,
      path,
    );
  }
  try {
    return JSON.parse(input);
  } catch (err) {
    throw new AcpParseError(
      'invalid_json',
      `Expected valid JSON. ${err instanceof Error ? err.message : ''}`.trim(),
      path,
    );
  }
}

function parseCluster(record: Record<string, unknown>, path: string): AcpCluster {
  const raw = expectField(record, 'cluster', path);
  if (typeof raw !== 'string') {
    throw new AcpParseError('invalid_string', 'Expected a string.', `${path}.cluster`);
  }
  const normalized = CLUSTER_ALIASES[raw];
  if (!normalized) {
    throw new AcpParseError(
      'invalid_enum',
      `Expected one of: ${Object.keys(CLUSTER_ALIASES).join(', ')}.`,
      `${path}.cluster`,
    );
  }
  return normalized;
}

function parseMerchant(raw: unknown, path: string): AcpMerchant {
  const record = expectObject(raw, path);
  return Object.freeze({
    id: expectString(record, 'id', path),
    name: expectString(record, 'name', path),
    recipient: expectString(record, 'recipient', path),
  });
}

function parseLineItems(raw: unknown, path: string): readonly AcpLineItem[] {
  if (!Array.isArray(raw)) {
    throw new AcpParseError('invalid_array', 'Expected an array.', path);
  }
  const items = raw.map((entry, index) => parseLineItem(entry, `${path}[${index}]`));
  return Object.freeze(items);
}

function parseLineItem(raw: unknown, path: string): AcpLineItem {
  const record = expectObject(raw, path);
  const quantity = expectNumber(record, 'quantity', path);
  if (!Number.isInteger(quantity)) {
    throw new AcpParseError('invalid_number', 'Expected an integer.', `${path}.quantity`);
  }
  const currency = expectEnum(record, 'currency', SUPPORTED_CURRENCIES, path) as AcpCurrency;
  return Object.freeze({
    id: expectString(record, 'id', path),
    name: expectString(record, 'name', path),
    quantity,
    unitAmount: expectString(record, 'unitAmount', path),
    currency,
  });
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcpParseError('invalid_object', 'Expected a JSON object.', path);
  }
  return value as Record<string, unknown>;
}

function expectField(record: Record<string, unknown>, key: string, path: string): unknown {
  if (record[key] === undefined) {
    throw new AcpParseError('missing_field', 'Missing required field.', `${path}.${key}`);
  }
  return record[key];
}

function expectString(record: Record<string, unknown>, key: string, path: string): string {
  const value = expectField(record, key, path);
  if (typeof value !== 'string') {
    throw new AcpParseError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  if (!value) {
    throw new AcpParseError('missing_field', 'Expected a non-empty string.', `${path}.${key}`);
  }
  return value;
}

function expectNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = expectField(record, key, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AcpParseError('invalid_number', 'Expected a finite number.', `${path}.${key}`);
  }
  return value;
}

function expectEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
  path: string,
): T[number] {
  const value = expectString(record, key, path);
  if (!values.includes(value as T[number])) {
    throw new AcpParseError(
      'invalid_enum',
      `Expected one of: ${values.join(', ')}.`,
      `${path}.${key}`,
    );
  }
  return value as T[number];
}

function optionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AcpParseError('invalid_string', 'Expected a string.', `${path}.${key}`);
  }
  return value;
}

function optionalStringRecord(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Readonly<Record<string, string>> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcpParseError('invalid_object', 'Expected a JSON object.', `${path}.${key}`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== 'string') {
      throw new AcpParseError(
        'invalid_string',
        'Expected a string.',
        `${path}.${key}.${entryKey}`,
      );
    }
    result[entryKey] = entryValue;
  }
  return Object.freeze(result);
}
