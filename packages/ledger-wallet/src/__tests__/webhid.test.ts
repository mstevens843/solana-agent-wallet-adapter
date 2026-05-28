import { afterEach, describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';

import {
  createWebHidLedgerIpc,
  detectLedgerWebHidSupport,
  ledgerJsDerivationPath,
  normalizeLedgerWebHidError,
  wrapOffchainMessage,
} from '../webhid.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSecureContext = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');

afterEach(() => {
  restoreGlobal('navigator', originalNavigator);
  restoreGlobal('isSecureContext', originalSecureContext);
});

describe('detectLedgerWebHidSupport', () => {
  it('rejects insecure contexts before checking navigator.hid', () => {
    setGlobal('isSecureContext', false);
    setGlobal('navigator', { hid: {} });

    expect(detectLedgerWebHidSupport()).toEqual({
      supported: false,
      reason: 'insecure-context',
      message: 'Ledger USB requires a secure HTTPS or localhost browser context.',
    });
  });

  it('requires navigator.hid in secure/browser-like contexts', () => {
    setGlobal('isSecureContext', true);
    setGlobal('navigator', {});

    expect(detectLedgerWebHidSupport()).toMatchObject({
      supported: false,
      reason: 'missing-navigator-hid',
    });
  });

  it('reports supported when WebHID is present', () => {
    setGlobal('isSecureContext', true);
    setGlobal('navigator', { hid: {} });

    expect(detectLedgerWebHidSupport()).toEqual({ supported: true });
  });
});

describe('ledgerJsDerivationPath', () => {
  it('strips the leading m/ segment expected by the Tauri path format', () => {
    expect(ledgerJsDerivationPath(`m/44'/501'/0'/0'`)).toBe(`44'/501'/0'/0'`);
  });

  it('leaves LedgerJS-native paths unchanged', () => {
    expect(ledgerJsDerivationPath(`44'/501'/0'/0'`)).toBe(`44'/501'/0'/0'`);
  });
});

describe('wrapOffchainMessage', () => {
  it('matches the desktop Rust SIMD-32 envelope shape for restricted ASCII', () => {
    const message = new TextEncoder().encode('agentic sign-in nonce 12345');
    const wrapped = wrapOffchainMessage(message);
    const magic = new Uint8Array([
      0xff,
      ...new TextEncoder().encode('solana offchain'),
    ]);

    expect(wrapped.slice(0, magic.length)).toEqual(magic);
    expect(wrapped[magic.length]).toBe(0);
    expect(wrapped[magic.length + 1]).toBe(0);
    expect(wrapped[magic.length + 2]).toBe(message.length & 0xff);
    expect(wrapped[magic.length + 3]).toBe((message.length >> 8) & 0xff);
    expect(wrapped.slice(magic.length + 4)).toEqual(message);
  });

  it('marks non-ASCII payloads as UTF-8', () => {
    const wrapped = wrapOffchainMessage(new TextEncoder().encode('cafe\u0301'));
    const magicLength = 1 + 'solana offchain'.length;
    expect(wrapped[magicLength + 1]).toBe(1);
  });

  it('rejects messages that exceed the Ledger u16 length prefix', () => {
    expect(() => wrapOffchainMessage(new Uint8Array(0x10000))).toThrow('exceeds u16 max');
  });
});

