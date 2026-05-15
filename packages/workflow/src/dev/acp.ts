import { WorkflowValidationError, assertNoForbiddenWorkflowSecrets } from '../index.js';

export interface CreateAcpCartRequest {
  cart: Record<string, unknown>;
  cluster?: 'mainnet' | 'devnet';
  note?: string;
  dueAt?: string;
}

export interface AcpReceiptIssuanceRequest {
  cartId: string;
  txid: string;
  settledAt?: string;
  walletAddress: string;
}

export function validateCreateAcpCartRequest(body: unknown, path = '$'): CreateAcpCartRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const record = expectObject(body, path);
  if (record.cart === undefined) {
    throw new WorkflowValidationError('missing_field', 'Missing required field.', `${path}.cart`);
  }
  const cart = expectCartObject(record.cart, `${path}.cart`);
  assertNoForbiddenWorkflowSecrets(cart, `${path}.cart`);
  return {
    cart,
    ...(record.cluster !== undefined ? { cluster: expectCluster(record.cluster, `${path}.cluster`) } : {}),
    ...(record.note !== undefined ? { note: expectShortString(record.note, `${path}.note`, 500) } : {}),
    ...(record.dueAt !== undefined ? { dueAt: expectIsoString(record.dueAt, `${path}.dueAt`) } : {}),
  };
}

function expectCartObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new WorkflowValidationError('invalid_json', 'cart string must be valid JSON.', path);
    }
    return expectObject(parsed, path);
  }
  return expectObject(value, path);
}

export function validateAcpReceiptIssuanceRequest(body: unknown, path = '$'): AcpReceiptIssuanceRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const record = expectObject(body, path);
  return {
    cartId: expectShortString(record.cartId, `${path}.cartId`, 128),
    txid: expectShortString(record.txid, `${path}.txid`, 256),
    walletAddress: expectShortString(record.walletAddress, `${path}.walletAddress`, 64),
    ...(record.settledAt !== undefined ? { settledAt: expectIsoString(record.settledAt, `${path}.settledAt`) } : {}),
  };
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError('invalid_object', 'Expected a JSON object.', path);
  }
  return value as Record<string, unknown>;
}

function expectShortString(value: unknown, path: string, max: number): string {
  if (value === undefined) {
    throw new WorkflowValidationError('missing_field', 'Missing required field.', path);
  }
  if (typeof value !== 'string') {
    throw new WorkflowValidationError('invalid_string', 'Expected a string.', path);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WorkflowValidationError('missing_field', 'Expected a non-empty string.', path);
  }
  if (trimmed.length > max) {
    throw new WorkflowValidationError('field_too_long', `Field must be ≤ ${max} characters.`, path);
  }
  return trimmed;
}

function expectCluster(value: unknown, path: string): 'mainnet' | 'devnet' {
  if (value !== 'mainnet' && value !== 'devnet') {
    throw new WorkflowValidationError('invalid_enum', 'Expected one of: mainnet, devnet.', path);
  }
  return value;
}

function expectIsoString(value: unknown, path: string): string {
  const s = expectShortString(value, path, 64);
  if (Number.isNaN(Date.parse(s))) {
    throw new WorkflowValidationError('invalid_timestamp', 'Expected an ISO-8601 timestamp.', path);
  }
  return s;
}
