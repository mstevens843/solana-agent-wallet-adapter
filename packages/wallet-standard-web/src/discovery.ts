import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

import {
  SolanaSignMessage,
  SolanaSignTransaction,
  SolanaSignAndSendTransaction,
} from '@solana/wallet-standard-features';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
} from '@wallet-standard/features';

export interface DiscoveredWallet {
  wallet: Wallet;
  name: string;
  icon: string;
  supportedChains: ReadonlyArray<string>;
  features: {
    connect: boolean;
    disconnect: boolean;
    signMessage: boolean;
    signTransaction: boolean;
    signAndSendTransaction: boolean;
  };
  accounts: ReadonlyArray<WalletAccount>;
}

const SOLANA_CHAIN_PREFIX = 'solana:';

export function listAvailableWallets(): ReadonlyArray<DiscoveredWallet> {
  const { get } = getWallets();
  const described: Array<DiscoveredWallet | null> = get().map(describeWallet);
  return described.filter((entry): entry is DiscoveredWallet => entry !== null);
}

export function requireWallet(name: string): DiscoveredWallet {
  const match = listAvailableWallets().find(
    (entry) => entry.name.toLowerCase() === name.toLowerCase(),
  );
  if (!match) {
    const available = listAvailableWallets()
      .map((entry) => entry.name)
      .join(', ');
    throw new Error(
      `Wallet not found: ${name}. Available wallets: ${available || '(none registered)'}`,
    );
  }
  return match;
}

function describeWallet(wallet: Wallet): DiscoveredWallet | null {
  const supportedChains = wallet.chains.filter((chain) =>
    chain.startsWith(SOLANA_CHAIN_PREFIX),
  );
  if (supportedChains.length === 0) {
    return null;
  }

  const features = wallet.features as Record<string, unknown>;
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(features, key);

  return {
    wallet,
    name: wallet.name,
    icon: wallet.icon,
    supportedChains,
    accounts: wallet.accounts,
    features: {
      connect: has(StandardConnect),
      disconnect: has(StandardDisconnect),
      signMessage: has(SolanaSignMessage),
      signTransaction: has(SolanaSignTransaction),
      signAndSendTransaction: has(SolanaSignAndSendTransaction),
    },
  };
}

export function isStandardEventsCapable(wallet: Wallet): boolean {
  return Object.prototype.hasOwnProperty.call(wallet.features, StandardEvents);
}
