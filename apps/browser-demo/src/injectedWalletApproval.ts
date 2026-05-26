import bs58 from 'bs58';

import {
  ProtocolError,
  type ApprovalResource,
  type SigningRequest,
} from '@solana-agent-wallet-adapter/core';
import { Transaction, VersionedTransaction } from '@solana/web3.js';

import type { EncryptedDeeplinkWalletId } from './encryptedDeeplink.js';

type WalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: unknown;
  connect?: (input?: unknown) => Promise<{ publicKey?: unknown } | void>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<unknown>;
  signTransaction?: (transaction: Transaction | VersionedTransaction) => Promise<unknown>;
  signAndSendTransaction?: (
    transaction: Transaction | VersionedTransaction,
    options?: unknown,
  ) => Promise<unknown>;
};

export interface InjectedWalletApprovalOptions {
  wallet: EncryptedDeeplinkWalletId;
  sessionAddress: string;
  request: SigningRequest;
  sendRawTransaction?: (transaction: Uint8Array) => Promise<string>;
  windowLike?: unknown;
  provider?: unknown;
}

export async function approveWithInjectedWallet(
  options: InjectedWalletApprovalOptions,
): Promise<ApprovalResource | null> {
  const provider = providerOrNull(options.provider)
    ?? injectedProviderForWallet(options.wallet, options.windowLike ?? globalThis.window);
  if (!provider) return null;

  const providerAddress = await currentProviderAddress(provider);
  if (!providerAddress) return null;
  if (providerAddress !== options.sessionAddress) {
    return approvalFromError(
      options.request.id,
      new ProtocolError(
        'unauthorized',
        `${walletLabel(options.wallet)} in-app browser is connected to ${short(providerAddress)}, but the QR session is ${short(options.sessionAddress)}.`,
      ),
    );
  }

  try {
    switch (options.request.kind) {
      case 'sign_message':
        if (typeof provider.signMessage !== 'function') return null;
        return {
          requestId: options.request.id,
          status: 'approved',
          result: {
            signature: signatureFromProviderResult(
              await provider.signMessage(decodeSigningPayload(options.request), 'utf8'),
            ),
          },
        };
      case 'sign_transaction':
        if (typeof provider.signTransaction !== 'function') return null;
        return {
          requestId: options.request.id,
          status: 'approved',
          result: {
            signature: encodeBase64(
              serializeSignedTransaction(
                await provider.signTransaction(transactionForProvider(options.request)),
              ),
            ),
          },
        };
      case 'sign_and_send_transaction':
        return await approveInjectedSignAndSend(provider, options);
    }
  } catch (err) {
    return approvalFromError(options.request.id, err);
  }
}

async function approveInjectedSignAndSend(
  provider: WalletProvider,
  options: InjectedWalletApprovalOptions,
): Promise<ApprovalResource | null> {
  const transaction = transactionForProvider(options.request);
  if (typeof provider.signAndSendTransaction === 'function') {
    const result = await provider.signAndSendTransaction(transaction, {
      preflightCommitment: 'confirmed',
      commitment: 'confirmed',
      maxRetries: 3,
    });
    const signature = txidFromProviderResult(result);
    return {
      requestId: options.request.id,
      status: 'approved',
      result: { signature, txid: signature },
    };
  }
  if (typeof provider.signTransaction === 'function' && options.sendRawTransaction) {
    const signedTransaction = serializeSignedTransaction(
      await provider.signTransaction(transaction),
    );
    const txid = await options.sendRawTransaction(signedTransaction);
    return {
      requestId: options.request.id,
      status: 'approved',
      result: { signature: txid, txid },
    };
  }
  return null;
}

function injectedProviderForWallet(
  wallet: EncryptedDeeplinkWalletId,
  windowLike: unknown,
): WalletProvider | null {
  if (!windowLike || typeof windowLike !== 'object') return null;
  const record = windowLike as {
    solana?: unknown;
    solflare?: unknown;
    phantom?: { solana?: unknown };
  };
  const explicit = wallet === 'phantom' ? record.phantom?.solana : record.solflare;
  const explicitProvider = providerOrNull(explicit);
  if (explicitProvider) return explicitProvider;

  const solana = providerOrNull(record.solana);
  if (!solana) return null;
  if (wallet === 'phantom' && solana.isPhantom) return solana;
  if (wallet === 'solflare' && solana.isSolflare) return solana;
  return null;
}

function providerOrNull(value: unknown): WalletProvider | null {
  return value && typeof value === 'object' ? value as WalletProvider : null;
}

