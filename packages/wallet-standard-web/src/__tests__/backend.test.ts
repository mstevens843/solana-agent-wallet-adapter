import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SolanaSignAndSendTransaction, SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, StandardDisconnect } from '@wallet-standard/features';

import type { SigningRequest } from '@solana-agent-wallet-adapter/core';

import { WalletStandardWebBackend } from '../backend.js';

const connectionState = vi.hoisted(() => ({
  latestCalls: [] as Array<unknown>,
  sendCalls: [] as Array<{ transaction: Uint8Array; options: unknown }>,
  confirmCalls: [] as Array<{ txid: string; commitment: unknown }>,
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: class {
      constructor(
        readonly url: string,
        readonly commitment: string,
      ) {}

      async getLatestBlockhashAndContext(commitment: string) {
        connectionState.latestCalls.push({ commitment, url: this.url });
        return {
          context: { slot: 123 },
          value: {
            blockhash: 'Blockhash111111111111111111111111111111111',
            lastValidBlockHeight: 456,
          },
        };
      }

      async sendRawTransaction(transaction: Uint8Array, options: unknown) {
        connectionState.sendCalls.push({ transaction, options });
        return 'RpcTxid111111111111111111111111111111111111';
      }

      async confirmTransaction(txid: string, commitment: unknown) {
        connectionState.confirmCalls.push({ txid, commitment });
        return { value: { err: null } };
      }
    },
  };
});

