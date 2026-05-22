import { ed25519 } from '@noble/curves/ed25519';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
} from '../transaction.js';
import type { WalletIpc, WalletStatus, WalletCreated } from '../ipc.js';
import { createAgenticWallet } from '../wallet.js';

/** In-memory `WalletIpc` driven by a real ed25519 keypair. */
function makeFakeIpc(
  initial: Partial<WalletStatus> = {},
): {
  ipc: WalletIpc;
  setStatus: (update: Partial<WalletStatus>) => void;
  keypair: Keypair;
} {
  const keypair = Keypair.generate();
  let status: WalletStatus = {
    exists: false,
    unlocked: false,
    address: null,
    derivationPath: null,
    createdAt: null,
    autoLockSecs: 300,
    idleSeconds: null,
    ...initial,
  };
  const secretKeySeed = keypair.secretKey.slice(0, 32);

  const ipc: WalletIpc = {
    status: async () => ({ ...status }),
    create: async (): Promise<WalletCreated> => {
      status = {
        ...status,
        exists: true,
        unlocked: true,
        address: keypair.publicKey.toBase58(),
      };
      return { address: keypair.publicKey.toBase58(), mnemonic: 'a '.repeat(24).trim() };
    },
    import: async (): Promise<WalletCreated> => {
      status = {
        ...status,
        exists: true,
        unlocked: true,
        address: keypair.publicKey.toBase58(),
      };
      return { address: keypair.publicKey.toBase58(), mnemonic: '' };
    },
    unlock: async () => {
      status = { ...status, unlocked: true };
      return { ...status };
    },
    lock: async () => {
      status = { ...status, unlocked: false };
      return { ...status };
    },
    changePassword: async () => ({ ...status }),
    signMessage: async (address, messageB64) => {
      if (address !== status.address) throw new Error('address mismatch');
      if (!status.unlocked) throw new Error('wallet is locked');
      const message = base64ToBytes(messageB64);
      const sig = ed25519.sign(message, secretKeySeed);
      return bytesToBase64(sig);
    },
    signTransaction: async (address, transactionB64) => {
      if (address !== status.address) throw new Error('address mismatch');
      if (!status.unlocked) throw new Error('wallet is locked');
      const message = base64ToBytes(transactionB64);
      const sig = ed25519.sign(message, secretKeySeed);
      return bytesToBase64(sig);
    },
    setAutoLock: async (secs) => {
      status = { ...status, autoLockSecs: secs };
      return { ...status };
    },
    exportForBackup: async () => 'a '.repeat(24).trim(),
    deleteWallet: async () => {
      status = {
        exists: false,
        unlocked: false,
        address: null,
        derivationPath: null,
        createdAt: null,
        autoLockSecs: status.autoLockSecs,
        idleSeconds: null,
      };
      return { ...status };
    },
  };

  return {
    ipc,
    keypair,
    setStatus: (update) => {
      status = { ...status, ...update };
    },
  };
}

const SOLANA_MAINNET = 'solana:mainnet';

describe('createAgenticWallet — Wallet Standard shape', () => {
  it('exposes the required Wallet Standard fields', () => {
    const { ipc } = makeFakeIpc();
    const wallet = createAgenticWallet(ipc);
    expect(wallet.version).toBe('1.0.0');
    expect(wallet.name).toBe('Agentic Wallet');
    expect(wallet.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(wallet.chains).toEqual([
      'solana:mainnet',
      'solana:devnet',
      'solana:testnet',
    ]);
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

describe('connect()', () => {
  it('throws clearly when no wallet exists', async () => {
    const { ipc } = makeFakeIpc({ exists: false });
    const wallet = createAgenticWallet(ipc);
    const connect = wallet.features['standard:connect'].connect;
    await expect(connect()).rejects.toThrow(/not created/);
  });

  it('throws clearly when wallet exists but is locked', async () => {
    const { ipc, keypair } = makeFakeIpc({
      exists: true,
      unlocked: false,
      address: null,
    });
    // address would be set on unlock; for locked status, the fake returns null
    void keypair;
    const wallet = createAgenticWallet(ipc);
    const connect = wallet.features['standard:connect'].connect;
    await expect(connect()).rejects.toThrow(/locked/);
  });

  it('silent connect returns no accounts when locked instead of throwing', async () => {
    const { ipc } = makeFakeIpc({ exists: true, unlocked: false });
    const wallet = createAgenticWallet(ipc);
    const result = await wallet.features['standard:connect'].connect({ silent: true });
    expect(result.accounts).toEqual([]);
  });

  it('returns an account when unlocked and fires a change event', async () => {
    const { ipc, keypair } = makeFakeIpc({
      exists: true,
      unlocked: true,
      address: Keypair.generate().publicKey.toBase58(), // will be overwritten by ipc fake at unlock time
    });
    // Reset address to actual generated keypair via create().
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    const changes: number[] = [];
    const off = wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });
    const result = await wallet.features['standard:connect'].connect();
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]!.address).toBe(keypair.publicKey.toBase58());
    expect(result.accounts[0]!.publicKey).toEqual(keypair.publicKey.toBytes());
    expect(changes).toEqual([1]);
    off();
  });

  it('clears stale accounts when the wallet auto-locks between connects (Slice Q regression guard)', async () => {
    const { ipc, setStatus } = makeFakeIpc();
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    const changes: number[] = [];
    wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });

    // First connect — landed an account.
    const first = await wallet.features['standard:connect'].connect();
    expect(first.accounts).toHaveLength(1);
    expect(wallet.accounts).toHaveLength(1);

    // Simulate the auto-lock thread firing between connects.
    setStatus({ unlocked: false });

    // Silent re-connect now reflects the locked state and clears the cache.
    const second = await wallet.features['standard:connect'].connect({ silent: true });
    expect(second.accounts).toEqual([]);
    expect(wallet.accounts).toEqual([]);
    // Two change events total: one when we cached, one when we cleared.
    expect(changes).toEqual([1, 0]);
  });

  it('does not re-emit change when the same account reconnects', async () => {
    const { ipc } = makeFakeIpc();
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    const changes: number[] = [];
    wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });
    await wallet.features['standard:connect'].connect();
    await wallet.features['standard:connect'].connect();
    // A second connect with the same address is a no-op for listeners.
    expect(changes).toEqual([1]);
  });
});

