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
import bs58 from 'bs58';

import { clusterForChainId, walletStandardChainForCluster } from './chains.js';
import type { WalletConnectSession, WalletConnectSolanaClient } from './client.js';

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
          ensureAccount(input.account.address);
          const base64Tx = bytesToBase64(input.transaction);
          const signedBase64 = await client.signTransaction({
            topic: session.topic,
            chainId: session.chainId,
            transactionBase64: base64Tx,
          });
          outputs.push({ signedTransaction: base64ToBytes(signedBase64) });
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
