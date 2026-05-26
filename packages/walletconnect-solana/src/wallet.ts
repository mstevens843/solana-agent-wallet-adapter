// Wallet Standard adapter backed by a WalletConnect v2 Solana session.
//
// Mirrors the embedded-wallet adapter (`packages/embedded-wallet/src/
// wallet.ts`) — same Wallet interface, same feature shapes — but each
// feature method routes through `WalletConnectSolanaClient` instead of
// Tauri IPC. One wallet object per WC session topic.

import type {
  IdentifierArray,
  Wallet,
  WalletAccount,
  WalletIcon,
} from '@wallet-standard/base';
import type {
  SolanaSignMessageFeature,
  SolanaSignMessageOutput,
  SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import type {
  StandardConnectFeature,
  StandardDisconnectFeature,
  StandardEventsFeature,
  StandardEventsListeners,
} from '@wallet-standard/features';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import { clusterForChainId, walletStandardChainForCluster } from './chains.js';
import type {
  WalletConnectSession,
  WalletConnectSignTransactionResult,
  WalletConnectSolanaClient,
} from './client.js';

const ACCOUNT_FEATURES: IdentifierArray = [
  'solana:signMessage',
  'solana:signTransaction',
];
const SUPPORTED_TX_VERSIONS = ['legacy', 0] as const;

export interface WalletConnectBrand {
  /** Stable id, e.g. `'phantom'`. */
  id: string;
  /** Human-readable label shown in the picker, e.g. `'Phantom (mobile)'`. */
  name: string;
}

export interface CreateWalletConnectSolanaWalletOptions {
  brand: WalletConnectBrand;
  session: WalletConnectSession;
  client: WalletConnectSolanaClient;
  /**
   * Wallet Standard icon (data URI or HTTPS URL). Caller resolves the brand
   * icon — keeps this package free of asset imports.
   */
  icon: WalletIcon;
}

export function createWalletConnectSolanaWallet(
  options: CreateWalletConnectSolanaWalletOptions,
): Wallet {
  const { brand, session, client, icon } = options;
  const cluster = clusterForChainId(session.chainId);
  const chains: IdentifierArray = cluster
    ? [walletStandardChainForCluster(cluster)]
    : ['solana:mainnet'];

  const account: WalletAccount = {
    address: session.address,
    publicKey: bs58.decode(session.address),
    chains,
    features: ACCOUNT_FEATURES,
  };

  let accounts: readonly WalletAccount[] = [];
  const listeners = new Set<StandardEventsListeners['change']>();

  function emitChange(): void {
    const props = { accounts };
    for (const listener of listeners) {
      try {
        listener(props);
      } catch {
        // listener errors are not our concern
      }
    }
  }

  function ensureAccount(address: string): WalletAccount {
    if (address !== account.address) {
      throw new Error(`Address ${address} is not authorized on this wallet.`);
    }
    return account;
  }

  const connectFeature: StandardConnectFeature['standard:connect'] = {
    version: '1.0.0',
    connect: async (input) => {
      if (accounts.length === 0) {
        accounts = [account];
        emitChange();
      }
      void input;
      return { accounts };
    },
  };

  const disconnectFeature: StandardDisconnectFeature['standard:disconnect'] = {
    version: '1.0.0',
    disconnect: async () => {
      const hadAccounts = accounts.length > 0;
      accounts = [];
      try {
        await client.disconnect(session.topic);
      } catch {
        // Best-effort: peer may already be gone.
      }
      if (hadAccounts) emitChange();
    },
  };

  const eventsFeature: StandardEventsFeature['standard:events'] = {
    version: '1.0.0',
    on: (event, listener) => {
      if (event !== 'change') return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const signMessageFeature: SolanaSignMessageFeature['solana:signMessage'] = {
    version: '1.1.0',
    signMessage: async (...inputs) => {
      const outputs: SolanaSignMessageOutput[] = [];
      for (const input of inputs) {
        const acc = ensureAccount(input.account.address);
        const signature = await client.signMessage({
          topic: session.topic,
          chainId: session.chainId,
          pubkey: acc.address,
          message: input.message,
        });
        if (signature.length !== 64) {
          throw new Error(
            `WalletConnect signature length unexpected: ${signature.length}`,
          );
        }
        outputs.push({
          signedMessage: input.message,
          signature,
          signatureType: 'ed25519',
        });
      }
      return outputs;
    },
  };

  const signTransactionFeature: SolanaSignTransactionFeature['solana:signTransaction'] =
    {
      version: '1.0.0',
      supportedTransactionVersions: SUPPORTED_TX_VERSIONS,
      signTransaction: async (...inputs) => {
        const outputs: { signedTransaction: Uint8Array }[] = [];
        for (const input of inputs) {
          const acc = ensureAccount(input.account.address);
          const base64Tx = bytesToBase64(input.transaction);
          const result = await client.signTransaction({
            topic: session.topic,
            chainId: session.chainId,
            transactionBase64: base64Tx,
          });
          outputs.push({
            signedTransaction: signedTransactionBytesFromWalletConnect(
              input.transaction,
              acc.address,
              result,
            ),
          });
        }
        return outputs;
      },
    };

  return {
    get version() {
      return '1.0.0' as const;
    },
    get name() {
      return brand.name;
    },
    get icon(): WalletIcon {
      return icon;
    },
    get chains() {
      return chains;
    },
    get features() {
      return {
        'standard:connect': connectFeature,
        'standard:disconnect': disconnectFeature,
        'standard:events': eventsFeature,
        'solana:signMessage': signMessageFeature,
        'solana:signTransaction': signTransactionFeature,
      };
    },
    get accounts() {
      return accounts;
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  if (typeof btoa !== 'undefined') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function signedTransactionBytesFromWalletConnect(
  unsignedTransaction: Uint8Array,
  signerAddress: string,
  result: WalletConnectSignTransactionResult,
): Uint8Array {
  if (result.transaction) {
    const transactionBytes = tryBase64ToBytes(result.transaction);
    if (transactionBytes && hasReadableTransactionSignature(transactionBytes)) {
      return transactionBytes;
    }
  }

  if (result.signature) {
    return stitchWalletConnectSignature(unsignedTransaction, signerAddress, result.signature);
  }

  if (result.transaction) {
    throw new Error('WalletConnect signTransaction returned transaction bytes without a readable signature.');
  }
  throw new Error('WalletConnect signTransaction returned neither signed transaction bytes nor a transaction signature.');
}

function tryBase64ToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

function hasReadableTransactionSignature(transactionBytes: Uint8Array): boolean {
  try {
    const legacy = Transaction.from(transactionBytes);
    if (legacy.signatures.some((entry) => entry.signature && !isZeroSignature(entry.signature))) {
      return true;
    }
  } catch {
    // Try versioned parsing below.
  }
  try {
    const versioned = VersionedTransaction.deserialize(transactionBytes);
    return versioned.signatures.some((signature) => !isZeroSignature(signature));
  } catch {
    return false;
  }
}

function stitchWalletConnectSignature(
  transactionBytes: Uint8Array,
  signerAddress: string,
  encodedSignature: string,
): Uint8Array {
  const signature = decodeWalletConnectSignature(encodedSignature);
  try {
    const transaction = VersionedTransaction.deserialize(transactionBytes);
    transaction.addSignature(new PublicKey(signerAddress), signature);
    return transaction.serialize();
  } catch (err) {
    throw new Error(
      `WalletConnect signTransaction signature could not be attached to the transaction: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function decodeWalletConnectSignature(encodedSignature: string): Uint8Array {
  let base58Err: unknown;
  try {
    const decoded = bs58.decode(encodedSignature);
    if (decoded.length !== 64) {
      throw new Error(`WalletConnect signTransaction signature length unexpected: ${decoded.length}`);
    }
    return decoded;
  } catch (err) {
    base58Err = err;
    if (err instanceof Error && /length unexpected/.test(err.message)) {
      throw err;
    }
  }

  const decodedBase64 = tryBase64ToBytes(encodedSignature);
  if (decodedBase64) {
    if (decodedBase64.length !== 64) {
      throw new Error(`WalletConnect signTransaction signature length unexpected: ${decodedBase64.length}`);
    }
    return decodedBase64;
  }
  throw new Error(
    `WalletConnect signTransaction returned a malformed signature: ${
      base58Err instanceof Error ? base58Err.message : String(base58Err)
    }`,
  );
}

function isZeroSignature(signature: Uint8Array): boolean {
  return signature.every((byte) => byte === 0);
}
