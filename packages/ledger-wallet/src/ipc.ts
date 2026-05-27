// Typed bindings for the Slice-G Tauri commands defined in
// `apps/desktop-shell/src-tauri/src/ledger/mod.rs`.

export interface LedgerDevice {
  vendorId: number;
  productId: number;
  productName: string | null;
  serialNumber: string | null;
  manufacturerString: string | null;
}

export interface LedgerAppConfig {
  flags: number;
  pubKeyDisplayMode?: number | null;
  major: number;
  minor: number;
  patch: number;
}

export interface LedgerConnectResult {
  device: LedgerDevice;
  app: LedgerAppConfig;
}

export interface LedgerAddressResult {
  address: string;
  /** Base64-encoded raw 32-byte ed25519 public key. */
  publicKeyB64: string;
}

/** Injectable IPC transport. Production wires `window.__TAURI_INTERNALS__.invoke`; tests use a fake. */
export interface LedgerIpc {
  listDevices(): Promise<LedgerDevice[]>;
  connect(): Promise<LedgerConnectResult>;
  getAddress(derivationPath: string, displayOnDevice?: boolean): Promise<LedgerAddressResult>;
  signTransaction(derivationPath: string, transactionB64: string): Promise<string>;
  /**
   * Sign an off-chain message via Ledger's `INS=0x07 SIGN_OFFCHAIN_MESSAGE`
   * (SIMD-32 envelope). The Rust side wraps the bytes in the magic header
   * + version + format + length prefix before sending to the device; the
   * caller passes the raw bytes the dApp wants signed (e.g. a SIWS nonce).
   */
  signMessage(derivationPath: string, messageB64: string): Promise<string>;
  disconnect(): Promise<void>;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriInvokeWindow {
  __TAURI_INTERNALS__?: {
    invoke?: InvokeFn;
  };
}

/** Returns the Tauri invoke function or `null` outside Tauri. Mirrors the embedded-wallet detection pattern. */
export function detectLedgerTauriInvoke(): InvokeFn | null {
  if (typeof globalThis === 'undefined') return null;
  const candidate = globalThis as TauriInvokeWindow;
  return candidate.__TAURI_INTERNALS__?.invoke ?? null;
}

/** Production transport bound to Tauri IPC. */
export function createTauriLedgerIpc(invoke: InvokeFn): LedgerIpc {
  return {
    listDevices: () => invoke<LedgerDevice[]>('ledger_list_devices'),
    connect: () => invoke<LedgerConnectResult>('ledger_connect'),
    getAddress: (derivationPath, displayOnDevice) =>
      invoke<LedgerAddressResult>('ledger_get_address', {
        derivationPath,
        displayOnDevice: displayOnDevice ?? false,
      }),
    signTransaction: (derivationPath, transactionB64) =>
      invoke<string>('ledger_sign_transaction', { derivationPath, transactionB64 }),
    signMessage: (derivationPath, messageB64) =>
      invoke<string>('ledger_sign_message', { derivationPath, messageB64 }),
    disconnect: () => invoke<void>('ledger_disconnect'),
  };
}
