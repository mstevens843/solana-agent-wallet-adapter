import { describe, expect, it, vi } from 'vitest';

import type { SigningRequest } from '@solana-agent-wallet-adapter/core';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';

import { approveWithInjectedWallet } from '../injectedWalletApproval.js';

const ADDRESS = 'Wallet111111111111111111111111111111111111';
const OTHER_ADDRESS = 'Other111111111111111111111111111111111111';

describe('approveWithInjectedWallet', () => {
  it('approves Solflare signAndSendTransaction through the in-app provider', async () => {
    const provider = fakeProvider({
      publicKey: ADDRESS,
      signAndSendTransaction: vi.fn(async () => ({ signature: 'txid-solflare' })),
    });

    const approval = await approveWithInjectedWallet({
      wallet: 'solflare',
      sessionAddress: ADDRESS,
      request: requestFor('sign_and_send_transaction', txBase64(), 'base64'),
      windowLike: { solflare: provider },
    });

    expect(approval).toMatchObject({
      status: 'approved',
      result: { signature: 'txid-solflare', txid: 'txid-solflare' },
    });
    expect(provider.signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('approves Phantom signAndSendTransaction by signing then broadcasting when native send is missing', async () => {
    const provider = fakeProvider({
      isPhantom: true,
      publicKey: ADDRESS,
      signTransaction: vi.fn(async () => new Uint8Array([9, 8, 7])),
    });
    const sendRawTransaction = vi.fn(async (bytes: Uint8Array) => {
      expect([...bytes]).toEqual([9, 8, 7]);
      return 'txid-phantom';
    });

    const approval = await approveWithInjectedWallet({
      wallet: 'phantom',
      sessionAddress: ADDRESS,
      request: requestFor('sign_and_send_transaction', txBase64(), 'base64'),
      windowLike: { solana: provider },
      sendRawTransaction,
    });

    expect(approval).toMatchObject({
      status: 'approved',
      result: { signature: 'txid-phantom', txid: 'txid-phantom' },
    });
    expect(provider.signTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('returns signed transaction bytes for signTransaction', async () => {
    const provider = fakeProvider({
      publicKey: ADDRESS,
      signTransaction: vi.fn(async () => new Uint8Array([1, 2, 3])),
    });

    const approval = await approveWithInjectedWallet({
      wallet: 'solflare',
      sessionAddress: ADDRESS,
      request: requestFor('sign_transaction', txBase64(), 'base64'),
      windowLike: { solflare: provider },
    });

    expect(approval).toMatchObject({
      status: 'approved',
      result: { signature: 'AQID' },
    });
  });

  it('returns base58 signatures for signMessage', async () => {
    const provider = fakeProvider({
      publicKey: ADDRESS,
      signMessage: vi.fn(async () => ({ signature: new Uint8Array([1, 2, 3, 4]) })),
    });

    const approval = await approveWithInjectedWallet({
      wallet: 'phantom',
      sessionAddress: ADDRESS,
      request: requestFor('sign_message', 'hello', 'utf8'),
      windowLike: { phantom: { solana: provider } },
    });

    expect(approval).toMatchObject({
      status: 'approved',
      result: { signature: '2VfUX' },
    });
  });

  it('maps wallet rejections to rejected approval resources', async () => {
    const provider = fakeProvider({
      publicKey: ADDRESS,
      signMessage: vi.fn(async () => {
        throw { code: 4001, message: 'User rejected request' };
      }),
    });

    const approval = await approveWithInjectedWallet({
      wallet: 'solflare',
      sessionAddress: ADDRESS,
      request: requestFor('sign_message', 'hello', 'utf8'),
      windowLike: { solflare: provider },
    });

    expect(approval).toMatchObject({
      status: 'rejected',
      error: { code: 'user_rejected' },
    });
  });

  it('fails when the injected provider account does not match the QR session', async () => {
    const approval = await approveWithInjectedWallet({
      wallet: 'phantom',
      sessionAddress: ADDRESS,
      request: requestFor('sign_message', 'hello', 'utf8'),
      windowLike: { phantom: { solana: fakeProvider({ publicKey: OTHER_ADDRESS }) } },
    });

    expect(approval).toMatchObject({
      status: 'failed',
      error: { code: 'unauthorized' },
    });
  });

  it('returns null when no matching injected provider is available', async () => {
    await expect(approveWithInjectedWallet({
      wallet: 'solflare',
      sessionAddress: ADDRESS,
      request: requestFor('sign_message', 'hello', 'utf8'),
      windowLike: { solana: fakeProvider({ isPhantom: true, publicKey: ADDRESS }) },
    })).resolves.toBeNull();
  });
});

function fakeProvider(options: Record<string, unknown>): any {
  return {
    publicKey: {
      toBase58: () => options.publicKey,
    },
    ...options,
  };
}

function requestFor(
  kind: SigningRequest['kind'],
  data: string,
  encoding: SigningRequest['payload']['encoding'],
): SigningRequest {
  return {
    id: `req_${kind}`,
    kind,
    payload: { data, encoding },
    cluster: 'devnet',
  };
}

function txBase64(): string {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 1,
    }),
  );
  const bytes = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
