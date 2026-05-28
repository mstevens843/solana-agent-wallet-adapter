import bs58 from 'bs58';

import type {
  LedgerAddressResult,
  LedgerAppConfig,
  LedgerConnectResult,
  LedgerDevice,
  LedgerDerivedAddress,
  LedgerIpc,
} from './ipc.js';

export type LedgerWebHidUnsupportedReason =
  | 'no-global'
  | 'insecure-context'
  | 'missing-navigator-hid';

export interface LedgerWebHidSupport {
  supported: boolean;
  reason?: LedgerWebHidUnsupportedReason;
  message?: string;
}

interface MinimalHidDevice {
  vendorId: number;
  productId: number;
  productName?: string;
}

interface LedgerWebHidTransport {
  device?: MinimalHidDevice;
  close(): Promise<void>;
  on?(event: 'disconnect', listener: (err?: unknown) => void): void;
}

interface LedgerWebHidTransportApi {
  isSupported(): Promise<boolean>;
  list(): Promise<MinimalHidDevice[]>;
  request(): Promise<LedgerWebHidTransport>;
  openConnected(): Promise<LedgerWebHidTransport | null>;
}

type BufferConstructor = typeof import('buffer').Buffer;

interface LedgerSolanaApp {
  getAddress(path: string, display?: boolean): Promise<{ address: Uint8Array }>;
  signTransaction(path: string, txBuffer: Uint8Array): Promise<{ signature: Uint8Array }>;
  signOffchainMessage(path: string, msgBuffer: Uint8Array): Promise<{ signature: Uint8Array }>;
  getAppConfiguration(): Promise<{
    blindSigningEnabled?: boolean;
    pubKeyDisplayMode?: number | null;
    version?: string;
  }>;
}

type LedgerSolanaConstructor = new (transport: never) => LedgerSolanaApp;

interface LedgerWebHidRuntime {
  Buffer: BufferConstructor;
  transportApi: LedgerWebHidTransportApi;
  createSolanaApp: (transport: LedgerWebHidTransport) => LedgerSolanaApp;
}

export interface CreateWebHidLedgerIpcOptions {
  onDisconnect?: () => void;
  transport?: LedgerWebHidTransportApi;
  createSolanaApp?: (transport: LedgerWebHidTransport) => LedgerSolanaApp;
  operationTimeoutMs?: Partial<LedgerWebHidOperationTimeouts>;
}

export interface LedgerWebHidOperationTimeouts {
  listDevices: number;
  connect: number;
  getAddress: number;
  signTransaction: number;
  signMessage: number;
  disconnect: number;
}

const OFFCHAIN_MESSAGE_MAGIC = new Uint8Array([
  0xff,
  0x73,
  0x6f,
  0x6c,
  0x61,
  0x6e,
  0x61,
  0x20,
  0x6f,
  0x66,
  0x66,
  0x63,
  0x68,
  0x61,
  0x69,
  0x6e,
]);
const OFFCHAIN_MESSAGE_VERSION = 0;
const OFFCHAIN_MESSAGE_FORMAT_RESTRICTED_ASCII = 0;
const OFFCHAIN_MESSAGE_FORMAT_UTF8 = 1;
const U16_MAX = 0xffff;
const DEFAULT_LEDGER_WEBHID_OPERATION_TIMEOUT_MS: LedgerWebHidOperationTimeouts = {
  listDevices: 8_000,
  connect: 20_000,
  getAddress: 20_000,
  signTransaction: 90_000,
  signMessage: 90_000,
  disconnect: 5_000,
};

let defaultRuntimePromise: Promise<LedgerWebHidRuntime> | null = null;
let defaultRuntimeValue: LedgerWebHidRuntime | null = null;

export async function preloadWebHidLedgerRuntime(): Promise<void> {
  await loadDefaultLedgerWebHidRuntime();
}

export function detectLedgerWebHidSupport(): LedgerWebHidSupport {
  if (typeof globalThis === 'undefined') {
    return {
      supported: false,
      reason: 'no-global',
      message: 'WebHID is not available in this JavaScript context.',
    };
  }
  const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext;
  if (secure === false) {
    return {
      supported: false,
      reason: 'insecure-context',
      message: 'Ledger USB requires a secure HTTPS or localhost browser context.',
    };
  }
  const nav = (globalThis as { navigator?: { hid?: unknown } }).navigator;
  if (!nav?.hid) {
    return {
      supported: false,
      reason: 'missing-navigator-hid',
      message: 'This browser does not support WebHID. Use Chrome or Edge on desktop, or connect with QR/browser extension.',
    };
  }
  return { supported: true };
}

