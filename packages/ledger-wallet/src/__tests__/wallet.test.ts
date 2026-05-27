import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import type { LedgerIpc } from '../ipc.js';
import {
  LEDGER_WALLET_NAME,
  createLedgerWallet,
  decodeLedgerPublicKey,
} from '../wallet.js';

const ADDR = 'EmaginedRust11111111111111111111111111111111';

function publicKeyBytes(): Uint8Array {
  return bs58.decode(ADDR);
}

function makeIpc(overrides: Partial<LedgerIpc> = {}): LedgerIpc {
  return {
    listDevices: overrides.listDevices ?? (async () => []),
    connect:
      overrides.connect ??
      (async () => ({
        device: {
          vendorId: 0x2C97,
          productId: 0x0005,
          productName: 'Ledger Nano S Plus',
          serialNumber: null,
          manufacturerString: null,
        },
        app: { flags: 0, major: 1, minor: 4, patch: 2 },
      })),
    getAddress:
      overrides.getAddress ??
      (async () => ({
        address: ADDR,
        publicKeyB64: Buffer.from(publicKeyBytes()).toString('base64'),
      })),
    signTransaction:
      overrides.signTransaction ??
      (async () => Buffer.from(new Uint8Array(64).fill(7)).toString('base64')),
    signMessage:
      overrides.signMessage ??
      (async () => Buffer.from(new Uint8Array(64).fill(9)).toString('base64')),
    disconnect: overrides.disconnect ?? (async () => undefined),
  };
}

describe('createLedgerWallet — Wallet Standard shape', () => {
  it('exposes the required fields and the signTransaction feature', () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    expect(wallet.version).toBe('1.0.0');
    expect(wallet.name).toBe(LEDGER_WALLET_NAME);
    expect(wallet.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(wallet.chains).toEqual(['solana:mainnet', 'solana:devnet', 'solana:testnet']);
    expect(wallet.accounts).toEqual([]);
    expect(Object.keys(wallet.features).sort()).toEqual([
      'solana:signMessage',
      'solana:signTransaction',
      'standard:connect',
      'standard:disconnect',
      'standard:events',
    ]);
  });
});

describe('signMessage()', () => {
  it('routes through ipc.signMessage and returns the Wallet Standard shape', async () => {
    const expectedSig = new Uint8Array(64).fill(11);
    let captured: { path: string; b64: string } | null = null;
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        signMessage: async (path, b64) => {
          captured = { path, b64 };
          return Buffer.from(expectedSig).toString('base64');
        },
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    const message = new TextEncoder().encode('agentic sign-in 12345');

    const [output] = await wallet.features['solana:signMessage'].signMessage({
      account,
      message,
    });
    expect(output?.signatureType).toBe('ed25519');
    expect(output?.signedMessage).toEqual(message);
    expect(output?.signature).toEqual(expectedSig);
    expect(captured?.path).toBe(`m/44'/501'/0'/0'`);
    expect(captured?.b64).toBe(Buffer.from(message).toString('base64'));
  });

  it('throws when the Ledger returns a non-64-byte signature', async () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        signMessage: async () => Buffer.from(new Uint8Array(32)).toString('base64'),
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
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

  it('rejects signing for an unauthorized address', async () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
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

describe('connect()', () => {
  it('caches the account and emits change exactly once', async () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    const changes: number[] = [];
    wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });
    const a = await wallet.features['standard:connect'].connect();
    expect(a.accounts).toHaveLength(1);
    expect(a.accounts[0]!.address).toBe(ADDR);
    expect(changes).toEqual([1]);

    // Idempotent.
    await wallet.features['standard:connect'].connect();
    expect(changes).toEqual([1]);
  });
});

describe('disconnect()', () => {
  it('calls ipc.disconnect and clears accounts', async () => {
    let called = false;
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        disconnect: async () => {
          called = true;
        },
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    await wallet.features['standard:disconnect'].disconnect();
    expect(called).toBe(true);
    expect(wallet.accounts).toHaveLength(0);
  });

  it('tolerates a disconnect rejection from the underlying IPC', async () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        disconnect: async () => {
          throw new Error('device already gone');
        },
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    await expect(wallet.features['standard:disconnect'].disconnect()).resolves.toBeUndefined();
    expect(wallet.accounts).toHaveLength(0);
  });
});

