// Register / unregister WalletConnect-backed Wallet Standard wallets with
// the global `getWallets()` registry. Called by `apps/browser-demo/src/
// main.ts` once a WC session is approved (or restored on launch).
//
// Keying by `${brand.id}|${address}` (NOT topic) so re-pairing the same
// brand+address pair with a fresh topic replaces the previous registration
// instead of creating a phantom-duplicate entry in the picker.

import { getWallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';

import {
  createWalletConnectSolanaWallet,
  type CreateWalletConnectSolanaWalletOptions,
} from './wallet.js';

interface RegistryEntry {
  wallet: Wallet;
  unregister: () => void;
  /** Last-known topic for this entry — used by `unregisterByTopic`. */
  topic: string;
}

function entryKey(options: Pick<CreateWalletConnectSolanaWalletOptions, 'brand' | 'session'>): string {
  return `${options.brand.id}|${options.session.address}`;
}

const registered = new Map<string, RegistryEntry>();

export function registerWalletConnectSolanaWallet(
  options: CreateWalletConnectSolanaWalletOptions,
): { wallet: Wallet; unregister: () => void } {
  const key = entryKey(options);
  const existing = registered.get(key);
  if (existing) {
    // Same brand + address but (typically) a fresh session topic from a
    // re-pair. We cannot reuse the existing wallet object because its
    // `signMessage` / `signTransaction` features captured the previous
    // `session.topic` in closure at construction — signing would route to
    // the dead topic and silently fail. Tear down the old entry; let the
    // fresh-wallet code path below register a new one with the new topic
    // baked into its closures.
    existing.unregister();
  }

  const wallet = createWalletConnectSolanaWallet(options);
  const api = getWallets();
  const unregister = api.register(wallet);
  const wrappedUnregister = () => {
    if (!registered.has(key)) return;
    unregister();
    registered.delete(key);
  };
  const entry: RegistryEntry = {
    wallet,
    unregister: wrappedUnregister,
    topic: options.session.topic,
  };
  registered.set(key, entry);
  return { wallet, unregister: wrappedUnregister };
}

/**
 * Unregister a wallet by WC session topic. Used by the `session_delete` /
 * `session_expire` peer-event handlers in main.ts.
 */
export function unregisterWalletConnectSolanaWallet(topic: string): void {
  for (const entry of Array.from(registered.values())) {
    if (entry.topic === topic) {
      entry.unregister();
      return;
    }
  }
}

export function unregisterAllWalletConnectWallets(): void {
  for (const entry of Array.from(registered.values())) {
    entry.unregister();
  }
}

/** Test-only: forget all internal tracking without calling unregister. */
export function resetWalletConnectRegistry(): void {
  registered.clear();
}
