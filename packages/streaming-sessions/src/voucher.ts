import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  SessionExpiredError,
  SessionNotActiveError,
  SessionRevokedError,
  StreamingInvalidAmountError,
  StreamingInvalidInputError,
  StreamingInvalidPublicKeyError,
  StreamingInvalidSchemaError,
  VoucherExceedsRemainingError,
  VoucherInvalidSignatureError,
  VoucherRecipientNotAllowedError,
  VoucherReplayError,
} from './errors.js';
import {
  DEFAULT_TOKEN_DECIMALS,
  STREAMING_VOUCHER_SCHEMA,
  type SessionGrant,
  type Voucher,
  type VoucherHash,
} from './types.js';

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SECRET_KEY_BYTES = 64;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_U64 = 18_446_744_073_709_551_615n;

export interface EphemeralKeypair {
  publicKey: string;
  secretKey: Uint8Array;
}

export interface SignVoucherInput {
  sessionId: string;
  nonce: string;
  amount: string;
  recipient: string;
  issuedAt?: string;
  tokenDecimals?: number;
}

export interface ValidateVoucherInput {
  grant: SessionGrant;
  voucher: Voucher;
  usedNonces?: ReadonlySet<string>;
  now?: Date | string | number;
}

export interface ValidateVoucherResult {
  voucherHash: VoucherHash;
  amountBaseUnits: bigint;
  capBaseUnits: bigint;
  spentBaseUnits: bigint;
  remainingAmount: string;
}

export interface VoucherValidationOptions {
  tokenDecimals?: number;
}

interface CanonicalVoucherPayload {
  schema: typeof STREAMING_VOUCHER_SCHEMA;
  sessionId: string;
  nonce: string;
  amount: string;
  recipient: string;
  issuedAt: string;
}

export function generateEphemeralKeypair(): EphemeralKeypair {
  const keypair = nacl.sign.keyPair();
  return {
    publicKey: bs58.encode(keypair.publicKey),
    secretKey: keypair.secretKey,
  };
}

export function signVoucher(keypair: EphemeralKeypair, input: SignVoucherInput): Voucher {
  const secretKey = requireBytes(keypair.secretKey, ED25519_SECRET_KEY_BYTES, 'secretKey');
  const publicKey = decodeFixedBase58(keypair.publicKey, ED25519_PUBLIC_KEY_BYTES, 'publicKey');
  const derived = nacl.sign.keyPair.fromSecretKey(secretKey).publicKey;
  if (!bytesEqual(publicKey, derived)) {
    throw new StreamingInvalidPublicKeyError('keypair.publicKey does not match keypair.secretKey.');
  }

  const issuedAt = input.issuedAt ?? new Date().toISOString();
  requireIsoTimestamp(issuedAt, 'issuedAt');
  const voucher: Omit<Voucher, 'signature'> = {
    schema: STREAMING_VOUCHER_SCHEMA,
    sessionId: requireNonEmptyString(input.sessionId, 'sessionId'),
    nonce: requireNonEmptyString(input.nonce, 'nonce'),
    amount: requireNonEmptyString(input.amount, 'amount'),
    recipient: requireNonEmptyString(input.recipient, 'recipient'),
    issuedAt,
  };
  validateVoucherPayload(voucher, { tokenDecimals: input.tokenDecimals });

  const digest = voucherDigest(voucher, { tokenDecimals: input.tokenDecimals });
  const signature = nacl.sign.detached(digest, secretKey);
  return {
    ...voucher,
    signature: bs58.encode(signature),
  };
}

export function verifyVoucher(
  voucher: Voucher,
  ephemeralPublicKey: string,
  opts: VoucherValidationOptions = {},
): boolean {
  try {
    const publicKey = decodeFixedBase58(ephemeralPublicKey, ED25519_PUBLIC_KEY_BYTES, 'ephemeralPublicKey');
    const signature = decodeFixedBase58(voucher.signature, ED25519_SIGNATURE_BYTES, 'signature');
    return nacl.sign.detached.verify(voucherDigest(voucher, opts), signature, publicKey);
  } catch {
    return false;
  }
}

