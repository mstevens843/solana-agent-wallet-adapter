import {
  WORKFLOW_CLUSTERS,
  WorkflowValidationError,
  assertNoForbiddenWorkflowSecrets,
  type WorkflowCluster,
} from '../index.js';
import {
  AcpParseError,
  parseAcpCart,
  type AcpCart,
} from '@solana-agent-wallet-adapter/acp-adapter';

export interface CreateAcpCartRequest {
  cart: AcpCart;
  cluster?: WorkflowCluster;
  note?: string;
  dueAt?: string;
  receivedAt: string;
}

export interface AcpReceiptIssuanceRequest {
  cartId: string;
  txid: string;
  walletAddress: string;
  settledAt?: string;
  receivedAt: string;
}

export function validateCreateAcpCartRequest(body: unknown, path = '$'): CreateAcpCartRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const record = expectObject(body, path);
  if (record.cart === undefined) {
    throw new WorkflowValidationError('missing_field', 'Missing required field.', `${path}.cart`);
  }

  // When `cart` arrives as a JSON string, pre-parse it so the secret scan
  // can descend into the embedded fields BEFORE parseAcpCart drops unknown
  // keys (the parser only retains its declared shape; a smuggled
  // `delegatedSigner` would otherwise be silently scrubbed).
  let rawCart: unknown = record.cart;
  if (typeof rawCart === 'string') {
    try {
      rawCart = JSON.parse(rawCart);
    } catch {
      // Leave as string; parseAcpCart below will raise the proper
      // AcpParseError('invalid_json') which we wrap.
    }
  }
  assertNoForbiddenWorkflowSecrets(rawCart, `${path}.cart`);

  let cart: AcpCart;
  try {
    cart = parseAcpCart(rawCart, {}, `${path}.cart`);
  } catch (err) {
    if (err instanceof AcpParseError) {
      throw new WorkflowValidationError(
        `invalid_acp_cart:${err.code}`,
        err.message,
        err.path ?? `${path}.cart`,
      );
    }
    throw new WorkflowValidationError(
      'invalid_acp_cart',
      (err as Error).message ?? 'ACP cart could not be parsed.',
      `${path}.cart`,
    );
  }

  return {
    cart,
    ...(record.cluster !== undefined ? { cluster: expectCluster(record.cluster, `${path}.cluster`) } : {}),
    ...(record.note !== undefined ? { note: expectShortString(record.note, `${path}.note`, 500) } : {}),
    ...(record.dueAt !== undefined ? { dueAt: expectIsoString(record.dueAt, `${path}.dueAt`) } : {}),
    receivedAt: new Date().toISOString(),
  };
}

export function validateAcpReceiptIssuanceRequest(body: unknown, path = '$'): AcpReceiptIssuanceRequest {
  assertNoForbiddenWorkflowSecrets(body, path);
  const record = expectObject(body, path);
  return {
    cartId: expectShortString(record.cartId, `${path}.cartId`, 128),
    txid: expectShortString(record.txid, `${path}.txid`, 256),
    walletAddress: expectShortString(record.walletAddress, `${path}.walletAddress`, 64),
    ...(record.settledAt !== undefined ? { settledAt: expectIsoString(record.settledAt, `${path}.settledAt`) } : {}),
    receivedAt: new Date().toISOString(),
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

function expectCluster(value: unknown, path: string): WorkflowCluster {
  if (typeof value !== 'string' || !(WORKFLOW_CLUSTERS as readonly string[]).includes(value)) {
    throw new WorkflowValidationError(
      'invalid_enum',
      `Expected one of: ${WORKFLOW_CLUSTERS.join(', ')}.`,
      path,
    );
  }
  return value as WorkflowCluster;
}

function expectIsoString(value: unknown, path: string): string {
  const s = expectShortString(value, path, 64);
  if (Number.isNaN(Date.parse(s))) {
    throw new WorkflowValidationError('invalid_timestamp', 'Expected an ISO-8601 timestamp.', path);
  }
  return s;
}
