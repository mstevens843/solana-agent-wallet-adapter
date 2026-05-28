import * as SolanaModule from '@ledgerhq/hw-app-solana';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import { Buffer } from 'buffer';
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

interface LedgerSolanaApp {
  getAddress(path: string, display?: boolean): Promise<{ address: Uint8Array }>;
  signTransaction(path: string, txBuffer: Buffer): Promise<{ signature: Uint8Array }>;
  signOffchainMessage(path: string, msgBuffer: Buffer): Promise<{ signature: Uint8Array }>;
  getAppConfiguration(): Promise<{
    blindSigningEnabled?: boolean;
    pubKeyDisplayMode?: number | null;
    version?: string;
  }>;
}

type LedgerSolanaConstructor = new (transport: never) => LedgerSolanaApp;

export interface CreateWebHidLedgerIpcOptions {
  onDisconnect?: () => void;
  transport?: LedgerWebHidTransportApi;
  createSolanaApp?: (transport: LedgerWebHidTransport) => LedgerSolanaApp;
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
  installBufferPolyfill();
  const transportApi = options.transport ?? (TransportWebHID as unknown as LedgerWebHidTransportApi);
  const SolanaConstructor = ((SolanaModule as unknown as { default?: LedgerSolanaConstructor }).default
    ?? SolanaModule) as LedgerSolanaConstructor;
  const createSolanaApp =
    options.createSolanaApp ?? ((transport: LedgerWebHidTransport) =>
      new SolanaConstructor(transport as never));

  let activeTransport: LedgerWebHidTransport | null = null;
  let activeApp: LedgerSolanaApp | null = null;

  function setActiveTransport(transport: LedgerWebHidTransport): LedgerWebHidTransport {
    activeTransport = transport;
    activeApp = createSolanaApp(transport);
    transport.on?.('disconnect', () => {
      activeTransport = null;
      activeApp = null;
      options.onDisconnect?.();
    });
    return transport;
  }

  async function ensureTransport(): Promise<LedgerWebHidTransport> {
    if (activeTransport && activeApp) return activeTransport;
    const connected = await transportApi.openConnected();
    if (!connected) {
      throw new Error('No authorized Ledger device found. Select your Ledger in the browser prompt and try again.');
    }
    return setActiveTransport(connected);
  }

  async function withSolanaApp<T>(task: (app: LedgerSolanaApp) => Promise<T>): Promise<T> {
    try {
      await ensureTransport();
      if (!activeApp) throw new Error('Ledger Solana app is not ready.');
      return await task(activeApp);
    } catch (err) {
      throw normalizeLedgerWebHidError(err);
    }
  }

  return {
    async requestDevice() {
      try {
        if (!(await transportApi.isSupported())) {
          throw new Error('WebHID is not supported by this browser.');
        }
        const transport = await transportApi.request();
        setActiveTransport(transport);
        return ledgerDeviceFromHidDevice(transport.device);
      } catch (err) {
        throw normalizeLedgerWebHidError(err);
      }
    },
    async listDevices() {
      try {
        if (!(await transportApi.isSupported())) return [];
        const devices = await transportApi.list();
        return devices.map(ledgerDeviceFromHidDevice);
      } catch (err) {
        throw normalizeLedgerWebHidError(err);
      }
    },
    async connect(): Promise<LedgerConnectResult> {
      return withSolanaApp(async (app) => {
        const appConfig = await app.getAppConfiguration();
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
      return withSolanaApp(async (app) => {
        const { address } = await app.getAddress(
          ledgerJsDerivationPath(derivationPath),
          displayOnDevice,
        );
        return addressResultFromPublicKey(address);
      });
    },
    async getAddresses(
      derivationPaths: readonly string[],
    ): Promise<LedgerDerivedAddress[]> {
      return withSolanaApp(async (app) => {
        const out: LedgerDerivedAddress[] = [];
        for (const derivationPath of derivationPaths) {
          const { address } = await app.getAddress(ledgerJsDerivationPath(derivationPath), false);
          out.push({
            ...addressResultFromPublicKey(address),
            derivationPath,
          });
        }
        return out;
      });
    },
    async signTransaction(derivationPath: string, transactionB64: string): Promise<string> {
      return withSolanaApp(async (app) => {
        const txBytes = Buffer.from(transactionB64, 'base64');
        const { signature } = await app.signTransaction(
          ledgerJsDerivationPath(derivationPath),
          txBytes,
        );
        return Buffer.from(signature).toString('base64');
      });
    },
    async signMessage(derivationPath: string, messageB64: string): Promise<string> {
      return withSolanaApp(async (app) => {
        const message = Buffer.from(messageB64, 'base64');
        const wrapped = wrapOffchainMessage(message);
        const { signature } = await app.signOffchainMessage(
          ledgerJsDerivationPath(derivationPath),
          Buffer.from(wrapped),
        );
        return Buffer.from(signature).toString('base64');
      });
    },
    async disconnect(): Promise<void> {
      const transport = activeTransport;
      activeTransport = null;
      activeApp = null;
      if (!transport) return;
      try {
        await transport.close();
      } catch {
        // Device may already be disconnected or closed by the browser.
      }
    },
  };
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
  const message = original.message || String(original);
  const id = typeof (original as { id?: unknown }).id === 'string'
    ? String((original as { id?: unknown }).id)
    : '';
  const name = original.name || '';
  const combined = `${name} ${id} ${message}`;

  if (/HIDNotSupported|navigator\.hid|WebHID is not supported/i.test(combined)) {
    return new Error('Ledger USB is not supported in this browser. Use Chrome or Edge on desktop, or connect with QR/browser extension.');
  }
  if (/secure context|https|localhost/i.test(combined)) {
    return new Error('Ledger USB requires HTTPS or localhost.');
  }
  if (/Access denied|cancel|No device selected|chooser.*dismissed|NotAllowedError/i.test(combined)) {
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

function installBufferPolyfill(): void {
  const target = globalThis as { Buffer?: typeof Buffer };
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

function addressResultFromPublicKey(publicKey: Uint8Array): LedgerAddressResult {
  const bytes = new Uint8Array(publicKey.buffer, publicKey.byteOffset, publicKey.byteLength);
  return {
    address: bs58.encode(bytes),
    publicKeyB64: Buffer.from(bytes).toString('base64'),
  };
}