export function computeVoucherHash(voucher: Voucher, opts: VoucherValidationOptions = {}): VoucherHash {
  return bytesToHex(voucherDigest(voucher, opts));
}

export function validateVoucher(input: ValidateVoucherInput): ValidateVoucherResult {
  const { grant, voucher } = input;
  if (grant.status === 'revoked') {
    throw new SessionRevokedError();
  }
  if (grant.status === 'expired') {
    throw new SessionExpiredError();
  }
  if (grant.status !== 'active') {
    throw new SessionNotActiveError(`Session ${grant.sessionId} is ${grant.status}, not active.`);
  }
  if (grant.sessionId !== voucher.sessionId) {
    throw new StreamingInvalidInputError('Voucher sessionId does not match the session grant.');
  }

  const now = input.now === undefined ? new Date() : new Date(input.now);
  if (Number.isNaN(now.getTime())) {
    throw new StreamingInvalidInputError('now must be a valid timestamp.');
  }
  const expiresAt = new Date(grant.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new StreamingInvalidInputError('grant.expiresAt must be a valid ISO-8601 timestamp.');
  }
  if (now.getTime() >= expiresAt.getTime()) {
    throw new SessionExpiredError(`Session expired at ${grant.expiresAt}.`);
  }

  if (input.usedNonces?.has(voucher.nonce)) {
    throw new VoucherReplayError(`Voucher nonce ${voucher.nonce} has already been used.`);
  }
  for (const [index, recipient] of (grant.recipientAllowlist ?? []).entries()) {
    requireSolanaPublicKeyString(recipient, `grant.recipientAllowlist[${index}]`);
  }
  if (grant.recipientAllowlist && !grant.recipientAllowlist.includes(voucher.recipient)) {
    throw new VoucherRecipientNotAllowedError(`Voucher recipient ${voucher.recipient} is not allowed.`);
  }

  const decimals = tokenDecimalsFor(grant.tokenDecimals);
  requireSolanaPublicKeyString(grant.ephemeralSignerPubkey, 'grant.ephemeralSignerPubkey');
  const amountBaseUnits = parseTokenAmountToBaseUnits(voucher.amount, decimals, { field: 'voucher.amount' });
  const capBaseUnits = parseTokenAmountToBaseUnits(grant.capAmount, decimals, { field: 'grant.capAmount' });
  const spentBaseUnits = parseTokenAmountToBaseUnits(grant.spentAmount, decimals, {
    allowZero: true,
    field: 'grant.spentAmount',
  });
  const nextSpent = spentBaseUnits + amountBaseUnits;
  if (nextSpent > capBaseUnits) {
    throw new VoucherExceedsRemainingError();
  }
  if (!verifyVoucher(voucher, grant.ephemeralSignerPubkey, { tokenDecimals: decimals })) {
    throw new VoucherInvalidSignatureError();
  }

  return {
    voucherHash: computeVoucherHash(voucher, { tokenDecimals: decimals }),
    amountBaseUnits,
    capBaseUnits,
    spentBaseUnits,
    remainingAmount: formatBaseUnitsToDecimal(capBaseUnits - nextSpent, decimals),
  };
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StreamingInvalidInputError('Cannot canonicalize NaN or Infinity.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(',')}}`;
  }
  throw new StreamingInvalidInputError(`Cannot canonicalize value of type ${typeof value}.`);
}

export function parseTokenAmountToBaseUnits(
  amount: string,
  decimals = DEFAULT_TOKEN_DECIMALS,
  opts: { allowZero?: boolean; field?: string } = {},
): bigint {
  const field = opts.field ?? 'amount';
  const normalized = requireNonEmptyString(amount, field);
  const tokenDecimals = tokenDecimalsFor(decimals);
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new StreamingInvalidAmountError(`${field} must be a non-negative decimal string.`);
  }
  const fraction = match[1] ?? '';
  if (fraction.length > tokenDecimals) {
    throw new StreamingInvalidAmountError(`${field} has more than ${tokenDecimals} decimal places.`);
  }
  const [whole = '0'] = normalized.split('.');
  const paddedFraction = fraction.padEnd(tokenDecimals, '0');
  const scale = 10n ** BigInt(tokenDecimals);
  const baseUnits = BigInt(whole) * scale + BigInt(paddedFraction || '0');
  if (baseUnits === 0n && opts.allowZero !== true) {
    throw new StreamingInvalidAmountError(`${field} must be greater than zero.`);
  }
  if (baseUnits > MAX_U64) {
    throw new StreamingInvalidAmountError(`${field} exceeds the SPL Token u64 amount limit.`);
  }
  return baseUnits;
}