async function currentProviderAddress(
  provider: WalletProvider,
): Promise<string> {
  const direct = publicKeyToString(provider.publicKey);
  if (direct) return direct;
  if (typeof provider.connect !== 'function') return '';
  try {
    const result = await provider.connect({ onlyIfTrusted: true });
    return publicKeyToString(result?.publicKey) || publicKeyToString(provider.publicKey);
  } catch {
    return '';
  }
}

function publicKeyToString(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return bs58.encode(value);
  if (typeof value === 'object') {
    const record = value as { toBase58?: () => string; toString?: () => string };
    if (typeof record.toBase58 === 'function') return record.toBase58();
    if (typeof record.toString === 'function') {
      const text = record.toString();
      return text === '[object Object]' ? '' : text;
    }
  }
  return '';
}

function transactionForProvider(request: SigningRequest): Transaction | VersionedTransaction {
  const bytes = decodeSigningPayload(request);
  const versioned = VersionedTransaction.deserialize(bytes);
  return versioned.message.version === 'legacy'
    ? Transaction.from(bytes)
    : versioned;
}

function serializeSignedTransaction(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === 'object') {
    const record = value as {
      signedTransaction?: unknown;
      transaction?: unknown;
      serialize?: unknown;
    };
    if (record.signedTransaction) return serializeSignedTransaction(record.signedTransaction);
    if (record.transaction) return serializeSignedTransaction(record.transaction);
    if (value instanceof VersionedTransaction) return value.serialize();
    if (value instanceof Transaction) {
      return value.serialize({ requireAllSignatures: false, verifySignatures: false });
    }
    if (typeof record.serialize === 'function') {
      return serializeWithFallback(record as { serialize: (...args: unknown[]) => Uint8Array });
    }
  }
  throw new ProtocolError('wallet_unreachable', 'Wallet returned no signed transaction.');
}

function serializeWithFallback(value: { serialize: (...args: unknown[]) => Uint8Array }): Uint8Array {
  try {
    return value.serialize();
  } catch {
    return value.serialize({ requireAllSignatures: false, verifySignatures: false });
  }
}

function signatureFromProviderResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return bs58.encode(value);
  if (value && typeof value === 'object') {
    const record = value as { signature?: unknown };
    if (record.signature !== undefined) return signatureFromProviderResult(record.signature);
  }
  throw new ProtocolError('wallet_unreachable', 'Wallet returned no signature.');
}

function txidFromProviderResult(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as { txid?: unknown; signature?: unknown };
    if (record.txid !== undefined) return signatureFromProviderResult(record.txid);
    if (record.signature !== undefined) return signatureFromProviderResult(record.signature);
  }
  return signatureFromProviderResult(value);
}

function decodeSigningPayload(request: SigningRequest): Uint8Array {
  if (request.payload.encoding === 'utf8') {
    return new TextEncoder().encode(request.payload.data);
  }
  return decodeBase64(request.payload.data);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }
  const bufferConstructor = (globalThis as {
    Buffer?: { from(value: string, encoding: 'base64'): Uint8Array };
  }).Buffer;
  if (!bufferConstructor) {
    throw new ProtocolError('unsupported_method', 'No base64 decoder is available.');
  }
  return new Uint8Array(bufferConstructor.from(value, 'base64'));
}

function encodeBase64(bytes: Uint8Array): string {
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

function approvalFromError(requestId: string, err: unknown): ApprovalResource {
  const protocolErr = err instanceof ProtocolError
    ? err
    : providerErrorToProtocolError(err);
  return {
    requestId,
    status: protocolErr.code === 'user_rejected' ? 'rejected' : 'failed',
    error: protocolErr.toPayload(),
  };
}

function providerErrorToProtocolError(err: unknown): ProtocolError {
  const record = err && typeof err === 'object' ? err as { code?: unknown; message?: unknown } : {};
  const code = typeof record.code === 'number' || typeof record.code === 'string'
    ? String(record.code)
    : '';
  const message = typeof record.message === 'string'
    ? record.message
    : err instanceof Error
      ? err.message
      : String(err || 'Wallet request failed.');
  const normalized = `${code} ${message}`.toLowerCase();
  if (code === '4001' || normalized.includes('user rejected') || normalized.includes('reject') || normalized.includes('cancel')) {
    return new ProtocolError('user_rejected', message);
  }
  if (code === '4100' || normalized.includes('unauthorized')) {
    return new ProtocolError('unauthorized', message);
  }
  if (code === '-32601' || normalized.includes('unsupported') || normalized.includes('not implemented')) {
    return new ProtocolError('unsupported_method', message);
  }
  return new ProtocolError('wallet_unreachable', message);
}

function walletLabel(wallet: EncryptedDeeplinkWalletId): string {
  return wallet === 'phantom' ? 'Phantom' : 'Solflare';
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}...${value.slice(-4)}` : value;
}
