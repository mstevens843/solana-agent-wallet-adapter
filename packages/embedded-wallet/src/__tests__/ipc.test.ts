import { describe, expect, it } from 'vitest';

import { createTauriWalletIpc, detectTauriInvoke } from '../ipc.js';

type Call = { cmd: string; args?: Record<string, unknown> };

function recordingInvoke() {
  const calls: Call[] = [];
  const responses = new Map<string, unknown>();
  const stub = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (responses.has(cmd)) return responses.get(cmd) as T;
    return undefined as T;
  };
  return {
    invoke: stub,
    calls,
    setResponse: <T>(cmd: string, value: T) => responses.set(cmd, value),
  };
}

describe('WalletIpc bindings', () => {
  it('forwards every command name with the documented argument shape', async () => {
    const stub = recordingInvoke();
    const ipc = createTauriWalletIpc(stub.invoke);

    stub.setResponse('wallet_status', {
      exists: true,
      unlocked: false,
      address: null,
      derivationPath: null,
      createdAt: null,
      autoLockSecs: 300,
      idleSeconds: null,
    });

    await ipc.status();
    await ipc.create('pw1');
    await ipc.import('pw1', 'twelve word seed phrase here');
    await ipc.unlock('pw1');
    await ipc.lock();
    await ipc.changePassword('old', 'new');
    await ipc.signMessage('Addr', 'aGVsbG8=');
    await ipc.signTransaction('Addr', 'AAAA');
    await ipc.setAutoLock(600);
    await ipc.exportForBackup('pw1');
    await ipc.deleteWallet('pw1');

    expect(stub.calls.map((c) => c.cmd)).toEqual([
      'wallet_status',
      'wallet_create',
      'wallet_import',
      'wallet_unlock',
      'wallet_lock',
      'wallet_change_password',
      'wallet_sign_message',
      'wallet_sign_transaction',
      'wallet_set_auto_lock',
      'wallet_export_for_backup',
      'wallet_delete',
    ]);

    const byCmd = (cmd: string) => stub.calls.find((c) => c.cmd === cmd)!;
    expect(byCmd('wallet_create').args).toEqual({ password: 'pw1' });
    expect(byCmd('wallet_import').args).toEqual({
      password: 'pw1',
      mnemonic: 'twelve word seed phrase here',
    });
    expect(byCmd('wallet_change_password').args).toEqual({
      oldPassword: 'old',
      newPassword: 'new',
    });
    expect(byCmd('wallet_sign_message').args).toEqual({
      address: 'Addr',
      messageB64: 'aGVsbG8=',
    });
    expect(byCmd('wallet_sign_transaction').args).toEqual({
      address: 'Addr',
      transactionB64: 'AAAA',
    });
    expect(byCmd('wallet_set_auto_lock').args).toEqual({ seconds: 600 });
  });

  it('surfaces backend errors verbatim', async () => {
    const failingInvoke = async () => {
      throw new Error('invalid password');
    };
    const ipc = createTauriWalletIpc(failingInvoke);
    await expect(ipc.unlock('wrong')).rejects.toThrow('invalid password');
  });
});

describe('detectTauriInvoke', () => {
  it('returns null when no Tauri internals are present', () => {
    const stash = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    try {
      expect(detectTauriInvoke()).toBeNull();
    } finally {
      if (stash !== undefined) {
        (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = stash;
      }
    }
  });

  it('returns the invoke fn when Tauri internals are present', () => {
    const stash = (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const fakeInvoke = async <T>() => undefined as T;
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: fakeInvoke,
    };
    try {
      const detected = detectTauriInvoke();
      expect(detected).toBe(fakeInvoke);
    } finally {
      if (stash === undefined) {
        delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      } else {
        (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = stash;
      }
    }
  });
});
