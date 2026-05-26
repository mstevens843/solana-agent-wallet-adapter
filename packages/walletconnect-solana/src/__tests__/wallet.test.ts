import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
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
const BLOCKHASH = '11111111111111111111111111111111';

function buildSession(address = ADDR): WalletConnectSession {
  return { topic: 'topic-1', address, chainId: MAINNET };
}

function buildClient(overrides: Partial<WalletConnectSolanaClient> = {}): WalletConnectSolanaClient {
  return {
    connect: overrides.connect ?? (async () => {
      throw new Error('connect should not be called from the wallet adapter tests');
    }),
    signMessage:
      overrides.signMessage ?? (async () => new Uint8Array(64).fill(7)),
    signTransaction:
      overrides.signTransaction ?? (async () => ({ transaction: 'YQ==' })),
    disconnect: overrides.disconnect ?? (async () => undefined),
    listSessions: overrides.listSessions ?? (() => []),
    on: overrides.on ?? (() => () => undefined),
  };
}

const BRAND = { id: 'phantom', name: 'Phantom (mobile)' } as const;

function buildLegacyTransfer(payer: PublicKey): Uint8Array {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

function buildV0Transfer(payer: PublicKey): Uint8Array {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  return new Uint8Array(new VersionedTransaction(message).serialize());
}

function attachSignature(transactionBytes: Uint8Array, signer: PublicKey, signature: Uint8Array): Uint8Array {
  const transaction = VersionedTransaction.deserialize(transactionBytes);
  transaction.addSignature(signer, signature);
  return new Uint8Array(transaction.serialize());
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function testSignature(fill = 9): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

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
    const signer = Keypair.generate();
    const unsignedTransaction = buildLegacyTransfer(signer.publicKey);
    const signedTransaction = attachSignature(unsignedTransaction, signer.publicKey, testSignature());
    let captured: { topic: string; chainId: string; transactionBase64: string } | null = null;
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async (opts) => {
          captured = opts;
          return { transaction: bytesToBase64(signedTransaction) };
        },
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: unsignedTransaction,
    });
    expect(output?.signedTransaction).toEqual(signedTransaction);
    expect(captured?.topic).toBe('topic-1');
    expect(captured?.chainId).toBe(MAINNET);
    expect(captured?.transactionBase64).toBe(bytesToBase64(unsignedTransaction));
  });

  it('stitches a Backpack-style signature-only response into a legacy transaction', async () => {
    const signer = Keypair.generate();
    const unsignedTransaction = buildLegacyTransfer(signer.publicKey);
    const signature = testSignature(8);
    const wallet = createWalletConnectSolanaWallet({
      brand: { id: 'backpack', name: 'Backpack (mobile)' },
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async () => ({ signature: bs58.encode(signature) }),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account: wallet.accounts[0]!,
      transaction: unsignedTransaction,
    });
    const reparsed = Transaction.from(output!.signedTransaction);
    const attached = reparsed.signatures.find((entry) => entry.publicKey.equals(signer.publicKey));
    expect(new Uint8Array(attached!.signature!)).toEqual(signature);
  });

  it('stitches a Backpack-style signature-only response into a v0 transaction', async () => {
    const signer = Keypair.generate();
    const unsignedTransaction = buildV0Transfer(signer.publicKey);
    const signature = testSignature(7);
    const wallet = createWalletConnectSolanaWallet({
      brand: { id: 'backpack', name: 'Backpack (mobile)' },
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async () => ({ signature: bs58.encode(signature) }),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account: wallet.accounts[0]!,
      transaction: unsignedTransaction,
    });
    const reparsed = VersionedTransaction.deserialize(output!.signedTransaction);
    expect(reparsed.signatures[0]).toEqual(signature);
  });

  it('stitches the signature when the peer returns unsigned transaction bytes plus signature', async () => {
    const signer = Keypair.generate();
    const unsignedTransaction = buildLegacyTransfer(signer.publicKey);
    const signature = testSignature(6);
    const wallet = createWalletConnectSolanaWallet({
      brand: { id: 'backpack', name: 'Backpack (mobile)' },
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async () => ({
          transaction: bytesToBase64(unsignedTransaction),
          signature: bs58.encode(signature),
        }),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account: wallet.accounts[0]!,
      transaction: unsignedTransaction,
    });
    const reparsed = Transaction.from(output!.signedTransaction);
    const attached = reparsed.signatures.find((entry) => entry.publicKey.equals(signer.publicKey));
    expect(new Uint8Array(attached!.signature!)).toEqual(signature);
  });

  it('throws a clear error for malformed Backpack signature bytes', async () => {
    const signer = Keypair.generate();
    const wallet = createWalletConnectSolanaWallet({
      brand: { id: 'backpack', name: 'Backpack (mobile)' },
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async () => ({ signature: bs58.encode(new Uint8Array(63).fill(1)) }),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    await expect(
      wallet.features['solana:signTransaction'].signTransaction({
        account: wallet.accounts[0]!,
        transaction: buildLegacyTransfer(signer.publicKey),
      }),
    ).rejects.toThrow(/signature length unexpected: 63/);
  });

  it('throws when the peer returns no usable transaction or signature', async () => {
    const signer = Keypair.generate();
    const wallet = createWalletConnectSolanaWallet({
      brand: BRAND,
      session: buildSession(signer.publicKey.toBase58()),
      client: buildClient({
        signTransaction: async () => ({}),
      }),
      icon: ICON,
    });
    await wallet.features['standard:connect'].connect();
    await expect(
      wallet.features['solana:signTransaction'].signTransaction({
        account: wallet.accounts[0]!,
        transaction: buildLegacyTransfer(signer.publicKey),
      }),
    ).rejects.toThrow(/neither signed transaction bytes nor a transaction signature/);
  });
});
