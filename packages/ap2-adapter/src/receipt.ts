import { canonicalJsonSha256 } from './verifier.js';
import {
  AP2_INBOUND_RECEIPT_SCHEMA,
  Ap2ParseError,
  type Ap2ApprovalKind,
  type Ap2Cluster,
  type Ap2InboundReceipt,
  type Ap2InboundReceiptApprovalRef,
  type Ap2InboundReceiptExecution,
  type Ap2Mandate,
  type Ap2MandateType,
  type Ap2PaymentDetails,
  type Ap2VerifiedAgent,
  type JsonValue,
} from './types.js';
import { paymentDetailsFor } from './verifier.js';

const HEX_64 = /^[a-f0-9]{64}$/;
const MANDATE_TYPES: readonly Ap2MandateType[] = ['intent_mandate', 'payment_mandate'];
const APPROVAL_KINDS: readonly Ap2ApprovalKind[] = ['transfer_sol', 'transfer_spl'];
const CLUSTERS: readonly Ap2Cluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];

export interface BuildAp2InboundReceiptInput {
  mandate: Ap2Mandate;
  agent: Ap2VerifiedAgent;
  approval: { id: string; kind: Ap2ApprovalKind };
  txid: string;
  walletAddress: string;
  cluster: Ap2Cluster;
  finalizedAt?: string;
  issuedAt?: string;
}

/**
 * Build the AP2 inbound attestation JSON for an approved + settled mandate.
 * `artifactHash` is deterministic sha256 over the canonicalized receipt minus
 * the hash itself, so the same input always yields the same hash. Caller (the
 * route layer) hands the returned object to `EvidenceService.createReceipt`
 * with `kind: 'intent_receipt'`.
 */
export function buildAp2InboundReceipt(input: BuildAp2InboundReceiptInput): Ap2InboundReceipt {
  const payment = paymentDetailsFor(input.mandate);
  const issuedAt = input.issuedAt ?? input.finalizedAt ?? new Date().toISOString();
  const finalizedAt = input.finalizedAt ?? issuedAt;
  const draft: Omit<Ap2InboundReceipt, 'artifactHash'> = {
    schema: AP2_INBOUND_RECEIPT_SCHEMA,
    mandateId: input.mandate.mandateId,
    mandateType: input.mandate.mandateType,
    protocolVersion: input.mandate.protocolVersion,
    issuedAt,
    agent: {
      agentId: input.agent.agentId,
      agentLabel: input.agent.agentLabel,
      publicKey: input.agent.publicKey,
    },
    payment: {
      amount: payment.amount,
      tokenSymbol: payment.tokenSymbol,
      tokenMint: payment.tokenMint,
      recipient: payment.recipient,
      cluster: payment.cluster,
      ...(payment.memo === undefined ? {} : { memo: payment.memo }),
    },
    approval: { id: input.approval.id, kind: input.approval.kind },
    execution: {
      txid: input.txid,
      walletAddress: input.walletAddress,
      cluster: input.cluster,
      finalizedAt,
    },
  };
  const artifactHash = canonicalJsonSha256(draft as unknown as JsonValue);
  return { ...draft, artifactHash };
}

/**
 * Validate a persisted AP2 inbound receipt back into typed shape. Use this
 * when reading `approval.metadata.ap2InboundReceipt` (typed as `JsonValue`)
 * to recover an `Ap2InboundReceipt` without unsafe casts.
 *
 * Performs structural validation only — does NOT re-verify `artifactHash`.
 * Pair with `verifyAp2InboundReceiptHash` for tamper detection.
 *
 * Throws `Ap2ParseError` with codes prefixed `invalid_receipt:` on any
 * structural defect.
 */
