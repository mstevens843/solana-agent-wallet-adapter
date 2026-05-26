import bs58 from 'bs58';
import nacl from 'tweetnacl';

import {
  ProtocolError,
  type ApprovalResource,
  type Cluster,
  type ProtocolErrorPayload,
  type SigningRequest,
} from '@solana-agent-wallet-adapter/core';

export type EncryptedDeeplinkWalletId = 'phantom' | 'solflare';
export type EncryptedDeeplinkPhase = 'connect' | 'sign';
export type EncryptedDeeplinkMethod =
  | 'signMessage'
  | 'signTransaction'
  | 'signAndSendTransaction';

export interface EncryptedDeeplinkKeypair {
  publicKey: string;
  secretKey: string;
}

export interface EncryptedDeeplinkConnectResult {
  publicKey: string;
  session: string;
  walletEncryptionPublicKey: string;
  walletEncryptionKeyAlias: string;
  sharedSecret: string;
}

export interface EncryptedDeeplinkSessionRecord {
  pairing: string;
  wallet: EncryptedDeeplinkWalletId;
  cluster: Cluster;
  address: string;
  session: string;
  dappPublicKey: string;
  dappSecretKey: string;
  walletEncryptionPublicKey: string;
  sharedSecret: string;
  createdAt: number;
}

export interface ParsedQrConnectUrl {
  wallet: EncryptedDeeplinkWalletId | null;
  pairing: string;
  phase: EncryptedDeeplinkPhase | null;
  requestId: string;
  error: ProtocolErrorPayload | null;
  queryKeys: string[];
}

export interface BuildEncryptedSigningUrlOptions {
  wallet: EncryptedDeeplinkWalletId;
  dappPublicKey: string;
  sharedSecret: string;
  redirectLink: string;
  method: EncryptedDeeplinkMethod;
  payload: Record<string, unknown>;
  nonce?: Uint8Array;
}

export interface ResolveSigningPayloadOptions {
  wallet: EncryptedDeeplinkWalletId;
  request: SigningRequest;
  payload: Record<string, unknown>;
  sendRawTransaction?: (transaction: Uint8Array) => Promise<string>;
}

const WALLET_HOSTS: Record<EncryptedDeeplinkWalletId, string> = {
  phantom: 'phantom.app',
  solflare: 'solflare.com',
};

// Android package ids — used to force-launch the wallet via an `intent://`
// URL when the relay opens a sign request on Android. Matches the values in
// apps/render-web/src/cloud/androidConfig.ts (`packageNames`).
const WALLET_ANDROID_PACKAGES: Record<EncryptedDeeplinkWalletId, string> = {
  phantom: 'app.phantom',
  solflare: 'com.solflare.mobile',
};

/**
 * Build an Android `intent://` URL that force-launches the wallet app with
 * the same payload as the HTTPS universal link. App Links verification can
 * silently fail for individual paths (we observed this with Solflare's
 * `/ul/v1/signTransaction` on devices where `/ul/v1/connect` worked fine,
 * sending the user to a Play Store install page instead of the installed
 * wallet). An Android Intent URI bypasses App Links entirely and asks the OS
 * to launch the specified package directly; if the package is not installed
 * Chrome falls back to `browser_fallback_url`, which we set to the original
 * HTTPS universal link so the user still lands on the wallet's install page
 * rather than a hard error.
 *
 * Format reference:
 * https://developer.chrome.com/docs/android/intents
 */
export function buildAndroidWalletIntentUrl(
  wallet: EncryptedDeeplinkWalletId,
  httpsWalletUrl: string,
): string {
  const url = new URL(httpsWalletUrl);
  const pkg = WALLET_ANDROID_PACKAGES[wallet];
  // Strip the leading `https:` so the rest (`//host/path?query`) becomes the
  // intent body. The `scheme=https` extra inside the Intent fragment tells
  // Android which scheme to use when matching the installed package's intent
  // filter — that filter is registered against the https universal link.
  const intentBody = `${url.host}${url.pathname}${url.search}`;
  const fallback = encodeURIComponent(httpsWalletUrl);
  return `intent://${intentBody}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${fallback};end`;
}