export function createWebHidLedgerIpc(
  options: CreateWebHidLedgerIpcOptions = {},
): LedgerIpc {
  let runtimePromise: Promise<LedgerWebHidRuntime> | null = null;
  let activeTransport: LedgerWebHidTransport | null = null;
  let activeApp: LedgerSolanaApp | null = null;
  const usesCustomRuntime = Boolean(options.transport || options.createSolanaApp);

  function timeoutMs(operation: keyof LedgerWebHidOperationTimeouts): number {
    return options.operationTimeoutMs?.[operation]
      ?? DEFAULT_LEDGER_WEBHID_OPERATION_TIMEOUT_MS[operation];
  }

  function runtime(): Promise<LedgerWebHidRuntime> {
    if (!usesCustomRuntime) return loadDefaultLedgerWebHidRuntime();
    runtimePromise ??= loadLedgerWebHidRuntime(options);
    return runtimePromise;
  }

  async function runtimeForRequestDevice(): Promise<LedgerWebHidRuntime> {
    if (usesCustomRuntime) return runtime();
    if (defaultRuntimeValue) return defaultRuntimeValue;
    void loadDefaultLedgerWebHidRuntime();
    throw new Error('Ledger USB support is still loading. Try again in a moment.');
  }

  function setActiveTransport(
    transport: LedgerWebHidTransport,
    runtimeValue: LedgerWebHidRuntime,
  ): LedgerWebHidTransport {
    activeTransport = transport;
    activeApp = runtimeValue.createSolanaApp(transport);
    transport.on?.('disconnect', () => {
      activeTransport = null;
      activeApp = null;
      options.onDisconnect?.();
    });
    return transport;
  }

  async function ensureTransport(runtimeValue: LedgerWebHidRuntime): Promise<LedgerWebHidTransport> {
    if (activeTransport && activeApp) return activeTransport;
    const connected = await runtimeValue.transportApi.openConnected();
    if (!connected) {
      throw new Error('No authorized Ledger device found. Select your Ledger in the browser prompt and try again.');
    }
    return setActiveTransport(connected, runtimeValue);
  }

  async function withSolanaApp<T>(
    task: (app: LedgerSolanaApp, runtimeValue: LedgerWebHidRuntime) => Promise<T>,
  ): Promise<T> {
    try {
      const runtimeValue = await runtime();
      await ensureTransport(runtimeValue);
      if (!activeApp) throw new Error('Ledger Solana app is not ready.');
      return await task(activeApp, runtimeValue);
    } catch (err) {
      const normalized = normalizeLedgerWebHidError(err);
      if (isLedgerTransportStaleError(err) || isLedgerTransportStaleError(normalized)) {
        activeTransport = null;
        activeApp = null;
      }
      throw normalized;
    }
  }

  return {
    async requestDevice() {
      try {
        const runtimeValue = await runtimeForRequestDevice();
        const transport = await runtimeValue.transportApi.request();
        setActiveTransport(transport, runtimeValue);
        return ledgerDeviceFromHidDevice(transport.device);
      } catch (err) {
        throw normalizeLedgerWebHidError(err);
      }
    },
    async listDevices() {
      try {
        const runtimeValue = await runtime();
        if (!(await withLedgerTimeout(
          runtimeValue.transportApi.isSupported(),
          timeoutMs('listDevices'),
          'Ledger USB support check timed out. Reconnect your device and try again.',
        ))) return [];
        const devices = await withLedgerTimeout(
          runtimeValue.transportApi.list(),
          timeoutMs('listDevices'),
          'Ledger device scan timed out. Reconnect your device and try again.',
        );
        return devices.map(ledgerDeviceFromHidDevice);
      } catch (err) {
        throw normalizeLedgerWebHidError(err);
      }
    },
    async connect(): Promise<LedgerConnectResult> {
      return withSolanaApp(async (app) => {
        const appConfig = await withLedgerTimeout(
          app.getAppConfiguration(),
          timeoutMs('connect'),
          'Ledger app check timed out. Unlock your Ledger, open the Solana app, and try again.',
        );
        return {
          device: ledgerDeviceFromHidDevice(activeTransport?.device),
          app: ledgerAppConfigFromLedgerJs(appConfig),
        };
      });
    },
    async getAddress(
      derivationPath: string,
      displayOnDevice = false,
    ): Promise<LedgerAddressResult> {
      return withSolanaApp(async (app, runtimeValue) => {
        const { address } = await withLedgerTimeout(
          app.getAddress(
            ledgerJsDerivationPath(derivationPath),
            displayOnDevice,
          ),
          timeoutMs('getAddress'),
          'Ledger address approval timed out. Check the device screen and try again.',
        );
        return addressResultFromPublicKey(address, runtimeValue.Buffer);
      });
    },
    async getAddresses(
      derivationPaths: readonly string[],
    ): Promise<LedgerDerivedAddress[]> {
      return withSolanaApp(async (app, runtimeValue) => {
        const out: LedgerDerivedAddress[] = [];
        for (const derivationPath of derivationPaths) {
          const { address } = await withLedgerTimeout(
            app.getAddress(ledgerJsDerivationPath(derivationPath), false),
            timeoutMs('getAddress'),
            'Ledger address scan timed out. Reconnect your device and try again.',
          );
          out.push({
            ...addressResultFromPublicKey(address, runtimeValue.Buffer),
            derivationPath,
          });
        }
        return out;
      });
    },
    async signTransaction(derivationPath: string, transactionB64: string): Promise<string> {
      return withSolanaApp(async (app, runtimeValue) => {
        const txBytes = runtimeValue.Buffer.from(transactionB64, 'base64');
        const { signature } = await withLedgerTimeout(
          app.signTransaction(
            ledgerJsDerivationPath(derivationPath),
            txBytes,
          ),
          timeoutMs('signTransaction'),
          'Ledger transaction approval timed out. Check the device screen and try again.',
        );
        return runtimeValue.Buffer.from(signature).toString('base64');
      });
    },
    async signMessage(derivationPath: string, messageB64: string): Promise<string> {
      return withSolanaApp(async (app, runtimeValue) => {
        const message = runtimeValue.Buffer.from(messageB64, 'base64');
        const wrapped = wrapOffchainMessage(message);
        const { signature } = await withLedgerTimeout(
          app.signOffchainMessage(
            ledgerJsDerivationPath(derivationPath),
            runtimeValue.Buffer.from(wrapped),
          ),
          timeoutMs('signMessage'),
          'Ledger message approval timed out. Check the device screen and try again.',
        );
        return runtimeValue.Buffer.from(signature).toString('base64');
      });
    },
    async disconnect(): Promise<void> {
      const transport = activeTransport;
      activeTransport = null;
      activeApp = null;
      if (!transport) return;
      try {
        await withLedgerTimeout(
          transport.close(),
          timeoutMs('disconnect'),
          'Ledger disconnect timed out.',
        );
      } catch {
        // Device may already be disconnected or closed by the browser.
      }
    },
  };
}

