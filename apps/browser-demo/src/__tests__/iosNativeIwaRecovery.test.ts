import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  newSigningRequestId,
  type Cluster,
  type SigningRequest,
  type SigningRequestId,
} from '@solana-agent-wallet-adapter/core';

// Controllable mock of the native AgenticNativeWallet Capacitor plugin. vi.mock
// is hoisted above the imports below, so `iosNativeIwa.ts`'s module-level
// registerPlugin() resolves to this object.
const plugin = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getSession: vi.fn(),
  resumeSession: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
  signAllTransactions: vi.fn(),
  signAndSendTransaction: vi.fn(),
  clearState: vi.fn(),
  clearAllState: vi.fn(),
  cancelPending: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => plugin }));

// eslint-disable-next-line import/first
import { NativeIwaWalletBackend } from '../iosNativeIwa.js';

/** Capacitor surfaces a rejected native call as an Error carrying a `.code`. */
function nativeError(message: string): Error {
  return Object.assign(new Error(message), { code: 'NATIVE_WALLET_ADAPTER_ERROR' });
}

function makeSwapRequest(): SigningRequest {
  return {
    id: newSigningRequestId(),
    kind: 'sign_and_send_transaction',
    cluster: 'mainnet-beta',
    payload: { encoding: 'base64', data: 'AQIDBA==' },
  } as unknown as SigningRequest;
}

/** Poll until the fire-and-forget signing chain leaves the pending state. */
async function settle(backend: NativeIwaWalletBackend, id: SigningRequestId) {
  for (let i = 0; i < 100; i += 1) {
    const approval = await backend.poll(id);
    if (approval.status !== 'pending') return approval;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('approval did not settle');
}

function signatureOf(approval: { result?: unknown }): string | undefined {
  return (approval.result as { signature?: string } | undefined)?.signature;
}

describe('NativeIwaWalletBackend self-recovery', () => {
  beforeEach(() => {
    for (const fn of Object.values(plugin)) fn.mockReset();
    // A resumable Keychain session so getAddress() succeeds without a connect
    // round-trip; that keeps `connect` call-counts meaningful below.
    plugin.resumeSession.mockResolvedValue({ connected: true, publicKey: 'PUBKEY' });
    plugin.connect.mockResolvedValue({ publicKey: 'PUBKEY' });
    plugin.cancelPending.mockResolvedValue({ cancelled: true });
  });

  it('reconnects once and retries when a sign fails with INVALID_SESSION', async () => {
    plugin.signAndSendTransaction
      .mockRejectedValueOnce(nativeError('Session expired — reconnect'))
      .mockResolvedValue({ signature: 'SIG', txid: 'SIG' });

    const backend = new NativeIwaWalletBackend({ walletId: 'backpack', cluster: 'mainnet-beta' as Cluster, logLevel: 'silent' });
    const request = makeSwapRequest();
    await backend.submit(request);
    const approval = await settle(backend, request.id);

    expect(approval.status).toBe('approved');
    expect(signatureOf(approval)).toBe('SIG');
    expect(plugin.signAndSendTransaction).toHaveBeenCalledTimes(2);
    expect(plugin.connect).toHaveBeenCalledTimes(1); // the recovery reconnect
  });

  it('releases the native lock and retries once on "Another request is in progress"', async () => {
    plugin.signAndSendTransaction
      .mockRejectedValueOnce(nativeError('Another request is in progress'))
      .mockResolvedValue({ signature: 'SIG', txid: 'SIG' });

    const backend = new NativeIwaWalletBackend({ walletId: 'backpack', cluster: 'mainnet-beta' as Cluster, logLevel: 'silent' });
    const request = makeSwapRequest();
    await backend.submit(request);
    const approval = await settle(backend, request.id);

    expect(approval.status).toBe('approved');
    expect(plugin.cancelPending).toHaveBeenCalledTimes(1);
    expect(plugin.signAndSendTransaction).toHaveBeenCalledTimes(2);
    expect(plugin.connect).not.toHaveBeenCalled(); // lock release, not a reconnect
  });

  it('does not reconnect on an ordinary user rejection', async () => {
    plugin.signAndSendTransaction.mockRejectedValue(nativeError('User rejected the request'));

    const backend = new NativeIwaWalletBackend({ walletId: 'backpack', cluster: 'mainnet-beta' as Cluster, logLevel: 'silent' });
    const request = makeSwapRequest();
    await backend.submit(request);
    const approval = await settle(backend, request.id);

    expect(approval.status).toBe('rejected');
    expect(plugin.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(plugin.connect).not.toHaveBeenCalled();
  });

  it('bounds INVALID_SESSION recovery to a single retry', async () => {
    plugin.signAndSendTransaction.mockRejectedValue(nativeError('Session expired — reconnect'));

    const backend = new NativeIwaWalletBackend({ walletId: 'backpack', cluster: 'mainnet-beta' as Cluster, logLevel: 'silent' });
    const request = makeSwapRequest();
    await backend.submit(request);
    const approval = await settle(backend, request.id);

    expect(approval.status).toBe('failed');
    expect(plugin.signAndSendTransaction).toHaveBeenCalledTimes(2); // original + one retry
    expect(plugin.connect).toHaveBeenCalledTimes(1);
  });

  it('poll TTL expiry releases the native lock, tolerating older binaries', async () => {
    // A sign that never returns a callback keeps the approval pending; only the
    // TTL expiry resolves it. cancelPending rejects to simulate a pre-Fix-C binary.
    plugin.signAndSendTransaction.mockReturnValue(new Promise(() => {}));
    plugin.cancelPending.mockRejectedValue(new Error('not implemented'));

    const backend = new NativeIwaWalletBackend({
      walletId: 'backpack',
      cluster: 'mainnet-beta' as Cluster,
      requestTtlMs: 0,
      logLevel: 'silent',
    });
    const request = makeSwapRequest();
    await backend.submit(request);
    const approval = await settle(backend, request.id);

    expect(approval.status).toBe('expired');
    expect(plugin.cancelPending).toHaveBeenCalled(); // attempted, and its rejection is swallowed
  });
});
