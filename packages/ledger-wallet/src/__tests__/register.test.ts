// Slice R.4 regression: re-registering the same derivation-path|address
// with a fresh IPC instance must return a NEW wallet whose closures point
// at the NEW ipc. Mirrors `packages/walletconnect-solana/__tests__/
// register.test.ts` (Slice Q.1).

import bs58 from 'bs58';
import { beforeEach, describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import type { LedgerIpc } from '../ipc.js';
import {
  registerLedgerWallet,
  resetLedgerRegistry,
  unregisterAllLedgerWallets,
} from '../register.js';

const ADDR = 'EmaginedRust11111111111111111111111111111111';

function publicKeyBytes(): Uint8Array {
  return bs58.decode(ADDR);
}

function unsignedLegacyTransaction(): Uint8Array {
  const signer = new PublicKey(ADDR);
  return new Transaction({
    feePayer: signer,
    recentBlockhash: '11111111111111111111111111111111',
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer,
      toPubkey: new PublicKey('11111111111111111111111111111112'),
      lamports: 1,
    }),
  ).serialize({ requireAllSignatures: false, verifySignatures: false });
}

function fakeIpc(): LedgerIpc & {
  signTransactionCalls: { derivationPath: string; payload: string }[];
} {
  const calls: { derivationPath: string; payload: string }[] = [];
  return {
    listDevices: async () => [],
    connect: async () => ({
      device: {
        vendorId: 0x2C97,
        productId: 0x0005,
        productName: 'Ledger Nano',
        serialNumber: null,
        manufacturerString: null,
      },
      app: { flags: 0, major: 1, minor: 0, patch: 0 },
    }),
    getAddress: async () => ({
      address: ADDR,
      publicKeyB64: Buffer.from(publicKeyBytes()).toString('base64'),
    }),
    signTransaction: async (derivationPath, payload) => {
      calls.push({ derivationPath, payload });
      return Buffer.from(new Uint8Array(64).fill(1)).toString('base64');
    },
    signMessage: async () => Buffer.from(new Uint8Array(64)).toString('base64'),
    disconnect: async () => undefined,
    signTransactionCalls: calls,
  } as LedgerIpc & { signTransactionCalls: typeof calls };
}

describe('registerLedgerWallet', () => {
  beforeEach(() => {
    resetLedgerRegistry();
  });

  it('returns a fresh wallet + stable unregister callback on first register', () => {
    const { wallet, unregister } = registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    expect(wallet.accounts).toEqual([]);
    expect(typeof unregister).toBe('function');
    unregister();
    unregister(); // idempotent safety net
  });

  it('re-registering the same path+address with a NEW ipc returns a NEW wallet', () => {
    const first = registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    const second = registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    expect(second.wallet).not.toBe(first.wallet);
  });

  it("the second wallet's signTransaction routes to the NEW ipc (Slice R.4 regression)", async () => {
    const firstIpc = fakeIpc();
    registerLedgerWallet({
      ipc: firstIpc,
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    const secondIpc = fakeIpc();
    const second = registerLedgerWallet({
      ipc: secondIpc,
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await second.wallet.features['standard:connect'].connect();
    const account = second.wallet.accounts[0]!;
    await second.wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: unsignedLegacyTransaction(),
    });
    expect(firstIpc.signTransactionCalls).toHaveLength(0);
    expect(secondIpc.signTransactionCalls).toHaveLength(1);
  });

  it('different derivation paths register independently', () => {
    const a = registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    const b = registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/1'/0'`,
    });
    expect(a.wallet).not.toBe(b.wallet);
  });

  it('unregisterAllLedgerWallets tears down every entry', () => {
    registerLedgerWallet({
      ipc: fakeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    expect(() => unregisterAllLedgerWallets()).not.toThrow();
  });

  it('resetLedgerRegistry forgets tracking without invoking unregister', () => {
    let disconnectCalled = false;
    const ipc: LedgerIpc = {
      listDevices: async () => [],
      connect: async () => ({
        device: {
          vendorId: 0,
          productId: 0,
          productName: null,
          serialNumber: null,
          manufacturerString: null,
        },
        app: { flags: 0, major: 0, minor: 0, patch: 0 },
      }),
      getAddress: async () => ({
        address: ADDR,
        publicKeyB64: Buffer.from(publicKeyBytes()).toString('base64'),
      }),
      signTransaction: async () => '',
      signMessage: async () => '',
      disconnect: async () => {
        disconnectCalled = true;
      },
    };
    registerLedgerWallet({
      ipc,
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    resetLedgerRegistry();
    unregisterAllLedgerWallets(); // no-op after reset
    expect(disconnectCalled).toBe(false);
  });
});