const WALLET_ENCRYPTION_KEY_ALIASES: Record<EncryptedDeeplinkWalletId, readonly string[]> = {
  phantom: ['phantom_encryption_public_key', 'wallet_encryption_public_key'],
  solflare: ['solflare_encryption_public_key', 'wallet_encryption_public_key'],
};

const QR_PAIRING_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateEncryptedDeeplinkKeypair(): EncryptedDeeplinkKeypair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: bs58.encode(kp.publicKey),
    secretKey: bs58.encode(kp.secretKey),
  };
}

export function isEncryptedDeeplinkWalletId(value: string): value is EncryptedDeeplinkWalletId {
  return value === 'phantom' || value === 'solflare';
}

export function parseQrConnectUrl(input: string | URL): ParsedQrConnectUrl {
  const url = typeof input === 'string' ? new URL(input, 'https://agentic-signer.com') : input;
  const params = url.searchParams;
  const rawWallet = params.get('wallet')?.trim() ?? '';
  const rawPhase = params.get('phase')?.trim() ?? '';
  const rawPairing = params.get('pairing')?.trim() ?? '';
  return {
    wallet: isEncryptedDeeplinkWalletId(rawWallet) ? rawWallet : null,
    pairing: QR_PAIRING_PATTERN.test(rawPairing) ? rawPairing : '',
    phase: rawPhase === 'connect' || rawPhase === 'sign' ? rawPhase : null,
    requestId: params.get('requestId')?.trim() ?? '',
    error: walletErrorPayloadFromParams(params),
    queryKeys: [...params.keys()].sort(),
  };
}

export function decryptConnectResponse(
  wallet: EncryptedDeeplinkWalletId,
  callbackUrl: string | URL,
  dappSecretKey: string,
): EncryptedDeeplinkConnectResult {
  const url = typeof callbackUrl === 'string' ? new URL(callbackUrl, 'https://agentic-signer.com') : callbackUrl;
  const params = url.searchParams;
  const walletKey = findWalletEncryptionKey(wallet, params);
  if (!walletKey) {
    throw new ProtocolError(
      'invalid_request',
      `${walletLabel(wallet)} connect callback is missing the wallet encryption public key.`,
    );
  }
  const walletPublicKey = decodeBase58(walletKey.value, 'wallet encryption public key');
  const secretKey = decodeBase58(dappSecretKey, 'dapp encryption secret key');
  const payload = decryptPayloadWithBox(params, walletPublicKey, secretKey, `${walletLabel(wallet)} connect`);
  const publicKey = requiredString(payload, 'public_key', 'connect response');
  const session = requiredString(payload, 'session', 'connect response');
  const sharedSecret = nacl.box.before(walletPublicKey, secretKey);
  return {
    publicKey,
    session,
    walletEncryptionPublicKey: bs58.encode(walletPublicKey),
    walletEncryptionKeyAlias: walletKey.alias,
    sharedSecret: bs58.encode(sharedSecret),
  };
}

export function decryptSigningResponse(
  callbackUrl: string | URL,
  sharedSecret: string,
): Record<string, unknown> {
  const url = typeof callbackUrl === 'string' ? new URL(callbackUrl, 'https://agentic-signer.com') : callbackUrl;
  const params = url.searchParams;
  const sharedSecretBytes = decodeBase58(sharedSecret, 'shared secret');
  const nonce = requiredBase58Param(params, 'nonce');
  const data = requiredBase58Param(params, 'data');
  assertNonce(nonce);
  const plaintext = nacl.box.open.after(data, nonce, sharedSecretBytes);
  if (!plaintext) {
    throw new ProtocolError('unauthorized', 'Unable to decrypt wallet signing response.');
  }
  return parseJsonObject(plaintext, 'wallet signing response');
}

