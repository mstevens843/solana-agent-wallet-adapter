// Typed bindings for the Slice-A Tauri commands defined in
// `apps/desktop-shell/src-tauri/src/wallet/mod.rs`.
//
// The `WalletIpc` interface is the only contract `wallet.ts` and
// `register.ts` know about. Production wires it to
// `window.__TAURI_INTERNALS__.invoke`; tests pass an in-memory fake.

export interface WalletStatus {
  exists: boolean;
  unlocked: boolean;
  address: string | null;
  derivationPath: string | null;
  createdAt: string | null;
  autoLockSecs: number;
  idleSeconds: number | null;
}

export interface WalletCreated {
  address: string;
  mnemonic: string;
}

/** Abstract transport. Implementations call the native invoke or a test stub. */
export interface WalletIpc {
  status(): Promise<WalletStatus>;
  create(password: string): Promise<WalletCreated>;
  import(password: string, mnemonic: string): Promise<WalletCreated>;
  unlock(password: string): Promise<WalletStatus>;
  lock(): Promise<WalletStatus>;
  changePassword(oldPassword: string, newPassword: string): Promise<WalletStatus>;
  signMessage(address: string, messageB64: string): Promise<string>;
  signTransaction(address: string, transactionB64: string): Promise<string>;
  setAutoLock(seconds: number): Promise<WalletStatus>;
  exportForBackup(password: string): Promise<string>;
  deleteWallet(password: string): Promise<WalletStatus>;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriInvokeWindow {
  __TAURI_INTERNALS__?: {
    invoke?: InvokeFn;
  };
}

/**
 * Returns the Tauri invoke function if the host is a Tauri webview, else
 * `null`. Mirrors the detection in `apps/browser-demo/src/tauriNative.ts`.
 */
export function detectTauriInvoke(): InvokeFn | null {
  if (typeof globalThis === 'undefined') return null;
  const candidate = globalThis as TauriInvokeWindow;
  return candidate.__TAURI_INTERNALS__?.invoke ?? null;
}

/**
 * Build a production `WalletIpc` backed by the given invoke. Throws if
 * `invoke` is null — call `detectTauriInvoke()` first and skip registration
 * outside Tauri.
 */
export function createTauriWalletIpc(invoke: InvokeFn): WalletIpc {
  return {
    status: () => invoke<WalletStatus>('wallet_status'),
    create: (password) => invoke<WalletCreated>('wallet_create', { password }),
    import: (password, mnemonic) =>
      invoke<WalletCreated>('wallet_import', { password, mnemonic }),
    unlock: (password) => invoke<WalletStatus>('wallet_unlock', { password }),
    lock: () => invoke<WalletStatus>('wallet_lock'),
    changePassword: (oldPassword, newPassword) =>
      invoke<WalletStatus>('wallet_change_password', {
        oldPassword,
        newPassword,
      }),
    signMessage: (address, messageB64) =>
      invoke<string>('wallet_sign_message', { address, messageB64 }),
    signTransaction: (address, transactionB64) =>
      invoke<string>('wallet_sign_transaction', { address, transactionB64 }),
    setAutoLock: (seconds) =>
      invoke<WalletStatus>('wallet_set_auto_lock', { seconds }),
    exportForBackup: (password) =>
      invoke<string>('wallet_export_for_backup', { password }),
    deleteWallet: (password) =>
      invoke<WalletStatus>('wallet_delete', { password }),
  };
}
