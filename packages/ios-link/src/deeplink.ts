import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { ProtocolError, type Cluster } from '@solana-agent-wallet-adapter/core';

export type IosDeepLinkWalletId = 'phantom' | 'solflare' | 'backpack';
export type IosWalletId = IosDeepLinkWalletId | 'jupiter';

export interface IosWalletDescriptor {
  id: IosWalletId;
  name: string;
  universalLinkHost?: string;
  customScheme?: string;
  connectPublicKeyParams: ReadonlyArray<string>;
  transport: 'encrypted-deeplink' | 'walletconnect';
  supportsUniversalLinks: boolean;
  supportsCustomScheme: boolean;
  status: 'experimental' | 'supported';
  appStoreUrl: string;
}

export interface IosConnectUrlParams {
  appUrl: string;
  cluster: Cluster;
  dappEncryptionPublicKey: Uint8Array | string;
  redirectLink: string;
}

export interface IosEncryptedUrlParams {
  dappEncryptionPublicKey: Uint8Array | string;
  redirectLink: string;
  payload: Record<string, unknown>;
  sharedSecret: Uint8Array;
  nonce?: Uint8Array;
}

export interface IosConnectCallbackResult {
  publicKey: string;
  session: string;
  sessionBytes: Uint8Array;
  sharedSecret: Uint8Array;
  walletEncryptionPublicKey: Uint8Array;
  walletEncryptionPublicKeyBase58: string;
  walletEncryptionKeyAlias: string;
  decryptPath: 'x25519' | 'ed25519-to-x25519';
}

export interface IosSigningCallbackResult {
  payload: Record<string, unknown>;
  signature?: string;
  signatureBytes?: Uint8Array;
  transaction?: string;
  transactionBytes?: Uint8Array;
}