describe('createWebHidLedgerIpc', () => {
  it('requests the browser device without a support-check await on the prompt path', async () => {
    const transport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const transportApi = {
      isSupported: vi.fn(async () => true),
      list: vi.fn(async () => [transport.device]),
      request: vi.fn(async () => transport),
      openConnected: vi.fn(async () => transport),
    };
    const ipc = createWebHidLedgerIpc({
      transport: transportApi,
      createSolanaApp: () => ({
        getAppConfiguration: vi.fn(),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
        signOffchainMessage: vi.fn(),
      }),
    });

    await expect(ipc.requestDevice?.()).resolves.toMatchObject({
      productName: 'Ledger Nano X',
    });
    expect(transportApi.request).toHaveBeenCalledTimes(1);
    expect(transportApi.isSupported).not.toHaveBeenCalled();
  });

  it('prompts for a device, validates the Solana app, and maps addresses/signatures', async () => {
    const publicKey = new Uint8Array(32).fill(7);
    const signature = new Uint8Array(64).fill(9);
    const calls: Array<{ method: string; path?: string; payload?: Uint8Array; display?: boolean }> = [];
    const transport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const transportApi = {
      isSupported: vi.fn(async () => true),
      list: vi.fn(async () => [transport.device]),
      request: vi.fn(async () => transport),
      openConnected: vi.fn(async () => transport),
    };
    const app = {
      getAppConfiguration: vi.fn(async () => ({
        blindSigningEnabled: true,
        pubKeyDisplayMode: 1,
        version: '1.4.2',
      })),
      getAddress: vi.fn(async (path: string, display?: boolean) => {
        calls.push({ method: 'getAddress', path, display });
        return { address: publicKey };
      }),
      signTransaction: vi.fn(async (path: string, payload: Uint8Array) => {
        calls.push({ method: 'signTransaction', path, payload });
        return { signature };
      }),
      signOffchainMessage: vi.fn(async (path: string, payload: Uint8Array) => {
        calls.push({ method: 'signOffchainMessage', path, payload });
        return { signature };
      }),
    };
    const ipc = createWebHidLedgerIpc({
      transport: transportApi,
      createSolanaApp: () => app,
    });

    await expect(ipc.requestDevice?.()).resolves.toMatchObject({
      productName: 'Ledger Nano X',
      vendorId: 0x2c97,
    });
    await expect(ipc.connect()).resolves.toEqual({
      device: {
        vendorId: 0x2c97,
        productId: 0x0004,
        productName: 'Ledger Nano X',
        serialNumber: null,
        manufacturerString: null,
      },
      app: {
        flags: 1,
        pubKeyDisplayMode: 1,
        major: 1,
        minor: 4,
        patch: 2,
      },
    });
    await expect(ipc.getAddress(`m/44'/501'/0'/0'`, true)).resolves.toEqual({
      address: bs58.encode(publicKey),
      publicKeyB64: Buffer.from(publicKey).toString('base64'),
    });
    await expect(ipc.getAddresses([`m/44'/501'/1'/0'`])).resolves.toEqual([
      {
        address: bs58.encode(publicKey),
        publicKeyB64: Buffer.from(publicKey).toString('base64'),
        derivationPath: `m/44'/501'/1'/0'`,
      },
    ]);
    await expect(
      ipc.signTransaction(`m/44'/501'/0'/0'`, Buffer.from([1, 2, 3]).toString('base64')),
    ).resolves.toBe(Buffer.from(signature).toString('base64'));
    await expect(
      ipc.signMessage(`m/44'/501'/0'/0'`, Buffer.from('hi').toString('base64')),
    ).resolves.toBe(Buffer.from(signature).toString('base64'));

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['getAddress', `44'/501'/0'/0'`],
      ['getAddress', `44'/501'/1'/0'`],
      ['signTransaction', `44'/501'/0'/0'`],
      ['signOffchainMessage', `44'/501'/0'/0'`],
    ]);
    const offchainPayload = calls.find((call) => call.method === 'signOffchainMessage')?.payload;
    expect(Array.from(offchainPayload ?? [])).toEqual(
      Array.from(wrapOffchainMessage(new TextEncoder().encode('hi'))),
    );
  });

  it('runs the disconnect callback when WebHID reports device removal', async () => {
    const onDisconnect = vi.fn();
    let disconnectListener: (() => void) | null = null;
    const transport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn((event: 'disconnect', listener: () => void) => {
        if (event === 'disconnect') disconnectListener = listener;
      }),
    };
    const ipc = createWebHidLedgerIpc({
      onDisconnect,
      transport: {
        isSupported: vi.fn(async () => true),
        list: vi.fn(async () => [transport.device]),
        request: vi.fn(async () => transport),
        openConnected: vi.fn(async () => transport),
      },
      createSolanaApp: () => ({
        getAppConfiguration: vi.fn(),
        getAddress: vi.fn(),
        signTransaction: vi.fn(),
        signOffchainMessage: vi.fn(),
      }),
    });

    await ipc.requestDevice?.();
    disconnectListener?.();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('reopens an authorized device after a stale transport error', async () => {
    const staleError = new Error('transport closed');
    staleError.name = 'InvalidStateError';
    const firstTransport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const secondTransport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const transportApi = {
      isSupported: vi.fn(async () => true),
      list: vi.fn(async () => [firstTransport.device]),
      request: vi.fn(async () => firstTransport),
      openConnected: vi.fn(async () => secondTransport),
    };
    const staleApp = {
      getAppConfiguration: vi.fn(async () => {
        throw staleError;
      }),
      getAddress: vi.fn(),
      signTransaction: vi.fn(),
      signOffchainMessage: vi.fn(),
    };
    const liveApp = {
      getAppConfiguration: vi.fn(async () => ({ version: '1.0.0' })),
      getAddress: vi.fn(),
      signTransaction: vi.fn(),
      signOffchainMessage: vi.fn(),
    };
    const ipc = createWebHidLedgerIpc({
      transport: transportApi,
      createSolanaApp: (transport) => transport === firstTransport ? staleApp : liveApp,
    });

    await ipc.requestDevice?.();
    await expect(ipc.connect()).rejects.toThrow('Ledger disconnected. Reconnect the device and try again.');
    await expect(ipc.connect()).resolves.toMatchObject({
      device: { productName: 'Ledger Nano X' },
      app: { major: 1, minor: 0, patch: 0 },
    });
    expect(transportApi.openConnected).toHaveBeenCalledTimes(1);
  });

  it('times out address reads with actionable Ledger copy', async () => {
    const transport = {
      device: { vendorId: 0x2c97, productId: 0x0004, productName: 'Ledger Nano X' },
      close: vi.fn(async () => undefined),
      on: vi.fn(),
    };
    const ipc = createWebHidLedgerIpc({
      operationTimeoutMs: { getAddress: 1 },
      transport: {
        isSupported: vi.fn(async () => true),
        list: vi.fn(async () => [transport.device]),
        request: vi.fn(async () => transport),
        openConnected: vi.fn(async () => transport),
      },
      createSolanaApp: () => ({
        getAppConfiguration: vi.fn(async () => ({ version: '1.0.0' })),
        getAddress: vi.fn(() => new Promise<never>(() => undefined)),
        signTransaction: vi.fn(),
        signOffchainMessage: vi.fn(),
      }),
    });

    await ipc.requestDevice?.();
    await expect(ipc.getAddress(`m/44'/501'/0'/0'`))
      .rejects.toThrow('Ledger address approval timed out');
  });
});

describe('normalizeLedgerWebHidError', () => {
  it('maps browser permission cancellation to product copy', () => {
    expect(normalizeLedgerWebHidError(new Error('Access denied to use Ledger device')).message)
      .toBe('No Ledger device was selected.');
  });

  it('maps blind signing errors to the Ledger Solana setting', () => {
    expect(normalizeLedgerWebHidError(new Error('Missing a parameter. Try enabling blind signature in the app')).message)
      .toBe('Enable blind signing in the Ledger Solana app settings, then try again.');
  });

  it('does not treat arbitrary HTTPS text as an insecure-context browser failure', () => {
    const err = new Error('Ledger metadata loaded from https://example.invalid but failed.');
    expect(normalizeLedgerWebHidError(err)).toBe(err);
  });
});

function setGlobal(key: 'navigator' | 'isSecureContext', value: unknown): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function restoreGlobal(
  key: 'navigator' | 'isSecureContext',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[key];
  }
}