export function buildEncryptedSigningUrl(options: BuildEncryptedSigningUrlOptions): string {
  const nonce = options.nonce ?? nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(options.payload));
  const sharedSecret = decodeBase58(options.sharedSecret, 'shared secret');
  const encrypted = nacl.box.after(plaintext, nonce, sharedSecret);
  const url = walletMethodUrl(options.wallet, options.method);
  url.searchParams.set('dapp_encryption_public_key', options.dappPublicKey);
  url.searchParams.set('nonce', bs58.encode(nonce));
  url.searchParams.set('redirect_link', options.redirectLink);
  url.searchParams.set('payload', bs58.encode(encrypted));
  return url.toString();
}

export function signingMethodForRequest(
  wallet: EncryptedDeeplinkWalletId,
  request: SigningRequest,
): EncryptedDeeplinkMethod {
  if (request.kind === 'sign_message') return 'signMessage';
  if (request.kind === 'sign_and_send_transaction' && wallet === 'solflare') {
    return 'signAndSendTransaction';
  }
  return 'signTransaction';
}

export function signingPayloadForRequest(
  request: SigningRequest,
  session: string,
): Record<string, unknown> {
  const bytes = decodeSigningRequestBytes(request);
  switch (request.kind) {
    case 'sign_message':
      return {
        session,
        message: bs58.encode(bytes),
        display: 'utf8',
      };
    case 'sign_transaction':
    case 'sign_and_send_transaction':
      return {
        session,
        transaction: bs58.encode(bytes),
      };
  }
}

export function buildSigningUrlForRequest(options: {
  session: EncryptedDeeplinkSessionRecord;
  request: SigningRequest;
  redirectLink: string;
}): string {
  return buildEncryptedSigningUrl({
    wallet: options.session.wallet,
    dappPublicKey: options.session.dappPublicKey,
    sharedSecret: options.session.sharedSecret,
    redirectLink: options.redirectLink,
    method: signingMethodForRequest(options.session.wallet, options.request),
    payload: signingPayloadForRequest(options.request, options.session.session),
  });
}

export async function resolveSigningPayload(
  options: ResolveSigningPayloadOptions,
): Promise<ApprovalResource> {
  const { request, payload, wallet } = options;
  switch (request.kind) {
    case 'sign_message': {
      const signature = requiredString(payload, 'signature', 'signMessage response');
      return {
        requestId: request.id,
        status: 'approved',
        result: { signature },
      };
    }
    case 'sign_transaction': {
      const transaction = requiredString(payload, 'transaction', 'signTransaction response');
      return {
        requestId: request.id,
        status: 'approved',
        result: { signature: encodeBase64Bytes(decodeBase58(transaction, 'signed transaction')) },
      };
    }
    case 'sign_and_send_transaction': {
      if (wallet === 'solflare') {
        const signature = requiredString(payload, 'signature', 'signAndSendTransaction response');
        return {
          requestId: request.id,
          status: 'approved',
          result: { signature, txid: signature },
        };
      }
      const transaction = requiredString(payload, 'transaction', 'signTransaction response');
      if (!options.sendRawTransaction) {
        throw new ProtocolError('wallet_unreachable', 'No RPC sender is available for Phantom signed transaction broadcast.');
      }
      const txid = await options.sendRawTransaction(decodeBase58(transaction, 'signed transaction'));
      return {
        requestId: request.id,
        status: 'approved',
        result: { signature: txid, txid },
      };
    }
  }
}

export function approvalResourceFromError(
  requestId: string,
  err: unknown,
): ApprovalResource {
  const protocolErr = err instanceof ProtocolError
    ? err
    : err instanceof Error
      ? new ProtocolError('wallet_unreachable', err.message)
      : new ProtocolError('wallet_unreachable', String(err));
  return {
    requestId,
    status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
    error: protocolErr.toPayload(),
  };
}

export function rejectedApprovalFromWalletError(
  requestId: string,
  error: ProtocolErrorPayload,
): ApprovalResource {
  return {
    requestId,
    status: error.code === 'user_rejected' ? 'rejected' : 'failed',
    error,
  };
}

export function encodeBase64Bytes(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const bufferConstructor = (globalThis as {
    Buffer?: { from(value: Uint8Array): { toString(encoding: 'base64'): string } };
  }).Buffer;
  if (!bufferConstructor) {
    throw new ProtocolError('unsupported_method', 'No base64 encoder is available.');
  }
  return bufferConstructor.from(bytes).toString('base64');
}

