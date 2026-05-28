import { describe, expect, it } from 'vitest';

import { createTauriLedgerIpc, detectLedgerTauriInvoke } from '../ipc.js';

describe('createTauriLedgerIpc', () => {
  it('forwards each command name with the documented args', async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      return undefined as T;
    };
    const ipc = createTauriLedgerIpc(invoke);

    await ipc.listDevices();
    await ipc.connect();
    await ipc.getAddress(`m/44'/501'/0'/0'`, true);
    await ipc.getAddresses([`m/44'/501'/0'/0'`, `m/44'/501'/1'/0'`]);
    await ipc.signTransaction(`m/44'/501'/0'/0'`, 'AAAA');
    await ipc.signMessage(`m/44'/501'/0'/0'`, 'aGVsbG8=');
    await ipc.disconnect();

    expect(calls.map((c) => c.cmd)).toEqual([
      'ledger_list_devices',
      'ledger_connect',
      'ledger_get_address',
      'ledger_get_addresses',
      'ledger_sign_transaction',
      'ledger_sign_message',
      'ledger_disconnect',
    ]);
    expect(calls[2]!.args).toEqual({
      derivationPath: `m/44'/501'/0'/0'`,
      displayOnDevice: true,
    });
    expect(calls[3]!.args).toEqual({
      derivationPaths: [`m/44'/501'/0'/0'`, `m/44'/501'/1'/0'`],
    });
    expect(calls[4]!.args).toEqual({
      derivationPath: `m/44'/501'/0'/0'`,
      transactionB64: 'AAAA',
    });
  });

  it('defaults displayOnDevice to false when omitted', async () => {
    const calls: { args?: Record<string, unknown> }[] = [];
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      void cmd;
      calls.push({ args });
      return undefined as T;
    };
    const ipc = createTauriLedgerIpc(invoke);
    await ipc.getAddress(`m/44'/501'/0'/0'`);
    expect(calls[0]!.args).toEqual({
      derivationPath: `m/44'/501'/0'/0'`,
      displayOnDevice: false,
    });
  });

  it('surfaces backend errors verbatim', async () => {
    const invoke = async () => {
      throw new Error('user rejected on device');
    };
    const ipc = createTauriLedgerIpc(invoke);
    await expect(ipc.connect()).rejects.toThrow('user rejected on device');
  });
});

describe('detectLedgerTauriInvoke', () => {
  it('returns null when no Tauri internals are present', () => {
    const stash = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    try {
      expect(detectLedgerTauriInvoke()).toBeNull();
    } finally {
      if (stash !== undefined) {
        (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = stash;
      }
    }
  });

  it('returns the invoke fn when present', () => {
    const fakeInvoke = async <T>() => undefined as T;
    const stash = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: fakeInvoke,
    };
    try {
      expect(detectLedgerTauriInvoke()).toBe(fakeInvoke);
    } finally {
      if (stash === undefined) {
        delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      } else {
        (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = stash;
      }
    }
  });
});