function loadDefaultLedgerWebHidRuntime(): Promise<LedgerWebHidRuntime> {
  if (defaultRuntimeValue) return Promise.resolve(defaultRuntimeValue);
  defaultRuntimePromise ??= loadLedgerWebHidRuntime({}).then((runtimeValue) => {
    defaultRuntimeValue = runtimeValue;
    return runtimeValue;
  });
  return defaultRuntimePromise;
}

async function loadLedgerWebHidRuntime(
  options: CreateWebHidLedgerIpcOptions,
): Promise<LedgerWebHidRuntime> {
  const { Buffer } = await import('buffer');
  installBufferPolyfill(Buffer);

  let transportApi = options.transport;
  let createSolanaApp = options.createSolanaApp;

  if (!transportApi) {
    const transportModule = await import('@ledgerhq/hw-transport-webhid');
    transportApi = transportModule.default as unknown as LedgerWebHidTransportApi;
  }

  if (!createSolanaApp) {
    const solanaModule = await import('@ledgerhq/hw-app-solana');
    const SolanaConstructor = ((solanaModule as unknown as { default?: LedgerSolanaConstructor }).default
      ?? solanaModule) as LedgerSolanaConstructor;
    createSolanaApp = (transport: LedgerWebHidTransport) => new SolanaConstructor(transport as never);
  }

  return { Buffer, transportApi, createSolanaApp };
}

export function wrapOffchainMessage(message: Uint8Array): Uint8Array {
  if (message.length > U16_MAX) {
    throw new Error(`off-chain message ${message.length} bytes exceeds u16 max (${U16_MAX})`);
  }
  const format = isRestrictedAscii(message)
    ? OFFCHAIN_MESSAGE_FORMAT_RESTRICTED_ASCII
    : OFFCHAIN_MESSAGE_FORMAT_UTF8;
  const out = new Uint8Array(OFFCHAIN_MESSAGE_MAGIC.length + 4 + message.length);
  out.set(OFFCHAIN_MESSAGE_MAGIC, 0);
  let offset = OFFCHAIN_MESSAGE_MAGIC.length;
  out[offset] = OFFCHAIN_MESSAGE_VERSION;
  offset += 1;
  out[offset] = format;
  offset += 1;
  out[offset] = message.length & 0xff;
  out[offset + 1] = (message.length >> 8) & 0xff;
  offset += 2;
  out.set(message, offset);
  return out;
}