export function parseAp2InboundReceipt(value: unknown): Ap2InboundReceipt {
  const root = requireObject(value, '$');
  const schema = requireString(root, 'schema', '$');
  if (schema !== AP2_INBOUND_RECEIPT_SCHEMA) {
    throw new Ap2ParseError(
      'invalid_receipt:schema_mismatch',
      `receipt.schema must equal "${AP2_INBOUND_RECEIPT_SCHEMA}"; got "${schema}".`,
      '$.schema',
    );
  }
  const mandateType = requireEnum(root, 'mandateType', MANDATE_TYPES, '$');
  const agent = parseAgent(requireField(root, 'agent', '$'), '$.agent');
  const payment = parsePayment(requireField(root, 'payment', '$'), '$.payment');
  const approval = parseApproval(requireField(root, 'approval', '$'), '$.approval');
  const execution = parseExecution(requireField(root, 'execution', '$'), '$.execution');
  const artifactHash = requireString(root, 'artifactHash', '$');
  if (!HEX_64.test(artifactHash)) {
    throw new Ap2ParseError(
      'invalid_receipt:bad_hash',
      'receipt.artifactHash must be a 64-character lowercase hex string.',
      '$.artifactHash',
    );
  }
  return {
    schema: AP2_INBOUND_RECEIPT_SCHEMA,
    mandateId: requireString(root, 'mandateId', '$'),
    mandateType,
    protocolVersion: requireString(root, 'protocolVersion', '$'),
    issuedAt: requireString(root, 'issuedAt', '$'),
    agent,
    payment,
    approval,
    execution,
    artifactHash,
  };
}

/**
 * Recompute the canonical sha256 hash of `receipt` (excluding `artifactHash`)
 * and compare to the stored value. Returns `true` if the receipt has not been
 * tampered with since `buildAp2InboundReceipt` produced it. Pure: no throw.
 */
export function verifyAp2InboundReceiptHash(receipt: Ap2InboundReceipt): boolean {
  const { artifactHash, ...rest } = receipt;
  const expected = canonicalJsonSha256(rest as unknown as JsonValue);
  return expected === artifactHash;
}

function parseAgent(value: Record<string, unknown>, path: string): Ap2VerifiedAgent {
  return {
    agentId: requireString(value, 'agentId', path),
    agentLabel: requireString(value, 'agentLabel', path),
    publicKey: requireString(value, 'publicKey', path),
  };
}

function parsePayment(value: Record<string, unknown>, path: string): Ap2PaymentDetails {
  const memoRaw = value.memo;
  let memo: string | undefined;
  if (memoRaw !== undefined && memoRaw !== null) {
    if (typeof memoRaw !== 'string') {
      throw new Ap2ParseError('invalid_receipt:bad_memo', `${path}.memo must be a string.`, `${path}.memo`);
    }
    memo = memoRaw;
  }
  return {
    amount: requireString(value, 'amount', path),
    tokenSymbol: requireString(value, 'tokenSymbol', path),
    tokenMint: requireString(value, 'tokenMint', path),
    recipient: requireString(value, 'recipient', path),
    cluster: requireEnum(value, 'cluster', CLUSTERS, path),
    ...(memo === undefined ? {} : { memo }),
  };
}

function parseApproval(value: Record<string, unknown>, path: string): Ap2InboundReceiptApprovalRef {
  return {
    id: requireString(value, 'id', path),
    kind: requireEnum(value, 'kind', APPROVAL_KINDS, path),
  };
}

function parseExecution(value: Record<string, unknown>, path: string): Ap2InboundReceiptExecution {
  return {
    txid: requireString(value, 'txid', path),
    walletAddress: requireString(value, 'walletAddress', path),
    cluster: requireEnum(value, 'cluster', CLUSTERS, path),
    finalizedAt: requireString(value, 'finalizedAt', path),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Ap2ParseError('invalid_receipt:not_object', `${path} must be a JSON object.`, path);
  }
  return value;
}

function requireField(object: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new Ap2ParseError('invalid_receipt:missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  return requireObject(value, `${path}.${key}`);
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new Ap2ParseError('invalid_receipt:missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Ap2ParseError('invalid_receipt:invalid_field', `${path}.${key} must be a non-empty string.`, `${path}.${key}`);
  }
  return value;
}

function requireEnum<T extends string>(
  object: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
): T {
  const raw = requireString(object, key, path);
  if (!values.includes(raw as T)) {
    throw new Ap2ParseError(
      'invalid_receipt:invalid_field',
      `${path}.${key} must be one of: ${values.join(', ')}.`,
      `${path}.${key}`,
    );
  }
  return raw as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