describe('WalletStandardWebBackend', () => {
  beforeEach(() => {
    connectionState.latestCalls.length = 0;
    connectionState.sendCalls.length = 0;
    connectionState.confirmCalls.length = 0;
  });

  it('rejects cluster mismatches at construction', () => {
    expect(
      () => new WalletStandardWebBackend({ wallet: fakeWallet({ chains: ['solana:devnet'] }), cluster: 'mainnet-beta' }),
    ).toThrow(/does not advertise support/);
  });

  it('connects once and reuses the selected account', async () => {
    const wallet = fakeWallet();
    const backend = new WalletStandardWebBackend({ wallet, cluster: 'devnet' });

    await expect(backend.getAddress()).resolves.toBe('FakeAddress111111111111111111111111111111');
    await expect(backend.getAddress()).resolves.toBe('FakeAddress111111111111111111111111111111');
    expect(wallet.connectCalls()).toBe(1);
  });

  it('can request silent reconnect without changing normal connect behavior', async () => {
    const wallet = fakeWallet();
    const backend = new WalletStandardWebBackend({ wallet, cluster: 'devnet' });

    await expect(backend.connect({ silent: true })).resolves.toBe('FakeAddress111111111111111111111111111111');

    expect(wallet.connectCalls()).toBe(1);
    expect(wallet.connectInputs()).toEqual([{ silent: true }]);
  });

  it('signs messages through a pending approval lifecycle', async () => {
    const backend = new WalletStandardWebBackend({ wallet: fakeWallet(), cluster: 'devnet' });
    const request = requestFor('sign_message', 'hello', 'utf8');

    const pending = await backend.submit(request);
    expect(pending).toEqual({ requestId: request.id, status: 'pending' });

    await waitForSettled();
    await expect(backend.poll(request.id)).resolves.toEqual({
      requestId: request.id,
      status: 'approved',
      result: { signature: '2VfUX' },
    });
  });

  it('signs and returns base64 transaction bytes', async () => {
    const backend = new WalletStandardWebBackend({ wallet: fakeWallet(), cluster: 'devnet' });
    const request = requestFor('sign_transaction', btoa('\x01\x02\x03'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    await expect(backend.poll(request.id)).resolves.toMatchObject({
      status: 'approved',
      result: { signature: btoa('\x01\x02\x03\x09') },
    });
  });

  it('signs and sends transactions with txid equal to the wallet signature', async () => {
    const backend = new WalletStandardWebBackend({ wallet: fakeWallet(), cluster: 'devnet' });
    const request = requestFor('sign_and_send_transaction', btoa('\x04\x05'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    const approval = await backend.poll(request.id);
    expect(approval.status).toBe('approved');
    expect(approval.result?.signature).toBe('4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw');
    expect(approval.result?.txid).toBe(approval.result?.signature);
    expect(connectionState.latestCalls).toHaveLength(1);
  });

  it('uses sign-then-send for Backpack instead of native sign-and-send', async () => {
    const wallet = fakeWallet({ name: 'Backpack' });
    const backend = new WalletStandardWebBackend({ wallet, cluster: 'devnet' });
    const request = requestFor('sign_and_send_transaction', btoa('\x04\x05'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    const approval = await backend.poll(request.id);

    expect(approval).toMatchObject({
      status: 'approved',
      result: {
        signature: 'RpcTxid111111111111111111111111111111111111',
        txid: 'RpcTxid111111111111111111111111111111111111',
      },
    });
    expect(wallet.signTransactionCalls()).toBe(1);
    expect(wallet.signAndSendCalls()).toBe(0);
    expect(connectionState.sendCalls).toHaveLength(1);
    expect(connectionState.confirmCalls).toEqual([
      { txid: 'RpcTxid111111111111111111111111111111111111', commitment: 'confirmed' },
    ]);
  });

  it('passes minContextSlot and send options to native Phantom sign-and-send', async () => {
    const wallet = fakeWallet({ name: 'Phantom' });
    const backend = new WalletStandardWebBackend({ wallet, cluster: 'devnet' });
    const request = requestFor('sign_and_send_transaction', btoa('\x04\x05'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    await backend.poll(request.id);

    expect(wallet.signAndSendCalls()).toBe(1);
    expect(wallet.lastSignAndSendInput()?.options).toMatchObject({
      minContextSlot: 123,
      preflightCommitment: 'confirmed',
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 3,
    });
  });

  it('falls back to sign-then-send when native sign-and-send is unavailable', async () => {
    const wallet = fakeWallet({ includeSignAndSend: false });
    const backend = new WalletStandardWebBackend({ wallet, cluster: 'devnet' });
    const request = requestFor('sign_and_send_transaction', btoa('\x04\x05'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    const approval = await backend.poll(request.id);

    expect(approval.result?.txid).toBe('RpcTxid111111111111111111111111111111111111');
    expect(wallet.signTransactionCalls()).toBe(1);
  });

  it('fails sign-and-send when no signing path is available', async () => {
    const backend = new WalletStandardWebBackend({
      wallet: fakeWallet({ includeSignTransaction: false, includeSignAndSend: false }),
      cluster: 'devnet',
    });
    const request = requestFor('sign_and_send_transaction', btoa('\x04\x05'), 'base64');

    await backend.submit(request);
    await waitForSettled();
    await expect(backend.poll(request.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'invalid_request' },
    });
  });

  it('cancels in-flight approvals', async () => {
    const backend = new WalletStandardWebBackend({
      wallet: fakeWallet({ neverResolveMessage: true }),
      cluster: 'devnet',
    });
    const request = requestFor('sign_message', 'hello', 'utf8');

    await backend.submit(request);
    await backend.cancel(request.id);
    await expect(backend.poll(request.id)).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'user_rejected' },
    });
  });

  it('reports unsupported simulation explicitly', async () => {
    const backend = new WalletStandardWebBackend({ wallet: fakeWallet(), cluster: 'devnet' });
    await expect(backend.simulate()).rejects.toMatchObject({ code: 'unsupported_method' });
  });
});

function requestFor(
  kind: SigningRequest['kind'],
  data: string,
  encoding: SigningRequest['payload']['encoding'],
): SigningRequest {
  return {
    id: `sar_${kind}`,
    kind,
    payload: { data, encoding },
    cluster: 'devnet',
  };
}

function fakeWallet(options: {
  name?: string;
  chains?: string[];
  neverResolveMessage?: boolean;
  includeSignTransaction?: boolean;
  includeSignAndSend?: boolean;
} = {}): Wallet & {
  connectCalls(): number;
  connectInputs(): unknown[];
  signTransactionCalls(): number;
  signAndSendCalls(): number;
  lastSignAndSendInput(): { options?: unknown } | undefined;
} {
  let connectCalls = 0;
  const connectInputs: unknown[] = [];
  let signTransactionCalls = 0;
  let signAndSendCalls = 0;
  let lastSignAndSendInput: { options?: unknown } | undefined;
  const chain = 'solana:devnet';
  const includeSignTransaction = options.includeSignTransaction ?? true;
  const includeSignAndSend = options.includeSignAndSend ?? true;
  const account = {
    address: 'FakeAddress111111111111111111111111111111',
    publicKey: new Uint8Array([1, 2, 3]),
    chains: [chain],
    features: [
      SolanaSignMessage,
      ...(includeSignTransaction ? [SolanaSignTransaction] : []),
      ...(includeSignAndSend ? [SolanaSignAndSendTransaction] : []),
    ],
  } as unknown as WalletAccount;

  const features: Record<string, unknown> = {
    [StandardConnect]: {
      version: '1.0.0',
      connect: async (input?: unknown) => {
        connectCalls += 1;
        connectInputs.push(input);
        return { accounts: [account] };
      },
    },
    [StandardDisconnect]: {
      version: '1.0.0',
      disconnect: async () => undefined,
    },
    [SolanaSignMessage]: {
      version: '1.0.0',
      signMessage: async () => {
        if (options.neverResolveMessage) {
          await new Promise(() => undefined);
        }
        return [{ signedMessage: new Uint8Array([1]), signature: new Uint8Array([1, 2, 3, 4]) }];
      },
    },
  };

  if (includeSignTransaction) {
    features[SolanaSignTransaction] = {
      version: '1.0.0',
      signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
        signTransactionCalls += 1;
        return [{ signedTransaction: new Uint8Array([...transaction, 9]) }];
      },
    };
  }

  if (includeSignAndSend) {
    features[SolanaSignAndSendTransaction] = {
      version: '1.0.0',
      signAndSendTransaction: async (input: { options?: unknown }) => {
        signAndSendCalls += 1;
        lastSignAndSendInput = input;
        return [{ signature: new Uint8Array(Array.from({ length: 32 }, (_value, index) => index + 1)) }];
      },
    };
  }

  const wallet = {
    version: '1.0.0',
    name: options.name ?? 'Fake Wallet',
    icon: 'data:image/svg+xml,<svg></svg>',
    chains: options.chains ?? [chain],
    features,
    accounts: [account],
    connectCalls: () => connectCalls,
    connectInputs: () => connectInputs,
    signTransactionCalls: () => signTransactionCalls,
    signAndSendCalls: () => signAndSendCalls,
    lastSignAndSendInput: () => lastSignAndSendInput,
  };
  return wallet as unknown as Wallet & {
    connectCalls(): number;
    connectInputs(): unknown[];
    signTransactionCalls(): number;
    signAndSendCalls(): number;
    lastSignAndSendInput(): { options?: unknown } | undefined;
  };
}

async function waitForSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
