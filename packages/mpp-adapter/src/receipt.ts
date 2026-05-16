import { randomUUID } from 'node:crypto';

import { MppReceiptError } from './errors.js';
import {
  MPP_PAYMENT_RECEIPT_SCHEMA,
  MPP_PROTOCOL_VERSION,
  type JsonObject,
  type JsonValue,
  type MppChallenge,
  type MppCluster,
  type MppCredential,
  type MppPaymentMethod,
  type MppPaymentRail,
  type MppReceipt,
} from './types.js';
import { canonicalChallengeHash, canonicalJsonSha256 } from './verifier.js';

export interface BuildMppPaymentReceiptInput {
  challenge: MppChallenge;
  credential: MppCredential;
  walletAddress: string;
  cluster: MppCluster;
  txid?: string;
  settledAt: string;
  issuedAt?: string;
  paymentMethod?: MppPaymentMethod;
  receiptId?: string;
}

const HEX_64 = /^[a-f0-9]{64}$/;
const CLUSTERS: readonly MppCluster[] = ['mainnet-beta', 'testnet', 'devnet', 'localnet'];
const PAYMENT_RAILS: readonly MppPaymentRail[] = ['solana-sol', 'solana-spl'];

export function buildMppPaymentReceipt(input: BuildMppPaymentReceiptInput): MppReceipt {
  const paymentMethod = input.paymentMethod ?? paymentMethodFromCredential(input.challenge, input.credential);
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const txid = input.txid ?? input.credential.txid;
  const credential: MppCredential = {
    kind: input.credential.kind,
    signature: input.credential.signature,
    ...(txid ? { txid } : {}),
    payerWallet: input.credential.payerWallet || input.walletAddress,
    settledAt: input.credential.settledAt || input.settledAt,
  };
  const challengeHash = canonicalChallengeHash(input.challenge);
  const credentialHash = canonicalJsonSha256(credential as unknown as JsonValue);
  const draft: Omit<MppReceipt, 'artifactHash'> = {
    schema: MPP_PAYMENT_RECEIPT_SCHEMA,
    protocolVersion: MPP_PROTOCOL_VERSION,
    receiptId: input.receiptId ?? `mpp_${challengeHash.slice(0, 16)}_${credentialHash.slice(0, 16)}`,
    challengeHash,
    credentialHash,
    payerWallet: input.walletAddress,
    cluster: input.cluster,
    amount: input.challenge.amount,
    currency: input.challenge.currency,
    recipient: paymentMethod.recipient,
    paymentMethod,
    resourceUrl: input.challenge.resourceUrl,
    nonce: input.challenge.nonce,
    ...(txid ? { txid } : {}),
    issuedAt,
    settledAt: input.settledAt,
    ...(input.challenge.merchant ? { merchant: input.challenge.merchant } : {}),
    ...(input.challenge.metadata ? { metadata: input.challenge.metadata } : {}),
  };
  const artifactHash = canonicalJsonSha256(draft as unknown as JsonValue);
  return { ...draft, artifactHash };
}

