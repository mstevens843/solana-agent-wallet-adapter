import { createHash, createPublicKey, verify as verifyDetached } from 'node:crypto';

import {
  Ap2VerifyError,
  type Ap2Cluster,
  type Ap2Mandate,
  type Ap2PaymentDetails,
  type Ap2VerifiedAgent,
  type JsonObject,
  type JsonValue,
} from './types.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index] as const));
const DEFAULT_CLOCK_SKEW_MS = 60_000;

export interface Ap2VerifyOptions {
  expectedRecipient?: string;
  expectedCluster?: Ap2Cluster;
  clockNow?: Date;
  clockSkewMs?: number;
}

export interface Ap2VerifySuccess {
  verified: true;
  agent: Ap2VerifiedAgent;
}

/**
 * Verify a parsed AP2 mandate's ed25519 signature and optional bindings.
 *
 * SECURITY CONTRACT: Callers in the route layer MUST pass
 * `opts.expectedRecipient = session.walletAddress` so an attacker cannot
 * replay a mandate sent to a different wallet. `opts.expectedCluster` SHOULD
 * be set to the request's cluster. Default clock skew is 60 seconds.
 *
 * Throws `Ap2VerifyError` with `code` in:
 *   `expired`, `invalid_expiry`, `invalid_public_key`, `invalid_signature`,
 *   `bad_signature`, `recipient_mismatch`, `cluster_mismatch`.
 */
export function verifyAp2Mandate(mandate: Ap2Mandate, opts: Ap2VerifyOptions = {}): Ap2VerifySuccess {
  const clockNow = opts.clockNow ?? new Date();
  const skewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const expiresAtMs = new Date(mandate.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    throw new Ap2VerifyError('invalid_expiry', 'mandate.expiresAt is not a valid date.');
  }
  if (expiresAtMs + skewMs <= clockNow.getTime()) {
    throw new Ap2VerifyError('expired', `mandate expired at ${mandate.expiresAt}.`);
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = decodeBase58(mandate.agent.publicKey);
  } catch (err) {
    throw new Ap2VerifyError('invalid_public_key', `agent.publicKey is not valid base58: ${(err as Error).message}`);
  }
  if (publicKeyBytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new Ap2VerifyError('invalid_public_key', `agent.publicKey must be ${ED25519_PUBLIC_KEY_BYTES} bytes; got ${publicKeyBytes.length}.`);
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = decodeBase58(mandate.signature);
  } catch (err) {
    throw new Ap2VerifyError('invalid_signature', `signature is not valid base58: ${(err as Error).message}`);
  }
  if (signatureBytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new Ap2VerifyError('invalid_signature', `signature must be ${ED25519_SIGNATURE_BYTES} bytes; got ${signatureBytes.length}.`);
  }

  const spki = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyBytes)]);
  const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const message = Buffer.from(canonicalize(mandate.signedFields), 'utf8');
  const ok = verifyDetached(null, message, publicKey, signatureBytes);
  if (!ok) {
    throw new Ap2VerifyError('bad_signature', 'signature does not verify against agent.publicKey and signedFields.');
  }

  const payment = paymentDetailsFor(mandate);
  if (opts.expectedRecipient && payment.recipient !== opts.expectedRecipient) {
    throw new Ap2VerifyError(
      'recipient_mismatch',
      `mandate recipient ${payment.recipient} does not match expected ${opts.expectedRecipient}.`,
    );
  }
  if (opts.expectedCluster && payment.cluster !== opts.expectedCluster) {
    throw new Ap2VerifyError(
      'cluster_mismatch',
      `mandate cluster ${payment.cluster} does not match expected ${opts.expectedCluster}.`,
    );
  }

  return {
    verified: true,
    agent: {
      agentId: mandate.agent.agentId,
      agentLabel: mandate.agent.agentLabel,
      publicKey: mandate.agent.publicKey,
    },
  };
}

/**
 * Extract the effective `Ap2PaymentDetails` from either mandate variant.
 * For IntentMandate this returns `intent.cap`; for PaymentMandate, `payment`.
 */
export function paymentDetailsFor(mandate: Ap2Mandate): Ap2PaymentDetails {
  return mandate.mandateType === 'intent_mandate' ? mandate.intent.cap : mandate.payment;
}

/**
 * Sha256 (hex) of `canonicalize(value)`. Used as the `artifactHash` in
 * receipts and as the deterministic content hash anywhere stable identity
 * is needed for JSON-shaped data.
 */
export function canonicalJsonSha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * RFC 8785 JCS subset: deterministic JSON serialization. Sorts object keys
 * by UTF-16 code-unit order, no whitespace, escapes strings via `JSON.stringify`.
 * Throws `Ap2VerifyError('invalid_signed_fields')` if asked to canonicalize
 * `NaN`, `Infinity`, or unsupported types.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Ap2VerifyError('invalid_signed_fields', 'signedFields must not contain NaN or Infinity.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as JsonObject;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key] as JsonValue)}`);
    return `{${parts.join(',')}}`;
  }
  throw new Ap2VerifyError('invalid_signed_fields', `unsupported value of type ${typeof value} in signedFields.`);
}

/** Base58 (Bitcoin alphabet) encode. Mirrors `apps/render-web/src/cloud/auth.ts`. */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i] ?? 0];
  }
  return result;
}

/** Base58 (Bitcoin alphabet) decode. Throws on invalid characters. */
export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < value.length; i++) {
    const char = value[i] as string;
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) {
      throw new Error(`invalid base58 character "${char}"`);
    }
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i] ?? 0;
  }
  return out;
}
