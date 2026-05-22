// Register / unregister Ledger Wallet Standard wallets with the global
// `getWallets()` registry. Idempotent per derivation-path|address key so
// re-pairing the same account is a replace, not a duplicate.

import { getWallets } from '@wallet-standard/app';
import type { Wallet } from '@wallet-standard/base';

import { createLedgerWallet, type CreateLedgerWalletOptions } from './wallet.js';

interface RegistryEntry {
  wallet: Wallet;
  unregister: () => void;
}

const registered = new Map<string, RegistryEntry>();

function registryKey(opts: CreateLedgerWalletOptions): string {
  return `${opts.derivationPath}|${opts.address}`;
}

export function registerLedgerWallet(
  opts: CreateLedgerWalletOptions,
): { wallet: Wallet; unregister: () => void } {
  const key = registryKey(opts);
  const existing = registered.get(key);
  if (existing) {
    // Same derivation path + address but (typically) a fresh `ipc` binding
    // from a re-pair after a device disconnect. We cannot reuse the cached
    // wallet object: its `signMessage` / `signTransaction` features
    // captured the previous `ipc` (and `derivationPath`) in closure at
    // construction time, so signing would route through the dead IPC and
    // silently fail. Tear down the old entry; the fresh-wallet code below
    // creates a new one with the new closures.
    existing.unregister();
  }

  const wallet = createLedgerWallet(opts);
  const api = getWallets();
  const unregister = api.register(wallet);
  const wrapped = () => {
    if (!registered.has(key)) return;
    unregister();
    registered.delete(key);
  };
  const entry: RegistryEntry = { wallet, unregister: wrapped };
  registered.set(key, entry);
  return entry;
}

export function unregisterAllLedgerWallets(): void {
  for (const entry of Array.from(registered.values())) {
    entry.unregister();
  }
}

/** Test-only — forget all tracking without invoking unregister. */
export function resetLedgerRegistry(): void {
  registered.clear();
}
