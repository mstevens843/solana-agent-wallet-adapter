import { beforeEach, describe, expect, it } from 'vitest';

import type { WalletConnectSession, WalletConnectSolanaClient } from '../client.js';
import {
  registerWalletConnectSolanaWallet,
  resetWalletConnectRegistry,
  unregisterAllWalletConnectWallets,
  unregisterWalletConnectSolanaWallet,
} from '../register.js';

const ADDR_A = 'EmaginedRust11111111111111111111111111111111';
// Solana System Program address — a stable, well-known base58 string.
const ADDR_B = '11111111111111111111111111111112';
const ICON = 'data:image/svg+xml;base64,PHN2Zy8+' as const;
const CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

function fakeClient(): WalletConnectSolanaClient & {
  signTransactionCalls: { topic: string; chainId: string; transactionBase64: string }[];
} {
  const calls: { topic: string; chainId: string; transactionBase64: string }[] = [];
  return {
    connect: async () => {
      throw new Error('connect should not run from register tests');
    },
    signMessage: async () => new Uint8Array(64),
    signTransaction: async (opts) => {
      calls.push(opts);
      return Buffer.from(new Uint8Array(4).fill(1)).toString('base64');
    },
    disconnect: async () => undefined,
    listSessions: () => [],
    on: () => () => undefined,
    signTransactionCalls: calls,
  } as WalletConnectSolanaClient & { signTransactionCalls: typeof calls };
}

function session(topic: string, address = ADDR_A, chainId = CHAIN): WalletConnectSession {
  return { topic, address, chainId };
}

describe('registerWalletConnectSolanaWallet', () => {
  beforeEach(() => {
    // After tests run `getWallets().register(...)` the global registry retains
    // wallets across cases; clear our internal tracking so each test starts
    // from a known state. The Wallet Standard registry itself is global, but
    // tests don't read from it — they observe via the returned `wallet`
    // object and the unregister callback.
    resetWalletConnectRegistry();
  });

  it('registers a fresh wallet and returns a stable unregister callback', () => {
    const client = fakeClient();
    const { wallet, unregister } = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1'),
      client,
      icon: ICON,
    });
    expect(wallet.name).toBe('Phantom (mobile)');
    expect(typeof unregister).toBe('function');
    unregister();
    // Calling again is a no-op (safety net).
    unregister();
  });

  it('re-registering the same brand+address with a NEW topic returns a NEW wallet object', async () => {
    const client = fakeClient();
    const first = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1'),
      client,
      icon: ICON,
    });
    const second = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-2'),
      client,
      icon: ICON,
    });
    expect(second.wallet).not.toBe(first.wallet);
  });

  it("the second wallet's signing routes to the NEW topic (regression for Slice P)", async () => {
    const client = fakeClient();
    registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-OLD'),
      client,
      icon: ICON,
    });
    const second = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-NEW'),
      client,
      icon: ICON,
    });
    // Drive the new wallet's signTransaction; assert the topic reached the
    // client. Without the Slice Q fix, this would route to 'topic-OLD' and
    // the assertion would fail.
    await second.wallet.features['standard:connect'].connect();
    const account = second.wallet.accounts[0]!;
    await second.wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: new Uint8Array([1, 2, 3]),
    });
    const fc = client as ReturnType<typeof fakeClient>;
    expect(fc.signTransactionCalls).toHaveLength(1);
    expect(fc.signTransactionCalls[0]!.topic).toBe('topic-NEW');
  });

  it('different brand+address tuples register independently', () => {
    const client = fakeClient();
    const a = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1', ADDR_A),
      client,
      icon: ICON,
    });
    const b = registerWalletConnectSolanaWallet({
      brand: { id: 'solflare', name: 'Solflare (mobile)' },
      session: session('topic-2', ADDR_A),
      client,
      icon: ICON,
    });
    const c = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-3', ADDR_B),
      client,
      icon: ICON,
    });
    expect(a.wallet).not.toBe(b.wallet);
    expect(a.wallet).not.toBe(c.wallet);
    expect(b.wallet).not.toBe(c.wallet);
  });

  it('unregisterWalletConnectSolanaWallet finds an entry by its current topic', () => {
    const client = fakeClient();
    registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1'),
      client,
      icon: ICON,
    });
    unregisterWalletConnectSolanaWallet('topic-1');
    // Registering again with the same brand+address must now register a
    // fresh wallet (the prior one is gone).
    const reregistered = registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-2'),
      client,
      icon: ICON,
    });
    expect(reregistered.wallet).toBeDefined();
  });

  it('unregisterAllWalletConnectWallets tears down every entry', () => {
    const client = fakeClient();
    registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1', ADDR_A),
      client,
      icon: ICON,
    });
    registerWalletConnectSolanaWallet({
      brand: { id: 'solflare', name: 'Solflare (mobile)' },
      session: session('topic-2', ADDR_B),
      client,
      icon: ICON,
    });
    expect(() => unregisterAllWalletConnectWallets()).not.toThrow();
  });

  it('resetWalletConnectRegistry forgets entries without invoking their unregister callbacks', () => {
    let unregisterCalled = false;
    const client: WalletConnectSolanaClient = {
      connect: async () => {
        throw new Error('connect should not run');
      },
      signMessage: async () => new Uint8Array(64),
      signTransaction: async () => '',
      disconnect: async () => {
        unregisterCalled = true;
      },
      listSessions: () => [],
      on: () => () => undefined,
    };
    registerWalletConnectSolanaWallet({
      brand: { id: 'phantom', name: 'Phantom (mobile)' },
      session: session('topic-1'),
      client,
      icon: ICON,
    });
    resetWalletConnectRegistry();
    // `unregisterAllWalletConnectWallets` is a no-op after reset.
    unregisterAllWalletConnectWallets();
    // No disconnect side-effect fired.
    expect(unregisterCalled).toBe(false);
  });
});