describe('signTransaction()', () => {
  it('routes through ipc.signTransaction and attaches the signature to a legacy transaction', async () => {
    const signer = new PublicKey(ADDR);
    const signature = new Uint8Array(64).fill(3);
    let captured: { path: string; b64: string } | null = null;
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        signTransaction: async (path, b64) => {
          captured = { path, b64 };
          return Buffer.from(signature).toString('base64');
        },
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    const account = wallet.accounts[0]!;
    const tx = new Transaction({
      feePayer: signer,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer,
        toPubkey: new PublicKey('11111111111111111111111111111112'),
        lamports: 1,
      }),
    );
    const txBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: txBytes,
    });
    expect(captured?.path).toBe(`m/44'/501'/0'/0'`);
    expect(captured?.b64).toBe(
      Buffer.from(VersionedTransaction.deserialize(txBytes).message.serialize()).toString('base64'),
    );
    const signed = Transaction.from(output!.signedTransaction);
    const attached = signed.signatures.find((entry) => entry.publicKey.equals(signer));
    expect(new Uint8Array(attached!.signature!)).toEqual(signature);
  });

  it('attaches a Ledger signature to a v0 transaction', async () => {
    const signer = new PublicKey(ADDR);
    const signature = new Uint8Array(64).fill(4);
    let capturedB64 = '';
    const message = new TransactionMessage({
      payerKey: signer,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer,
          toPubkey: new PublicKey('11111111111111111111111111111112'),
          lamports: 1,
        }),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        signTransaction: async (_path, b64) => {
          capturedB64 = b64;
          return Buffer.from(signature).toString('base64');
        },
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account: wallet.accounts[0]!,
      transaction: tx.serialize(),
    });
    expect(capturedB64).toBe(Buffer.from(message.serialize()).toString('base64'));
    const reparsed = VersionedTransaction.deserialize(output!.signedTransaction);
    expect(reparsed.signatures[0]).toEqual(signature);
  });

  it('throws when the Ledger returns a non-64-byte transaction signature', async () => {
    const signer = new PublicKey(ADDR);
    const tx = new Transaction({
      feePayer: signer,
      recentBlockhash: '11111111111111111111111111111111',
    }).add(
      SystemProgram.transfer({
        fromPubkey: signer,
        toPubkey: new PublicKey('11111111111111111111111111111112'),
        lamports: 1,
      }),
    );
    const wallet = createLedgerWallet({
      ipc: makeIpc({
        signTransaction: async () => Buffer.from(new Uint8Array(32)).toString('base64'),
      }),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    await expect(
      wallet.features['solana:signTransaction'].signTransaction({
        account: wallet.accounts[0]!,
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      }),
    ).rejects.toThrow(/signature length/);
  });

  it('rejects signing for an address that is not on this wallet', async () => {
    const wallet = createLedgerWallet({
      ipc: makeIpc(),
      address: ADDR,
      publicKey: publicKeyBytes(),
      derivationPath: `m/44'/501'/0'/0'`,
    });
    await wallet.features['standard:connect'].connect();
    await expect(
      wallet.features['solana:signTransaction'].signTransaction({
        account: {
          address: 'Different11111111111111111111111111111111111',
          publicKey: new Uint8Array(32),
          chains: ['solana:mainnet'],
          features: ['solana:signTransaction'],
        },
        transaction: new Uint8Array(),
      }),
    ).rejects.toThrow(/not authorized/);
  });
});

describe('decodeLedgerPublicKey', () => {
  it('matches base58 address bytes', () => {
    const b64 = Buffer.from(publicKeyBytes()).toString('base64');
    const decoded = decodeLedgerPublicKey(ADDR, b64);
    expect(decoded).toEqual(publicKeyBytes());
  });

  it('rejects mismatched pubkey/address', () => {
    const otherKey = new Uint8Array(32).fill(9);
    const b64 = Buffer.from(otherKey).toString('base64');
    expect(() => decodeLedgerPublicKey(ADDR, b64)).toThrow(/do not match/);
  });

  it('rejects wrong-length public key', () => {
    const b64 = Buffer.from(new Uint8Array(16)).toString('base64');
    expect(() => decodeLedgerPublicKey(ADDR, b64)).toThrow(/length/);
  });
});