export const IOS_WALLETS: ReadonlyArray<IosWalletDescriptor> = [
  {
    id: 'phantom',
    name: 'Phantom',
    universalLinkHost: 'phantom.app',
    customScheme: 'phantom',
    connectPublicKeyParams: ['phantom_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
    appStoreUrl: 'https://apps.apple.com/app/phantom-crypto-wallet/id1598432977',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    universalLinkHost: 'solflare.com',
    customScheme: 'solflare',
    connectPublicKeyParams: ['solflare_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
    appStoreUrl: 'https://apps.apple.com/app/solflare-solana-wallet/id1580902717',
  },
  {
    id: 'backpack',
    name: 'Backpack',
    universalLinkHost: 'backpack.app',
    customScheme: 'backpack',
    connectPublicKeyParams: ['backpack_encryption_public_key', 'wallet_encryption_public_key'],
    transport: 'encrypted-deeplink',
    supportsUniversalLinks: true,
    supportsCustomScheme: true,
    status: 'supported',
    appStoreUrl: 'https://apps.apple.com/app/backpack-crypto-wallet/id6445964121',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    connectPublicKeyParams: [],
    transport: 'walletconnect',
    supportsUniversalLinks: false,
    supportsCustomScheme: false,
    status: 'experimental',
    appStoreUrl: 'https://apps.apple.com/app/jupiter-exchange-solana/id6484069059',
  },
] as const;

const CONNECT_METHOD = 'connect';
const SIGN_MESSAGE_METHOD = 'signMessage';
const SIGN_TRANSACTION_METHOD = 'signTransaction';

export function iosWalletDescriptor(id: IosWalletId): IosWalletDescriptor | undefined {
  return IOS_WALLETS.find((wallet) => wallet.id === id);
}

export function iosDeepLinkWalletDescriptor(id: IosDeepLinkWalletId): IosWalletDescriptor {
  const wallet = iosWalletDescriptor(id);
  if (!wallet || wallet.transport !== 'encrypted-deeplink') {
    throw new ProtocolError('unsupported_method', `Unsupported encrypted iOS deeplink wallet: ${id}`);
  }
  return wallet;
}

export function listIosWallets(): ReadonlyArray<IosWalletDescriptor> {
  return IOS_WALLETS;
}

export function listIosDeepLinkWallets(): ReadonlyArray<IosWalletDescriptor> {
  return IOS_WALLETS.filter((wallet) => wallet.transport === 'encrypted-deeplink');
}

export function buildIosConnectUrl(walletId: IosDeepLinkWalletId, params: IosConnectUrlParams): string {
  const provider = iosDeepLinkWalletDescriptor(walletId);
  const url = providerUrl(provider, CONNECT_METHOD);
  applyIosConnectParams(url, params);
  return url.toString();
}

export function buildIosConnectUrlCandidates(walletId: IosDeepLinkWalletId, params: IosConnectUrlParams): string[] {
  const provider = iosDeepLinkWalletDescriptor(walletId);
  return providerUrlCandidates(provider, CONNECT_METHOD).map((url) => {
    applyIosConnectParams(url, params);
    return url.toString();
  });
}

export function buildIosSignMessageUrl(params: IosEncryptedUrlParams & { walletId: IosDeepLinkWalletId }): string {
  return buildIosEncryptedUrl(params.walletId, SIGN_MESSAGE_METHOD, params);
}

export function buildIosSignTransactionUrl(params: IosEncryptedUrlParams & { walletId: IosDeepLinkWalletId }): string {
  return buildIosEncryptedUrl(params.walletId, SIGN_TRANSACTION_METHOD, params);
}

export function buildIosSignMessageUrlCandidates(params: IosEncryptedUrlParams & { walletId: IosDeepLinkWalletId }): string[] {
  return buildIosEncryptedUrlCandidates(params.walletId, SIGN_MESSAGE_METHOD, params);
}

export function buildIosSignTransactionUrlCandidates(params: IosEncryptedUrlParams & { walletId: IosDeepLinkWalletId }): string[] {
  return buildIosEncryptedUrlCandidates(params.walletId, SIGN_TRANSACTION_METHOD, params);
}

export function buildIosEncryptedUrl(
  walletId: IosDeepLinkWalletId,
  method: typeof SIGN_MESSAGE_METHOD | typeof SIGN_TRANSACTION_METHOD | string,
  params: IosEncryptedUrlParams,
): string {
  const provider = iosDeepLinkWalletDescriptor(walletId);
  const nonce = params.nonce ?? nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const encrypted = nacl.box.after(plaintext, nonce, params.sharedSecret);
  const url = providerUrl(provider, method);
  applyIosEncryptedParams(url, params, nonce, encrypted);
  return url.toString();
}

export function buildIosEncryptedUrlCandidates(
  walletId: IosDeepLinkWalletId,
  method: typeof SIGN_MESSAGE_METHOD | typeof SIGN_TRANSACTION_METHOD | string,
  params: IosEncryptedUrlParams,
): string[] {
  const provider = iosDeepLinkWalletDescriptor(walletId);
  const nonce = params.nonce ?? nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify(params.payload));
  const encrypted = nacl.box.after(plaintext, nonce, params.sharedSecret);
  return providerUrlCandidates(provider, method).map((url) => {
    applyIosEncryptedParams(url, params, nonce, encrypted);
    return url.toString();
  });
}

export function parseIosConnectCallback(
  walletId: IosDeepLinkWalletId,
  callbackUrl: string | URL,
  dappSecretKey: Uint8Array,
): IosConnectCallbackResult {
  const url = cleanUrl(callbackUrl);
  const walletError = walletErrorFromCallback(url);
  if (walletError) {
    throw walletError;
  }
  const provider = iosDeepLinkWalletDescriptor(walletId);
  const params = url.searchParams;
  const walletKey = findWalletEncryptionKey(params, provider);
  if (!walletKey) {
    throw new ProtocolError('invalid_request', 'iOS connect callback is missing wallet encryption public key.');
  }
  const walletEncryptionPublicKey = decodeBase58(walletKey.value, 'wallet encryption public key');
  const nonce = requiredBase58Param(params, 'nonce');
  const data = requiredBase58Param(params, 'data');
  assertNonceLength(nonce);

  const standardSharedSecret = nacl.box.before(walletEncryptionPublicKey, dappSecretKey);
  const standardPayload = decryptPayloadAfter(data, nonce, standardSharedSecret);
  if (standardPayload) {
    return connectResultFromPayload(standardPayload, {
      sharedSecret: standardSharedSecret,
      walletEncryptionPublicKey,
      walletEncryptionKeyAlias: walletKey.alias,
      decryptPath: 'x25519',
    });
  }

  const converted = ed25519PubToX25519(walletEncryptionPublicKey);
  if (converted) {
    const convertedSharedSecret = nacl.box.before(converted, dappSecretKey);
    const convertedPayload = decryptPayloadAfter(data, nonce, convertedSharedSecret);
    if (convertedPayload) {
      return connectResultFromPayload(convertedPayload, {
        sharedSecret: convertedSharedSecret,
        walletEncryptionPublicKey: converted,
        walletEncryptionKeyAlias: walletKey.alias,
        decryptPath: 'ed25519-to-x25519',
      });
    }
  }

  throw new ProtocolError('unauthorized', 'Unable to decrypt iOS wallet connect response.');
}

export function parseIosSigningCallback(
  callbackUrl: string | URL,
  sharedSecret: Uint8Array,
): IosSigningCallbackResult {
  const url = cleanUrl(callbackUrl);
  const walletError = walletErrorFromCallback(url);
  if (walletError) {
    throw walletError;
  }
  const nonce = requiredBase58Param(url.searchParams, 'nonce');
  const data = requiredBase58Param(url.searchParams, 'data');
  assertNonceLength(nonce);
  const payload = decryptPayloadAfter(data, nonce, sharedSecret);
  if (!payload) {
    throw new ProtocolError('unauthorized', 'Unable to decrypt iOS wallet signing response.');
  }
  const signature = optionalString(payload, 'signature');
  const transaction = optionalString(payload, 'transaction');
  return {
    payload,
    ...(signature !== undefined && {
      signature,
      signatureBytes: decodeBase58(signature, 'signature'),
    }),
    ...(transaction !== undefined && {
      transaction,
      transactionBytes: decodeBase58(transaction, 'transaction'),
    }),
  };
}

export function makeIosRedirect(baseScheme: string, phase: 'connect' | 'sign', requestId: string): string {
  const scheme = baseScheme.replace(/:\/+$/, '').replace(/:$/, '');
  const url = new URL(`${scheme}://callback/${phase}`);
  url.searchParams.set('requestId', requestId);
  url.searchParams.set('phase', phase);
  return url.toString();
}

export function isIosCallbackUrl(callbackUrl: string | URL, phase?: 'connect' | 'sign'): boolean {
  try {
    const url = cleanUrl(callbackUrl);
    const explicitPhase = url.searchParams.get('phase');
    const matchedPhase =
      explicitPhase === phase ||
      url.pathname.endsWith(`/${phase}`) ||
      url.pathname.endsWith(`/ios/callback/${phase}`);
    if (phase) return matchedPhase;
    return (
      explicitPhase === 'connect' ||
      explicitPhase === 'sign' ||
      url.pathname.endsWith('/connect') ||
      url.pathname.endsWith('/sign') ||
      url.pathname.endsWith('/ios/callback/connect') ||
      url.pathname.endsWith('/ios/callback/sign')
    );
  } catch {
    return false;
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const bufferConstructor = (globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: 'base64'): string } } }).Buffer;
  if (!bufferConstructor) {
    throw new ProtocolError('unsupported_method', 'No base64 encoder is available in this runtime.');
  }
  return bufferConstructor.from(bytes).toString('base64');
}