export function parseMppPaymentReceipt(value: unknown): MppReceipt {
  const root = requireObject(value, '$');
  const schema = requireString(root, 'schema', '$');
  if (schema !== MPP_PAYMENT_RECEIPT_SCHEMA) {
    throw new MppReceiptError(
      'invalid_schema',
      `receipt.schema must equal "${MPP_PAYMENT_RECEIPT_SCHEMA}"; got "${schema}".`,
      '$.schema',
    );
  }
  const protocolVersion = requireString(root, 'protocolVersion', '$');
  if (protocolVersion !== MPP_PROTOCOL_VERSION) {
    throw new MppReceiptError('unsupported_protocol', `receipt.protocolVersion must equal "${MPP_PROTOCOL_VERSION}".`, '$.protocolVersion');
  }
  const paymentMethod = parsePaymentMethod(requireObjectField(root, 'paymentMethod', '$'), '$.paymentMethod');
  const merchantRaw = root.merchant;
  const metadataRaw = root.metadata;
  const txid = optionalString(root, 'txid', '$');
  const receipt: MppReceipt = {
    schema: MPP_PAYMENT_RECEIPT_SCHEMA,
    protocolVersion: MPP_PROTOCOL_VERSION,
    receiptId: requireString(root, 'receiptId', '$'),
    challengeHash: requireHash(root, 'challengeHash', '$'),
    credentialHash: requireHash(root, 'credentialHash', '$'),
    artifactHash: requireHash(root, 'artifactHash', '$'),
    payerWallet: requireString(root, 'payerWallet', '$'),
    cluster: requireEnum(root, 'cluster', CLUSTERS, '$'),
    amount: requireString(root, 'amount', '$'),
    currency: requireString(root, 'currency', '$'),
    recipient: requireString(root, 'recipient', '$'),
    paymentMethod,
    resourceUrl: requireString(root, 'resourceUrl', '$'),
    nonce: requireString(root, 'nonce', '$'),
    ...(txid ? { txid } : {}),
    issuedAt: requireString(root, 'issuedAt', '$'),
    settledAt: requireString(root, 'settledAt', '$'),
    ...(merchantRaw && typeof merchantRaw === 'object' && !Array.isArray(merchantRaw)
      ? { merchant: merchantRaw as MppReceipt['merchant'] }
      : {}),
    ...(metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
      ? { metadata: metadataRaw as JsonObject }
      : {}),
  };
  return receipt;
}

export function verifyMppPaymentReceiptHash(receipt: MppReceipt): boolean {
  const { artifactHash, ...rest } = receipt;
  const expected = canonicalJsonSha256(rest as unknown as JsonValue);
  return expected === artifactHash;
}

function paymentMethodFromCredential(challenge: MppChallenge, credential: MppCredential): MppPaymentMethod {
  const method = challenge.paymentMethods.find((candidate) => candidate.kind === credential.kind);
  if (!method) {
    throw new MppReceiptError('unsupported_rail', `challenge does not contain credential rail ${credential.kind}.`, '$.paymentMethods');
  }
  return method;
}

function parsePaymentMethod(object: Record<string, unknown>, path: string): MppPaymentMethod {
  const kind = requireEnum(object, 'kind', PAYMENT_RAILS, path);
  const recipient = requireString(object, 'recipient', path);
  const network = requireEnum(object, 'network', CLUSTERS, path);
  const mint = optionalString(object, 'mint', path);
  return {
    kind,
    recipient,
    network,
    ...(mint ? { mint } : {}),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MppReceiptError('invalid_schema', `${path} must be a JSON object.`, path);
  }
  return value as Record<string, unknown>;
}

function requireObjectField(object: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new MppReceiptError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  return requireObject(value, `${path}.${key}`);
}

function requireString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (value === undefined || value === null) {
    throw new MppReceiptError('missing_field', `${path}.${key} is required.`, `${path}.${key}`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MppReceiptError('invalid_field', `${path}.${key} must be a non-empty string.`, `${path}.${key}`);
  }
  return value;
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new MppReceiptError('invalid_field', `${path}.${key} must be a string.`, `${path}.${key}`);
  }
  return value;
}

function requireHash(object: Record<string, unknown>, key: string, path: string): string {
  const value = requireString(object, key, path);
  if (!HEX_64.test(value)) {
    throw new MppReceiptError('invalid_field', `${path}.${key} must be a 64-character lowercase hex string.`, `${path}.${key}`);
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
    throw new MppReceiptError('invalid_field', `${path}.${key} must be one of: ${values.join(', ')}.`, `${path}.${key}`);
  }
  return raw as T;
}

export const __mppReceiptInternalsForTests = {
  randomReceiptId: () => `mpp_${randomUUID()}`,
};
