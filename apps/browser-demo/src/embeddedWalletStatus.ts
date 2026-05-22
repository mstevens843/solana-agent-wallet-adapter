// Periodic poll of the embedded wallet's status, so the UI can detect when
// the Rust auto-lock timer fires (idle timeout) and surface a toast + clear
// `state.address`.
//
// Decoupled from `main.ts` so the polling logic is reusable and testable.
// Returns a stop callback the caller invokes on teardown — currently the
// page lifetime is the boundary, so we don't need to wire teardown into the
// main render loop yet.

import type { WalletIpc, WalletStatus } from '@solana-agent-wallet-adapter/embedded-wallet';

const DEFAULT_INTERVAL_MS = 15_000;

export interface WalletStatusPollHooks {
  /** Called every poll with the latest status (or `null` on transient errors). */
  onStatus(status: WalletStatus | null): void;
  /**
   * Called when a poll reveals the wallet locked itself since the last tick
   * (idle auto-lock). The caller typically clears `state.address` and pushes
   * a toast.
   */
  onAutoLocked?(): void;
  /**
   * Predicate evaluated at the start of every tick. When it returns `false`
   * the IPC call is skipped and `onStatus` is NOT invoked — useful for
   * callers that only care about Agentic status when the user has Agentic
   * selected. The interval keeps ticking, so as soon as the predicate flips
   * back to `true` the next tick fires immediately at the regular cadence.
   * Defaults to always polling.
   */
  shouldPoll?(): boolean;
}

export interface WalletStatusPollOptions {
  intervalMs?: number;
  /** Inject a custom timer for tests; defaults to `globalThis.setInterval`. */
  setInterval?: typeof globalThis.setInterval;
  /** Inject a custom timer for tests; defaults to `globalThis.clearInterval`. */
  clearInterval?: typeof globalThis.clearInterval;
}

export interface WalletStatusPollHandle {
  stop(): void;
}

/**
 * Begin polling the wallet status. Calls `hooks.onStatus` on every tick.
 * Calls `hooks.onAutoLocked` when a tick observes `unlocked` flipping from
 * `true` → `false` without an intervening explicit lock from the UI.
 *
 * Errors from `ipc.status()` are swallowed (passed as `null` to `onStatus`).
 * Don't crash the renderer if the IPC layer hiccups.
 */
export function startWalletStatusPoll(
  ipc: WalletIpc,
  hooks: WalletStatusPollHooks,
  options: WalletStatusPollOptions = {},
): WalletStatusPollHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;

  let lastUnlocked: boolean | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    // Skip the IPC entirely when the caller says we're not the active
    // wallet. Cheap CPU + zero RPC: the user pays nothing for the poll
    // while a different wallet is selected.
    if (hooks.shouldPoll && !hooks.shouldPoll()) return;
    let status: WalletStatus | null = null;
    try {
      status = await ipc.status();
    } catch {
      status = null;
    }
    if (stopped) return;
    if (status) {
      if (lastUnlocked === true && status.unlocked === false) {
        hooks.onAutoLocked?.();
      }
      lastUnlocked = status.unlocked;
    }
    hooks.onStatus(status);
  };

  // Kick off an immediate first tick so the UI doesn't wait an interval to
  // know about an existing wallet.
  void tick();
  const handle = setIntervalFn(tick, intervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(handle);
    },
  };
}
