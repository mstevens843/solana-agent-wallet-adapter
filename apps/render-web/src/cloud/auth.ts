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
export type CloudWorkspaceDeleteIntentResponse = AuthNonceResponse;

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
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
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

export function createCloudWorkspaceDeleteIntentResponse(input: {
  walletAddress: string;
  domain: string;
  clock: Clock;
}): CloudWorkspaceDeleteIntentResponse {
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
    message: buildCloudWorkspaceDeleteMessage(fields),
  };
}

export type AgentProfileIntentResponse = AuthNonceResponse;

export function createAgentProfilePublishIntentResponse(input: {
  walletAddress: string;
  domain: string;
  payloadHashHex: string;
  clock: Clock;
}): AgentProfileIntentResponse {
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
    message: buildAgentProfilePublishMessage(fields, input.payloadHashHex),
  };
}

export function createAgentProfileTakedownIntentResponse(input: {
  walletAddress: string;
  domain: string;
  clock: Clock;
}): AgentProfileIntentResponse {
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
    message: buildAgentProfileTakedownMessage(fields),
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

export function buildCloudWorkspaceDeleteMessage(fields: LoginMessageFields): string {
  return [
    'Agentic Cloud wants you to delete this wallet workspace.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    '',
    'This signature permanently deletes Agentic Cloud workspace data for this wallet, including drafts, approvals, schedules, receipts, completed history, and app audit events.',
    'It does not submit a transaction, grant spending authority, delegated signing, or permission to move funds.',
  ].join('\n');
}

export function buildAgentProfilePublishMessage(fields: LoginMessageFields, payloadHashHex: string): string {
  return [
    'Agentic Cloud wants you to publish your agent payment profile.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    `Payload SHA-256: ${payloadHashHex}`,
    '',
    'This signature publishes a discovery profile only. It does not grant spending authority, delegated signing, or permission to move funds.',
  ].join('\n');
}

export function buildAgentProfileTakedownMessage(fields: LoginMessageFields): string {
  return [
    'Agentic Cloud wants you to take down your agent payment profile.',
    '',
    `Domain: ${fields.domain}`,
    `Wallet: ${fields.walletAddress}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expires At: ${fields.expiresAt}`,
    '',
    'This signature removes your wallet from discovery. It does not grant spending authority, delegated signing, or permission to move funds.',
  ].join('\n');
}

const MEMO_PROGRAM_V2_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function verifyWalletSignature(input: {
  message: string;
  signature: string;
  walletAddress: string;
  signatureEncoding?: 'base58' | 'base64';
  /**
   * Phantom Mobile MWA cannot signMessage; the FE signs a memo-only throwaway
   * transaction whose memo data == message bytes (see
   * apps/browser-demo/src/walletProofSigning.ts). For that path, the signature
   * is over the compiled transaction message, not the UTF-8 message bytes.
   */
  proofEncoding?: 'utf8-message' | 'tx-memo-proof';
  proofTxBase64?: string;
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
    if (input.proofEncoding === 'tx-memo-proof' && input.proofTxBase64) {
      const verified = verifyTxMemoProof({
        txBase64: input.proofTxBase64,
        message: input.message,
        signatureBytes,
        publicKeyBytes,
        key,
      });
      return verified;
    }
    return verifyDetached(null, Buffer.from(input.message, 'utf8'), key, signatureBytes);
  } catch {
    return false;
  }
}

function verifyTxMemoProof(input: {
  txBase64: string;
  message: string;
  signatureBytes: Buffer;
  publicKeyBytes: Uint8Array;
  key: ReturnType<typeof createPublicKey>;
}): boolean {
  const txBytes = Buffer.from(input.txBase64, 'base64');
  const messageBytes = Buffer.from(input.message, 'utf8');
  const parsed = parseTxMessageAndMemo(txBytes);
  if (!parsed) return false;
  if (parsed.memoData.length !== messageBytes.length) return false;
  if (!parsed.memoData.equals(messageBytes)) return false;
  const feePayerKey = parsed.staticAccountKeys[0];
  if (!feePayerKey || !buffersEqual(feePayerKey, Buffer.from(input.publicKeyBytes))) return false;
  return verifyDetached(null, parsed.messageBytes, input.key, input.signatureBytes);
}

interface ParsedTxProof {
  messageBytes: Buffer;
  memoData: Buffer;
  staticAccountKeys: Buffer[];
}

function parseTxMessageAndMemo(txBytes: Buffer): ParsedTxProof | null {
  // Solana wire format: [num_signatures (compact-u16)] [signatures...64 bytes each] [message...]
  let cursor = 0;
  const numSignatures = readCompactU16(txBytes, cursor);
  if (!numSignatures) return null;
  cursor = numSignatures.next;
  cursor += numSignatures.value * 64;
  if (cursor >= txBytes.length) return null;
  const messageBytes = txBytes.subarray(cursor);
  return parseMessageBytes(messageBytes);
}

function parseMessageBytes(messageBytes: Buffer): ParsedTxProof | null {
  // Detect versioned message: high bit of first byte = 0x80 sentinel.
  const firstByte = messageBytes[0];
  if (firstByte === undefined) return null;
  const isVersioned = (firstByte & 0x80) !== 0;
  const headerStart = isVersioned ? 1 : 0;
  if (messageBytes.length < headerStart + 3) return null;
  const numRequiredSigs = messageBytes[headerStart];
  // numReadonlySigned = messageBytes[headerStart + 1]
  // numReadonlyUnsigned = messageBytes[headerStart + 2]
  if (numRequiredSigs === undefined) return null;
  let cursor = headerStart + 3;
  const accountKeysCount = readCompactU16(messageBytes, cursor);
  if (!accountKeysCount) return null;
  cursor = accountKeysCount.next;
  const staticAccountKeys: Buffer[] = [];
  for (let i = 0; i < accountKeysCount.value; i += 1) {
    if (cursor + 32 > messageBytes.length) return null;
    staticAccountKeys.push(messageBytes.subarray(cursor, cursor + 32));
    cursor += 32;
  }
  // recent blockhash
  if (cursor + 32 > messageBytes.length) return null;
  cursor += 32;
  // instructions
  const numInstructions = readCompactU16(messageBytes, cursor);
  if (!numInstructions) return null;
  cursor = numInstructions.next;
  let memoData: Buffer | null = null;
  for (let i = 0; i < numInstructions.value; i += 1) {
    if (cursor >= messageBytes.length) return null;
    const programIdIndex = messageBytes[cursor];
    if (programIdIndex === undefined) return null;
    cursor += 1;
    const accountsLen = readCompactU16(messageBytes, cursor);
    if (!accountsLen) return null;
    cursor = accountsLen.next + accountsLen.value;
    const dataLen = readCompactU16(messageBytes, cursor);
    if (!dataLen) return null;
    cursor = dataLen.next;
    if (cursor + dataLen.value > messageBytes.length) return null;
    const data = messageBytes.subarray(cursor, cursor + dataLen.value);
    cursor += dataLen.value;
    const programKey = staticAccountKeys[programIdIndex];
    if (!programKey) return null;
    const programIdBase58 = encodeBase58(programKey);
    if (programIdBase58 === MEMO_PROGRAM_V2_ID) {
      if (memoData !== null) return null; // reject multiple memos to keep proof unambiguous
      memoData = Buffer.from(data);
    }
  }
  if (!memoData) return null;
  return { messageBytes: Buffer.from(messageBytes), memoData, staticAccountKeys };
}

function readCompactU16(bytes: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  let cursor = offset;
  for (let shift = 0; shift < 21; shift += 7) {
    const byte = bytes[cursor];
    if (byte === undefined) return null;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
  }
  return null;
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    ...optionalProofEncodingProp(record.proofEncoding),
    ...optionalStringProp(record, 'proofTxBase64'),
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

function optionalStringProp<K extends 'domain' | 'issuedAt' | 'expiresAt' | 'proofTxBase64'>(
  record: Record<string, unknown>,
  key: K,
): Partial<Pick<VerifyWalletRequest, K>> {
  const value = stringField(record[key]).trim();
  return value ? ({ [key]: value } as Partial<Pick<VerifyWalletRequest, K>>) : {};
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

function optionalProofEncodingProp(value: unknown): Pick<VerifyWalletRequest, 'proofEncoding'> {
  if (value === undefined || value === null || value === '') return {};
  if (value === 'utf8-message' || value === 'tx-memo-proof') {
    return { proofEncoding: value };
  }
  throw new AuthValidationError('Unsupported proof encoding.');
}

export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthValidationError';
  }
}
