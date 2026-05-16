import { createHash } from 'node:crypto';

import { MppVerifyError } from './errors.js';
import {
  MPP_PROTOCOL_VERSION,
  SOL_NATIVE_MINT,
  type JsonObject,
  type JsonValue,
  type MppChallenge,
  type MppCluster,
  type MppPaymentMethod,
} from './types.js';

export interface VerifyMppChallengeOptions {
  clockNow?: Date;
  expectedCluster?: MppCluster;
  maxAmount?: string;
  allowedMints?: readonly string[];
}

export interface VerifiedMppChallenge {
  verified: true;
  challenge: MppChallenge;
  challengeHash: string;
  paymentMethod: MppPaymentMethod;
}

/**
 * Verify an already-parsed MPP challenge against local wallet policy.
 *
 * MPP Phase 1 challenges are not signed by the merchant. Verification here is
 * policy verification: protocol version, expiry, nonce, amount cap, accepted
 * cluster, supported Solana rail, and mint allowlist.
 */
export function verifyMppChallenge(
  challenge: MppChallenge,
  opts: VerifyMppChallengeOptions = {},
): VerifiedMppChallenge {
  if (challenge.protocolVersion !== MPP_PROTOCOL_VERSION) {
    throw new MppVerifyError(
      'unsupported_protocol',
      `challenge.protocolVersion must be ${MPP_PROTOCOL_VERSION}; got ${challenge.protocolVersion}.`,
      '$.protocolVersion',
    );
  }

  const nonce = challenge.nonce.trim();
  if (!nonce) {
    throw new MppVerifyError('invalid_schema', 'challenge.nonce must be non-empty.', '$.nonce');
  }

  const expiresAtMs = Date.parse(challenge.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    throw new MppVerifyError('invalid_expiry', 'challenge.expiresAt is not a valid timestamp.', '$.expiresAt');
  }
  const clockNow = opts.clockNow ?? new Date();
  if (expiresAtMs <= clockNow.getTime()) {
    throw new MppVerifyError('expired_challenge', `challenge expired at ${challenge.expiresAt}.`, '$.expiresAt');
  }

  if (opts.maxAmount && compareDecimalStrings(challenge.amount, opts.maxAmount) > 0) {
    throw new MppVerifyError(
      'amount_exceeds_cap',
      `challenge amount ${challenge.amount} exceeds configured cap ${opts.maxAmount}.`,
      '$.amount',
    );
  }

  const paymentMethod = selectSupportedPaymentMethod(challenge, opts);
  return {
    verified: true,
    challenge,
    challengeHash: canonicalChallengeHash(challenge),
    paymentMethod,
  };
}

export function canonicalChallengeHash(challenge: MppChallenge): string {
  return canonicalJsonSha256(challenge as unknown as JsonValue);
}

export function selectSupportedPaymentMethod(
  challenge: MppChallenge,
  opts: Pick<VerifyMppChallengeOptions, 'expectedCluster' | 'allowedMints'> = {},
): MppPaymentMethod {
  const allowedMints = normalizeAllowedMints(opts.allowedMints);
  let sawClusterMismatch = false;
  let sawMintDenied = false;
  for (const method of challenge.paymentMethods) {
    if (method.kind !== 'solana-sol' && method.kind !== 'solana-spl') continue;
    if (opts.expectedCluster && method.network !== opts.expectedCluster) {
      sawClusterMismatch = true;
      continue;
    }
    if (method.kind === 'solana-spl') {
      if (!method.mint) continue;
      if (allowedMints && !allowedMints.has(method.mint)) {
        sawMintDenied = true;
        continue;
      }
    }
    return method;
  }
  if (sawMintDenied) {
    throw new MppVerifyError('mint_not_allowed', 'challenge does not include an allowed SPL mint.', '$.paymentMethods');
  }
  if (sawClusterMismatch) {
    throw new MppVerifyError('unsupported_rail', 'challenge does not include a Solana payment method for the expected cluster.', '$.paymentMethods');
  }
  throw new MppVerifyError('unsupported_rail', 'challenge does not include a supported Solana payment method.', '$.paymentMethods');
}

function normalizeAllowedMints(allowedMints: readonly string[] | undefined): Set<string> | undefined {
  if (!allowedMints || allowedMints.length === 0) return undefined;
  return new Set(allowedMints.filter((mint) => mint && mint !== SOL_NATIVE_MINT));
}

/**
 * Sha256 (hex) of deterministic JSON serialization. Mirrors AP2's
 * `canonicalJsonSha256()` helper so MPP hashes remain stable across runtimes.
 */
export function canonicalJsonSha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/**
 * RFC 8785 JCS subset: deterministic JSON serialization. Sorts object keys,
 * writes no whitespace, and rejects non-finite numbers / unsupported types.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MppVerifyError('invalid_schema', 'canonical JSON cannot contain NaN or Infinity.');
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
  throw new MppVerifyError('invalid_schema', `unsupported value of type ${typeof value} in canonical JSON.`);
}

export function compareDecimalStrings(left: string, right: string): number {
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