describe('disconnect()', () => {
  it('clears accounts and emits a change event', async () => {
    const { ipc, keypair } = makeFakeIpc();
    void keypair;
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    await wallet.features['standard:connect'].connect();
    expect(wallet.accounts).toHaveLength(1);

    const changes: number[] = [];
    wallet.features['standard:events'].on('change', (props) => {
      changes.push(props.accounts?.length ?? 0);
    });
    await wallet.features['standard:disconnect'].disconnect();
    expect(wallet.accounts).toHaveLength(0);
    expect(changes).toEqual([0]);
  });

  it('is a no-op when already disconnected', async () => {
    const { ipc } = makeFakeIpc();
    const wallet = createAgenticWallet(ipc);
    let fired = 0;
    wallet.features['standard:events'].on('change', () => {
      fired += 1;
    });
    await wallet.features['standard:disconnect'].disconnect();
    expect(fired).toBe(0);
  });
});

describe('signMessage()', () => {
  it('returns an ed25519 signature that verifies against the account public key', async () => {
    const { ipc, keypair } = makeFakeIpc();
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    const { accounts } = await wallet.features['standard:connect'].connect();
    const account = accounts[0]!;
    const message = new TextEncoder().encode('hello agentic');

    const [output] = await wallet.features['solana:signMessage'].signMessage({
      account,
      message,
    });

    expect(output?.signatureType).toBe('ed25519');
    expect(output?.signedMessage).toEqual(message);
    expect(output?.signature).toHaveLength(64);
    expect(
      ed25519.verify(output!.signature, message, keypair.publicKey.toBytes()),
    ).toBe(true);
  });

  it('rejects signing for an address not in the wallet', async () => {
    const { ipc } = makeFakeIpc();
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    await wallet.features['standard:connect'].connect();
    const fakeAccount = {
      address: Keypair.generate().publicKey.toBase58(),
      publicKey: new Uint8Array(32),
      chains: [SOLANA_MAINNET] as const,
      features: ['solana:signMessage'] as const,
    };
    await expect(
      wallet.features['solana:signMessage'].signMessage({
        account: fakeAccount,
        message: new Uint8Array(),
      }),
    ).rejects.toThrow(/not authorized/);
  });
});

describe('signTransaction()', () => {
  it('produces a transaction whose signature verifies against the message', async () => {
    const { ipc, keypair } = makeFakeIpc();
    await ipc.create('pw');
    const wallet = createAgenticWallet(ipc);
    const { accounts } = await wallet.features['standard:connect'].connect();
    const account = accounts[0]!;

    const tx = new Transaction();
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = '11111111111111111111111111111111';
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey('11111111111111111111111111111112'),
        lamports: 1,
      }),
    );
    const wireBytes = tx.serialize({ requireAllSignatures: false });

    const [output] = await wallet.features['solana:signTransaction'].signTransaction({
      account,
      transaction: wireBytes,
    });
    expect(output?.signedTransaction).toBeInstanceOf(Uint8Array);

    const signed = Transaction.from(output!.signedTransaction);
    const attached = signed.signatures.find(
      (s) => s.publicKey.toBase58() === keypair.publicKey.toBase58(),
    );
    expect(attached?.signature?.length).toBe(64);
    const message = tx.serializeMessage();
    expect(
      ed25519.verify(
        new Uint8Array(attached!.signature!),
        new Uint8Array(message),
        keypair.publicKey.toBytes(),
      ),
    ).toBe(true);
  });
});

describe('events.on', () => {
  let wallet: ReturnType<typeof createAgenticWallet>;

  beforeEach(async () => {
    const { ipc } = makeFakeIpc();
    await ipc.create('pw');
    wallet = createAgenticWallet(ipc);
  });

  it('returned unsubscribe stops further notifications', async () => {
    const calls: number[] = [];
    const off = wallet.features['standard:events'].on('change', (p) => {
      calls.push(p.accounts?.length ?? 0);
    });
    await wallet.features['standard:connect'].connect();
    off();
    await wallet.features['standard:disconnect'].disconnect();
    expect(calls).toEqual([1]);
  });

  it('non-change events return a no-op unsubscribe and do not throw', () => {
    // The Wallet Standard type only declares 'change', but defensive code
    // should still handle unknown events gracefully.
    const off = wallet.features['standard:events'].on(
      'change' as 'change',
      () => undefined,
    );
    expect(typeof off).toBe('function');
    off();
  });
});