export function decodeBase64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    return output;
  }
  const bufferConstructor = (globalThis as { Buffer?: { from(value: string, encoding: 'base64'): Uint8Array } }).Buffer;
  if (!bufferConstructor) {
    throw new ProtocolError('unsupported_method', 'No base64 decoder is available in this runtime.');
  }
  return new Uint8Array(bufferConstructor.from(value, 'base64'));
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function connectResultFromPayload(
  payload: Record<string, unknown>,
  context: {
    sharedSecret: Uint8Array;
    walletEncryptionPublicKey: Uint8Array;
    walletEncryptionKeyAlias: string;
    decryptPath: IosConnectCallbackResult['decryptPath'];
  },
): IosConnectCallbackResult {
  const publicKey = requiredString(payload, 'public_key');
  const session = requiredString(payload, 'session');
  return {
    publicKey,
    session,
    sessionBytes: decodeBase58(session, 'session'),
    sharedSecret: context.sharedSecret,
    walletEncryptionPublicKey: context.walletEncryptionPublicKey,
    walletEncryptionPublicKeyBase58: bs58.encode(context.walletEncryptionPublicKey),
    walletEncryptionKeyAlias: context.walletEncryptionKeyAlias,
    decryptPath: context.decryptPath,
  };
}

function providerUrl(provider: IosWalletDescriptor, method: string): URL {
  if (!provider.universalLinkHost) {
    throw new ProtocolError('unsupported_method', `${provider.name} does not expose encrypted iOS deeplinks.`);
  }
  return new URL(`https://${provider.universalLinkHost}/ul/v1/${method}`);
}

function providerUrlCandidates(provider: IosWalletDescriptor, method: string): URL[] {
  return [providerUrl(provider, method)];
}

function applyIosConnectParams(url: URL, params: IosConnectUrlParams): void {
  url.searchParams.set('app_url', params.appUrl);
  url.searchParams.set('dapp_encryption_public_key', encodePublicKey(params.dappEncryptionPublicKey));
  url.searchParams.set('redirect_link', params.redirectLink);
  url.searchParams.set('cluster', params.cluster);
}

