import { describe, expect, it } from 'vitest';

import { SolanaSignAndSendTransaction, SolanaSignMessage, SolanaSignTransaction } from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { StandardConnect, StandardDisconnect } from '@wallet-standard/features';

import type { SigningRequest } from '@solana-agent-wallet-adapter/core';

import { WalletStandardWebBackend } from '../backend.js';

describe('WalletStandardWebBackend', () => {
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
  chains?: string[];
  neverResolveMessage?: boolean;
} = {}): Wallet & { connectCalls(): number } {
  let connectCalls = 0;
  const chain = 'solana:devnet';
  const account = {
    address: 'FakeAddress111111111111111111111111111111',
    publicKey: new Uint8Array([1, 2, 3]),
    chains: [chain],
    features: [SolanaSignMessage, SolanaSignTransaction, SolanaSignAndSendTransaction],
  } as unknown as WalletAccount;

  const wallet = {
    version: '1.0.0',
    name: 'Fake Wallet',
    icon: 'data:image/svg+xml,<svg></svg>',
    chains: options.chains ?? [chain],
    features: {
      [StandardConnect]: {
        version: '1.0.0',
        connect: async () => {
          connectCalls += 1;
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
      [SolanaSignTransaction]: {
        version: '1.0.0',
        signTransaction: async ({ transaction }: { transaction: Uint8Array }) => [
          { signedTransaction: new Uint8Array([...transaction, 9]) },
        ],
      },
      [SolanaSignAndSendTransaction]: {
        version: '1.0.0',
        signAndSendTransaction: async () => [
          { signature: new Uint8Array(Array.from({ length: 32 }, (_value, index) => index + 1)) },
        ],
      },
    },
    accounts: [account],
    connectCalls: () => connectCalls,
  };
  return wallet as unknown as Wallet & { connectCalls(): number };
}

async function waitForSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
