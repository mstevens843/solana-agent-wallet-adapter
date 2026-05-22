// Boot-time registration of the Agentic Wallet with the Wallet Standard
// global registry. Call once from `apps/browser-demo/src/main.ts` (next to
// the existing `registerAgentMobileWalletAdapter()` call). The registration
// is:
//
//   - **Tauri-gated**: skips on non-Tauri surfaces. The wallet only works
//     when the Tauri IPC is reachable.
//   - **Idempotent**: calling twice does nothing the second time. Returns the
//     same unregister callback both times.
//
// Tests in `wallet.test.ts` cover the registration without the global
// registry by driving the `Wallet` object directly.

import { getWallets } from '@wallet-standard/app';

import {
  createTauriWalletIpc,
  detectTauriInvoke,
  type WalletIpc,
} from './ipc.js';
import { createAgenticWallet } from './wallet.js';

type UnregisterFn = () => void;

let cachedUnregister: UnregisterFn | null = null;

export interface RegisterAgenticWalletOptions {
  /**
   * Override the IPC transport. Production callers omit this; tests use it
   * to drive the wallet without touching the global Tauri object.
   */
  ipc?: WalletIpc;
  /**
   * When `true`, register even if Tauri isn't detected. Tests use this to
   * exercise the global registry round-trip; production callers omit it.
   */
  force?: boolean;
}

/**
 * Register the Agentic Wallet with the Wallet Standard global registry. The
 * existing wallet picker (`listAvailableWallets()` in
 * `packages/wallet-standard-web/src/discovery.ts`) will discover it on the
 * next call. Returns an `unregister()` callback (the same one for repeated
 * calls).
 *
 * Outside Tauri, this is a no-op and returns `() => undefined` — callers can
 * always call this on boot without surface gating.
 */
export function registerAgenticWallet(
  options: RegisterAgenticWalletOptions = {},
): UnregisterFn {
  if (cachedUnregister) return cachedUnregister;

  let ipc = options.ipc;
  if (!ipc) {
    const invoke = detectTauriInvoke();
    if (!invoke) {
      if (!options.force) return () => undefined;
      throw new Error(
        'registerAgenticWallet: no Tauri invoke detected and no ipc override provided',
      );
    }
    ipc = createTauriWalletIpc(invoke);
  }

  const wallet = createAgenticWallet(ipc);
  const api = getWallets();
  const unregister = api.register(wallet);

  cachedUnregister = () => {
    if (cachedUnregister) {
      unregister();
      cachedUnregister = null;
    }
  };
  return cachedUnregister;
}

/**
 * Test-only: forget the cached registration so a subsequent
 * `registerAgenticWallet()` call re-registers. Production has no reason to
 * call this.
 */
export function resetAgenticWalletRegistration(): void {
  cachedUnregister = null;
}