function applyIosEncryptedParams(
  url: URL,
  params: IosEncryptedUrlParams,
  nonce: Uint8Array,
  encrypted: Uint8Array,
): void {
  url.searchParams.set('dapp_encryption_public_key', encodePublicKey(params.dappEncryptionPublicKey));
  url.searchParams.set('nonce', bs58.encode(nonce));
  url.searchParams.set('redirect_link', params.redirectLink);
  url.searchParams.set('payload', bs58.encode(encrypted));
}

function encodePublicKey(value: Uint8Array | string): string {
  return typeof value === 'string' ? value : bs58.encode(value);
}

function cleanUrl(value: string | URL): URL {
  const raw = typeof value === 'string' ? value : value.toString();
  return new URL(raw.replace(/#$/, ''));
}

function findWalletEncryptionKey(
  params: URLSearchParams,
  provider: IosWalletDescriptor,
): { alias: string; value: string } | null {
  for (const alias of walletEncryptionKeyAliases(provider)) {
    const value = params.get(alias);
    if (value) {
      return { alias, value };
    }
  }
  return null;
}

function walletEncryptionKeyAliases(provider: IosWalletDescriptor): ReadonlyArray<string> {
  const aliases = new Set<string>(provider.connectPublicKeyParams);
  for (const wallet of IOS_WALLETS) {
    if (wallet.transport !== 'encrypted-deeplink') {
      continue;
    }
    for (const alias of wallet.connectPublicKeyParams) {
      aliases.add(alias);
    }
  }
  aliases.add('wallet_encryption_public_key');
  return [...aliases];
}

function requiredBase58Param(params: URLSearchParams, key: string): Uint8Array {
  const value = params.get(key);
  if (!value) {
    throw new ProtocolError('invalid_request', `iOS wallet callback is missing ${key}.`);
  }
  return decodeBase58(value, key);
}

function decodeBase58(value: string, label: string): Uint8Array {
  try {
    return bs58.decode(value);
  } catch {
    throw new ProtocolError('invalid_request', `Invalid base58 ${label}.`);
  }
}

function assertNonceLength(nonce: Uint8Array): void {
  if (nonce.length !== nacl.box.nonceLength) {
    throw new ProtocolError('invalid_request', 'iOS wallet callback nonce has invalid length.');
  }
}

function decryptPayloadAfter(
  encryptedBytes: Uint8Array,
  nonceBytes: Uint8Array,
  sharedSecret: Uint8Array,
): Record<string, unknown> | null {
  const decrypted = nacl.box.open.after(encryptedBytes, nonceBytes, sharedSecret);
  if (!decrypted) {
    return null;
  }
  return JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `iOS wallet response is missing ${key}.`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value ? value : undefined;
}

function walletErrorFromCallback(url: URL): ProtocolError | null {
  const code = url.searchParams.get('errorCode');
  if (!code) return null;
  const message = url.searchParams.get('errorMessage') ?? 'iOS wallet returned an error.';
  switch (code) {
    case 'USER_REJECTED':
      return new ProtocolError('user_rejected', message);
    case 'INVALID_SESSION':
      return new ProtocolError('unauthorized', message);
    case 'UNSUPPORTED_METHOD':
      return new ProtocolError('unsupported_method', message);
    case 'CLUSTER_MISMATCH':
      return new ProtocolError('cluster_mismatch', message);
    case 'WALLET_UNREACHABLE':
      return new ProtocolError('wallet_unreachable', message);
    default:
      return new ProtocolError('wallet_unreachable', `${message} (wallet code: ${code})`);
  }
}

function ed25519PubToX25519(edPub: Uint8Array): Uint8Array | null {
  const lowlevel = (nacl as unknown as { lowlevel?: NaclLowLevel }).lowlevel;
  if (!lowlevel) {
    return null;
  }
  const { gf, A, Z, M, inv25519, pack25519, unpackneg } = lowlevel;
  const q = [gf(), gf(), gf(), gf()];
  if (unpackneg(q, edPub)) return null;

  const y = q[1];
  if (!y) return null;
  const one = gf([1]);
  const num = gf();
  const den = gf();
  const out = new Uint8Array(32);

  A(num, one, y);
  Z(den, one, y);
  inv25519(den, den);
  M(num, num, den);
  pack25519(out, num);

  return out;
}

interface NaclLowLevel {
  gf(init?: number[]): number[];
  A(output: number[], a: number[], b: number[]): void;
  Z(output: number[], a: number[], b: number[]): void;
  M(output: number[], a: number[], b: number[]): void;
  inv25519(output: number[], input: number[]): void;
  pack25519(output: Uint8Array, input: number[]): void;
  unpackneg(output: number[][], input: Uint8Array): number;
}