export function formatBaseUnitsToDecimal(baseUnits: bigint, decimals = DEFAULT_TOKEN_DECIMALS): string {
  if (baseUnits < 0n) {
    throw new StreamingInvalidAmountError('baseUnits must be non-negative.');
  }
  const tokenDecimals = tokenDecimalsFor(decimals);
  const scale = 10n ** BigInt(tokenDecimals);
  const whole = baseUnits / scale;
  const fraction = baseUnits % scale;
  if (fraction === 0n) return whole.toString();
  const fractionText = fraction.toString().padStart(tokenDecimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fractionText}`;
}

export function tokenDecimalsFor(decimals: number | undefined): number {
  const value = decimals ?? DEFAULT_TOKEN_DECIMALS;
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new StreamingInvalidInputError('tokenDecimals must be an integer between 0 and 255.');
  }
  return value;
}

function voucherDigest(voucher: Omit<Voucher, 'signature'>, opts: VoucherValidationOptions = {}): Uint8Array {
  return sha256(utf8ToBytes(canonicalize(validateVoucherPayload(voucher, opts))));
}

function validateVoucherPayload(
  voucher: Omit<Voucher, 'signature'>,
  opts: VoucherValidationOptions = {},
): CanonicalVoucherPayload {
  if (voucher.schema !== STREAMING_VOUCHER_SCHEMA) {
    throw new StreamingInvalidSchemaError(`Voucher schema must be ${STREAMING_VOUCHER_SCHEMA}.`);
  }
  const issuedAt = requireNonEmptyString(voucher.issuedAt, 'issuedAt');
  requireIsoTimestamp(issuedAt, 'issuedAt');
  const recipient = requireNonEmptyString(voucher.recipient, 'recipient');
  requireSolanaPublicKeyString(recipient, 'recipient');
  const amount = requireNonEmptyString(voucher.amount, 'amount');
  parseTokenAmountToBaseUnits(amount, opts.tokenDecimals, { field: 'amount' });
  return {
    schema: STREAMING_VOUCHER_SCHEMA,
    sessionId: requireNonEmptyString(voucher.sessionId, 'sessionId'),
    nonce: requireNonEmptyString(voucher.nonce, 'nonce'),
    amount,
    recipient,
    issuedAt,
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StreamingInvalidInputError(`${field} must be a non-empty string.`);
  }
  return value;
}

function requireIsoTimestamp(value: string, field: string): void {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new StreamingInvalidInputError(`${field} must be a valid ISO-8601 timestamp.`);
  }
}

function decodeFixedBase58(value: string, length: number, field: string): Uint8Array {
  const text = requireNonEmptyString(value, field);
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(text);
  } catch (err) {
    throw new StreamingInvalidPublicKeyError(`${field} must be valid base58: ${(err as Error).message}`);
  }
  if (decoded.length !== length) {
    throw new StreamingInvalidPublicKeyError(`${field} must decode to ${length} bytes; got ${decoded.length}.`);
  }
  return decoded;
}

function requireSolanaPublicKeyString(value: string, field: string): void {
  decodeFixedBase58(value, ED25519_PUBLIC_KEY_BYTES, field);
}

function requireBytes(value: unknown, length: number, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new StreamingInvalidInputError(`${field} must be a Uint8Array.`);
  }
  if (value.length !== length) {
    throw new StreamingInvalidInputError(`${field} must be ${length} bytes; got ${value.length}.`);
  }
  return value;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