export function decodeBase64Bytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    return output;
  }
  const bufferConstructor = (globalThis as {
    Buffer?: { from(value: string, encoding: 'base64'): Uint8Array };
  }).Buffer;
  if (!bufferConstructor) {
    throw new ProtocolError('unsupported_method', 'No base64 decoder is available.');
  }
  return new Uint8Array(bufferConstructor.from(value, 'base64'));
}

function walletMethodUrl(wallet: EncryptedDeeplinkWalletId, method: string): URL {
  return new URL(`https://${WALLET_HOSTS[wallet]}/ul/v1/${method}`);
}

function walletLabel(wallet: EncryptedDeeplinkWalletId): string {
  return wallet === 'phantom' ? 'Phantom' : 'Solflare';
}

function findWalletEncryptionKey(
  wallet: EncryptedDeeplinkWalletId,
  params: URLSearchParams,
): { alias: string; value: string } | null {
  const aliases = new Set<string>([
    ...WALLET_ENCRYPTION_KEY_ALIASES[wallet],
    ...WALLET_ENCRYPTION_KEY_ALIASES.phantom,
    ...WALLET_ENCRYPTION_KEY_ALIASES.solflare,
  ]);
  for (const alias of aliases) {
    const value = params.get(alias);
    if (value) return { alias, value };
  }
  return null;
}

function decryptPayloadWithBox(
  params: URLSearchParams,
  walletPublicKey: Uint8Array,
  dappSecretKey: Uint8Array,
  label: string,
): Record<string, unknown> {
  const nonce = requiredBase58Param(params, 'nonce');
  const data = requiredBase58Param(params, 'data');
  assertNonce(nonce);
  const plaintext = nacl.box.open(data, nonce, walletPublicKey, dappSecretKey);
  if (!plaintext) {
    throw new ProtocolError('unauthorized', `Unable to decrypt ${label}.`);
  }
  return parseJsonObject(plaintext, label);
}

function requiredBase58Param(params: URLSearchParams, key: string): Uint8Array {
  const value = params.get(key);
  if (!value) {
    throw new ProtocolError('invalid_request', `Wallet callback is missing ${key}.`);
  }
  return decodeBase58(value, key);
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== nacl.box.nonceLength) {
    throw new ProtocolError('invalid_request', 'Wallet callback nonce has invalid length.');
  }
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProtocolError('invalid_request', `${label} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProtocolError('invalid_request', `${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, field: string, label: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError('invalid_request', `Wallet ${label} is missing ${field}.`);
  }
  return value;
}

function decodeSigningRequestBytes(request: SigningRequest): Uint8Array {
  switch (request.payload.encoding) {
    case 'utf8':
      return new TextEncoder().encode(request.payload.data);
    case 'base64':
      return decodeBase64Bytes(request.payload.data);
  }
}

function decodeBase58(value: string, label: string): Uint8Array {
  try {
    return bs58.decode(value);
  } catch {
    throw new ProtocolError('invalid_request', `Invalid base58 ${label}.`);
  }
}

function walletErrorPayloadFromParams(params: URLSearchParams): ProtocolErrorPayload | null {
  const code = params.get('errorCode') ?? params.get('error_code');
  if (!code) return null;
  const message = params.get('errorMessage') ?? params.get('error_message') ?? 'Wallet rejected the request.';
  const normalized = code.trim().toUpperCase();
  const mappedCode =
    normalized.includes('USER_REJECTED') || normalized.includes('REJECT')
      ? 'user_rejected'
      : normalized.includes('INVALID_SESSION')
        ? 'unauthorized'
        : normalized.includes('UNSUPPORTED')
          ? 'unsupported_method'
          : normalized.includes('CLUSTER')
            ? 'cluster_mismatch'
            : 'wallet_unreachable';
  return {
    code: mappedCode,
    message,
    recoverable: mappedCode !== 'user_rejected',
  };
}
