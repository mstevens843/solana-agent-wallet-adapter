import { describe, expect, it } from 'vitest';

import { solanaWalletConnectChainId } from '../chains.js';
import type {
  WalletConnectSession,
  WalletConnectSolanaClient,
} from '../client.js';
import { createWalletConnectSolanaWallet } from '../wallet.js';

const MAINNET = solanaWalletConnectChainId('mainnet-beta');
const ADDR = 'EmaginedRust11111111111111111111111111111111';
const ICON = 'data:image/svg+xml;base64,PHN2Zy8+' as const;

function buildSession(): WalletConnectSession {
  return { topic: 'topic-1', address: ADDR, chainId: MAINNET };
}

function buildClient(overrides: Partial<WalletConnectSolanaClient> = {}): WalletConnectSolanaClient {
  return {
    connect: overrides.connect ?? (async () => {
      throw new Error('connect should not be called from the wallet adapter tests');
    }),
    signMessage:
      overrides.signMessage ?? (async () => new Uint8Array(64).fill(7)),
    signTransaction:
      overrides.signTransaction ?? (async () => 'YQ=='),
    disconnect: overrides.disconnect ?? (async () => undefined),
    listSessions: overrides.listSessions ?? (() => []),
    on: overrides.on ?? (() => () => undefined),
  };
}

const BRAND = { id: 'phantom', name: 'Phantom (mobile)' } as const;

describe('createWalletConnectSolanaWallet — Wallet Standard shape', () => {
  it('exposes the required Wallet Standard fields', () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient(),
      icon: ICON,
    });
    expect(wallet.version).toBe('1.0.0');
    expect(wallet.name).toBe('Phantom (mobile)');
    expect(wallet.icon).toBe(ICON);
    expect(wallet.chains).toEqual(['solana:mainnet']);
    expect(wallet.accounts).toEqual([]);
    expect(Object.keys(wallet.features).sort()).toEqual([
      'solana:signMessage',
      'solana:signTransaction',
      'standard:connect',
      'standard:disconnect',
      'standard:events',
    ]);
  });

  it('resolves devnet chains via the chains helper', () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: { ...buildSession(), chainId: solanaWalletConnectChainId('devnet') },
      client: buildClient(),
      icon: ICON,
    });
    expect(wallet.chains).toEqual(['solana:devnet']);
  });
});

describe('connect()', () => {
  it('caches the account and emits change once', async () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient(),
      icon: ICON,
    });
    const changes: number[] = [];
    wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });
    const result = await wallet.features['standard:connect'].connect();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.address).toBe(ADDR);
    expect(changes).toEqual([1]);

    // Second connect is idempotent (no extra change event).
    await wallet.features['standard:connect'].connect();
    expect(changes).toEqual([1]);
  });
});

describe('disconnect()', () => {
  it('calls client.disconnect and clears accounts', async () => {
    let disconnectedTopic: string | null = null;
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient({
        disconnect: async (topic) => {
          disconnectedTopic = topic;
        },
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    await wallet.features['standard:disconnect'].disconnect();
    expect(disconnectedTopic).toBe('topic-1');
    expect(wallet.accounts).toHaveLength(0);
  });

  it('tolerates a client.disconnect rejection', async () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient({
        disconnect: async () => {
          throw new Error('peer gone');
        },
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    await expect(wallet.features['standard:disconnect'].disconnect()).resolves.toBeUndefined();
    expect(wallet.accounts).toHaveLength(0);
  });
});

describe('signMessage()', () => {
  it('routes through the client and returns the Wallet Standard shape', async () => {
    const expectedSig = new Uint8Array(64).fill(3);
    let captured: {
      topic: string;
      chainId: string;
      pubkey: string;
      message: Uint8Array;
    } | null = null;
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient({
        signMessage: async (opts) => {
          captured = opts;
          return expectedSig;
        },
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    const message = new TextEncoder().encode('hello wc');
    const [output] = await wallet.features['solana:signMessage'].signMessage({
      account,
      message,
    });
    expect(output?.signedMessage).toEqual(message);
    expect(output?.signature).toEqual(expectedSig);
    expect(output?.signatureType).toBe('ed25519');
    expect(captured).toEqual({
      topic: 'topic-1',
      chainId: MAINNET,
      pubkey: ADDR,
      message,
    });
  });

  it('throws if the wallet returns a non-64-byte signature', async () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient({
        signMessage: async () => new Uint8Array(32),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    await expect(
      wallet.features['solana:signMessage'].signMessage({
        account,
        message: new Uint8Array(),
      }),
    ).rejects.toThrow(/signature length/);
  });

  it('rejects an account that is not on this wallet', async () => {
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient(),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    await expect(
      wallet.features['solana:signMessage'].signMessage({
        account: {
          address: 'Different11111111111111111111111111111111111',
          publicKey: new Uint8Array(32),
          chains: ['solana:mainnet'],
          features: ['solana:signMessage'],
        },
        message: new Uint8Array(),
      }),
    ).rejects.toThrow(/not authorized/);
  });
});

describe('signTransaction()', () => {
  it('routes through the client and returns decoded transaction bytes', async () => {
    let captured: { topic: string; chainId: string; transactionBase64: string } | null = null;
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(),
      client: buildClient({
        signTransaction: async (opts) => {
          captured = opts;
          return Buffer.from(new Uint8Array([1, 2, 3])).toString('base64');
        },
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    const txBytes = new Uint8Array([10, 20, 30]);
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: txBytes,
    });
    expect(output?.signedTransaction).toEqual(new Uint8Array([1, 2, 3]));
    expect(captured?.topic).toBe('topic-1');
    expect(captured?.chainId).toBe(MAINNET);
    expect(captured?.transactionBase64).toBe(
      Buffer.from(txBytes).toString('base64'),
    );
  });
});
