import { createPublicKey, randomBytes, verify as verifyDetached } from 'node:crypto';

import type {
  AuthNonceResponse as SharedAuthNonceResponse,
  VerifyWalletRequest as SharedVerifyWalletRequest,
} from '@solana-agent-wallet-adapter/workflow';

import type { Clock } from './store.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index] as const));
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const AUTH_NONCE_TTL_MS = 5 * 60 * 1000;

export type AuthNonceResponse = SharedAuthNonceResponse & { walletAddress: string };

export interface VerifyWalletRequest extends
  Omit<SharedVerifyWalletRequest, 'domain' | 'issuedAt' | 'expiresAt' | 'signatureEncoding'> {
  walletAddress: string;
  nonce: string;
  message: string;
  signature: string;
  domain?: string;
  issuedAt?: string;
  expiresAt?: string;
  signatureEncoding?: 'base58' | 'base64';
}

export interface LoginMessageFields {
  domain: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export function createAuthNonceResponse(input: {
  walletAddress: string;
  domain: string;
  clock: Clock;
}): AuthNonceResponse {
  const issuedAt = input.clock.now();
  const expiresAt = new Date(issuedAt.getTime() + AUTH_NONCE_TTL_MS);
  const fields = {
    domain: input.domain,
    walletAddress: input.walletAddress,
    nonce: encodeBase58(randomBytes(24)),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return {
    ...fields,
    message: buildWalletLoginMessage(fields),
  };
}

export function buildWalletLoginMessage(fields: LoginMessageFields): string {
  return [
    'Agentic Cloud wants you to sign in with your Solana wallet.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    '',
    'This signature proves wallet ownership only. It does not grant spending authority, transaction approval, delegated signing, or permission to move funds.',
  ].join('\n');
}

export function verifyWalletSignature(input: {
  message: string;
  signature: string;
  walletAddress: string;
  signatureEncoding?: 'base58' | 'base64';
}): boolean {
  try {
    const publicKeyBytes = decodeBase58(input.walletAddress);
    const signatureBytes = input.signatureEncoding === 'base64'
      ? Buffer.from(input.signature, 'base64')
      : decodeBase58(input.signature);
    if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    });
    return verifyDetached(null, Buffer.from(input.message, 'utf8'), key, signatureBytes);
  } catch {
    return false;
  }
}

export function normalizeWalletAddress(value: unknown): string {
  const raw = stringField(value).trim();
  if (!raw) {
    throw new AuthValidationError('Missing wallet address.');
  }
  const decoded = decodeBase58(raw);
  if (decoded.length !== 32) {
    throw new AuthValidationError('Wallet address must be a Solana public key.');
  }
  return encodeBase58(decoded);
}

export function parseVerifyWalletRequest(input: unknown): VerifyWalletRequest {
  if (!input || typeof input !== 'object') {
    throw new AuthValidationError('Missing wallet verification request.');
  }
  const record = input as Record<string, unknown>;
  return {
    walletAddress: normalizeWalletAddress(record.walletAddress),
    nonce: requiredString(record.nonce, 'Missing auth nonce.'),
    message: requiredString(record.message, 'Missing signed message.'),
    signature: requiredString(record.signature, 'Missing wallet signature.'),
    ...optionalStringProp(record, 'domain'),
    ...optionalStringProp(record, 'issuedAt'),
    ...optionalStringProp(record, 'expiresAt'),
    ...optionalSignatureEncodingProp(record.signatureEncoding),
  };
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let value = 0n;
  for (const byte of bytes) {
    value = (value * 256n) + BigInt(byte);
  }
  let encoded = '';
  while (value > 0n) {
    const mod = Number(value % 58n);
    encoded = BASE58_ALPHABET[mod] + encoded;
    value /= 58n;
  }
  let leadingZeroes = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes += '1';
  }
  return leadingZeroes + (encoded || '');
}

export function decodeBase58(value: string): Buffer {
  if (!value) {
    throw new AuthValidationError('Base58 value is empty.');
  }
  let decoded = 0n;
  for (const char of value) {
    const index = BASE58_INDEX.get(char);
    if (index === undefined) {
      throw new AuthValidationError('Base58 value contains invalid characters.');
    }
    decoded = (decoded * 58n) + BigInt(index);
  }
  const bytes: number[] = [];
  while (decoded > 0n) {
    bytes.unshift(Number(decoded % 256n));
    decoded /= 256n;
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function requiredString(value: unknown, message: string): string {
  const stringValue = stringField(value).trim();
  if (!stringValue) {
    throw new AuthValidationError(message);
  }
  return stringValue;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalStringProp(record: Record<string, unknown>, key: 'domain' | 'issuedAt' | 'expiresAt'): Partial<Pick<VerifyWalletRequest, typeof key>> {
  const value = stringField(record[key]).trim();
  return value ? { [key]: value } : {};
}

function optionalSignatureEncodingProp(value: unknown): Pick<VerifyWalletRequest, 'signatureEncoding'> {
  if (value === undefined) {
    return { signatureEncoding: 'base58' };
  }
  if (value === 'base58' || value === 'base64') {
    return { signatureEncoding: value };
  }
  throw new AuthValidationError('Unsupported wallet signature encoding.');
}

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthValidationError';
  }
}