export function ledgerJsDerivationPath(derivationPath: string): string {
  return derivationPath.trim().replace(/^m\//i, '');
}

export function normalizeLedgerWebHidError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const errorDetails = original as Error & { id?: unknown; statusCode?: unknown; statusText?: unknown };
  const message = original.message || String(original);
  const id = typeof errorDetails.id === 'string'
    ? String(errorDetails.id)
    : '';
  const statusCode = typeof errorDetails.statusCode === 'number'
    ? errorDetails.statusCode
    : null;
  const statusText = typeof errorDetails.statusText === 'string'
    ? String(errorDetails.statusText)
    : '';
  const statusHex = statusCode === null ? '' : `0x${statusCode.toString(16)}`;
  const name = original.name || '';
  const combined = `${name} ${id} ${statusText} ${statusHex} ${message}`;

  if (/HIDNotSupported|TransportInterfaceNotAvailable|navigator\.hid|WebHID is not supported/i.test(combined)) {
    return new Error('Ledger USB is not supported in this browser. Use Chrome or Edge on desktop, or connect with QR/browser extension.');
  }
  if (/secure context|secure origin|SecurityError/i.test(combined)) {
    return new Error('Ledger USB requires HTTPS or localhost.');
  }
  if (/Access denied|cancel|No device selected|chooser.*dismissed|NotAllowedError|TransportOpenUserCancelled/i.test(combined)) {
    return new Error('No Ledger device was selected.');
  }
  if (/No authorized Ledger device|No Ledger device found/i.test(combined)) {
    return new Error('No authorized Ledger device found. Select your Ledger in the browser prompt and try again.');
  }
  if (/0x5515|locked|device is locked/i.test(combined)) {
    return new Error('Unlock your Ledger device and try again.');
  }
  if (/0x6e00|0x6d00|CLA_NOT_SUPPORTED|UNKNOWN_APDU|app.*open|Solana app/i.test(combined)) {
    return new Error('Open the Solana app on your Ledger device and try again.');
  }
  if (/blind signature|blind signing|Missing a parameter/i.test(combined)) {
    return new Error('Enable blind signing in the Ledger Solana app settings, then try again.');
  }
  if (/0x6985|rejected|denied|Condition of use/i.test(combined)) {
    return new Error('Ledger rejected the request.');
  }
  if (/disconnect|write|closed|InvalidStateError/i.test(combined)) {
    return new Error('Ledger disconnected. Reconnect the device and try again.');
  }
  return original;
}

function isLedgerTransportStaleError(err: unknown): boolean {
  const original = err instanceof Error ? err : new Error(String(err));
  const errorDetails = original as Error & { id?: unknown; statusCode?: unknown; statusText?: unknown };
  const id = typeof errorDetails.id === 'string' ? String(errorDetails.id) : '';
  const statusText = typeof errorDetails.statusText === 'string' ? String(errorDetails.statusText) : '';
  const name = original.name || '';
  const combined = `${name} ${id} ${statusText} ${original.message || String(original)}`;
  return /disconnect|write|closed|InvalidStateError/i.test(combined);
}

function withLedgerTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== null) clearTimeout(timeout);
  });
}

function installBufferPolyfill(Buffer: BufferConstructor): void {
  const target = globalThis as { Buffer?: BufferConstructor };
  if (!target.Buffer) target.Buffer = Buffer;
}

function isRestrictedAscii(message: Uint8Array): boolean {
  for (const byte of message) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a) {
      continue;
    }
    return false;
  }
  return true;
}

function ledgerDeviceFromHidDevice(device: MinimalHidDevice | undefined): LedgerDevice {
  return {
    vendorId: device?.vendorId ?? 0,
    productId: device?.productId ?? 0,
    productName: device?.productName ?? null,
    serialNumber: null,
    manufacturerString: null,
  };
}

function ledgerAppConfigFromLedgerJs(config: {
  blindSigningEnabled?: boolean;
  pubKeyDisplayMode?: number | null;
  version?: string;
}): LedgerAppConfig {
  const [major = 0, minor = 0, patch = 0] = (config.version ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0);
  return {
    flags: config.blindSigningEnabled ? 1 : 0,
    pubKeyDisplayMode: config.pubKeyDisplayMode ?? null,
    major,
    minor,
    patch,
  };
}

function addressResultFromPublicKey(
  publicKey: Uint8Array,
  Buffer: BufferConstructor,
): LedgerAddressResult {
  const bytes = new Uint8Array(publicKey.buffer, publicKey.byteOffset, publicKey.byteLength);
  return {
    address: bs58.encode(bytes),
    publicKeyB64: Buffer.from(bytes).toString('base64'),
  };
}
