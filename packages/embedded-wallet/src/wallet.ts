// Agentic Wallet — Wallet Standard `Wallet` implementation backed by the
// Tauri Rust signer (Slice A). Once registered with `getWallets().register()`
// the existing wallet picker (`packages/wallet-standard-web/src/discovery.ts`)
// surfaces this alongside Phantom / Backpack / Solflare / etc.
//
// The wallet keeps no key material in JS. Every `connect`, `signMessage`, and
// `signTransaction` goes through the injected `WalletIpc`. The cached
// account only holds the public address + decoded `publicKey` bytes.

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

import { AGENTIC_WALLET_ICON } from './icon.js';
import type { WalletIpc } from './ipc.js';
import {
  base64ToBytes,
  bytesToBase64,
  extractMessageBytes,
  stitchSignature,
} from './transaction.js';

export const AGENTIC_WALLET_NAME = 'Agentic Wallet';

const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const;
const SUPPORTED_TX_VERSIONS = ['legacy', 0] as const;

const ACCOUNT_FEATURES: IdentifierArray = [
  'solana:signMessage',
  'solana:signTransaction',
];

/**
 * Build a stateful Wallet Standard wallet over the injected `WalletIpc`. The
 * returned object can be passed directly to `getWallets().register([wallet])`.
 */
export function createAgenticWallet(ipc: WalletIpc): Wallet {
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

  function makeAccount(address: string): WalletAccount {
    const publicKey = bs58.decode(address);
    return {
      address,
      publicKey,
      chains: SOLANA_CHAINS,
      features: ACCOUNT_FEATURES,
    };
  }

  function getAccount(address: string): WalletAccount {
    const account = accounts.find((a) => a.address === address);
    if (!account) {
      throw new Error(`Address ${address} is not authorized on this wallet.`);
    }
    return account;
  }

  const connectFeature: StandardConnectFeature['standard:connect'] = {
    version: '1.0.0',
    connect: async (input) => {
      const status = await ipc.status();
      // Whenever the wallet is not in an authorized state, the cached
      // `accounts` slot must reflect that — otherwise a previously-resolved
      // `connect()` leaves a stale account on the Wallet Standard `wallet`
      // object even though the underlying wallet has since auto-locked.
      const clearAccounts = (): void => {
        if (accounts.length > 0) {
          accounts = [];
          emitChange();
        }
      };
      if (!status.exists) {
        clearAccounts();
        throw new Error(
          'Agentic Wallet is not created. Create or import a wallet to connect.',
        );
      }
      if (!status.unlocked) {
        clearAccounts();
        if (input?.silent) {
          // Silent connect: don't surface the lock to the dApp.
          return { accounts: [] };
        }
        throw new Error('Agentic Wallet is locked. Unlock to connect.');
      }
      if (!status.address) {
        clearAccounts();
        throw new Error('Agentic Wallet is unlocked but has no address.');
      }
      // Only emit `change` if the account set is actually changing — Wallet
      // Standard consumers expect idempotent connects not to thrash listeners.
      if (accounts.length === 0 || accounts[0]!.address !== status.address) {
        accounts = [makeAccount(status.address)];
        emitChange();
      }
      return { accounts };
    },
  };

  const disconnectFeature: StandardDisconnectFeature['standard:disconnect'] = {
    version: '1.0.0',
    disconnect: async () => {
      if (accounts.length === 0) return;
      accounts = [];
      emitChange();
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
        const account = getAccount(input.account.address);
        const sigB64 = await ipc.signMessage(
          account.address,
          bytesToBase64(input.message),
        );
        const signature = base64ToBytes(sigB64);
        if (signature.length !== 64) {
          throw new Error(
            `Agentic Wallet signature length unexpected: ${signature.length}`,
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
          const account = getAccount(input.account.address);
          const { messageBytes } = extractMessageBytes(input.transaction);
          const sigB64 = await ipc.signTransaction(
            account.address,
            bytesToBase64(messageBytes),
          );
          const signature = base64ToBytes(sigB64);
          const signedTransaction = stitchSignature(
            input.transaction,
            account.address,
            signature,
          );
          outputs.push({ signedTransaction });
        }
        return outputs;
      },
    };

  return {
    get version() {
      return '1.0.0' as const;
    },
    get name() {
      return AGENTIC_WALLET_NAME;
    },
    get icon(): WalletIcon {
      return AGENTIC_WALLET_ICON;
    },
    get chains() {
      return SOLANA_CHAINS;
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
