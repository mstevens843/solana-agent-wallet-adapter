import { describe, expect, it } from 'vitest';

import type { WalletBackend } from '../backend.js';
import { SolanaSigningClient } from '../client.js';
import { ProtocolError } from '../errors.js';
import type { ApprovalResource, SigningRequest, SigningRequestId } from '../types.js';

function baseBackend(overrides: Partial<WalletBackend>): WalletBackend {
  return {
    async capabilities() {
      return {
        backend: 'test',
        cluster: ['devnet'],
        supports: {
          signMessage: true,
          signTransaction: true,
          signAndSendTransaction: true,
          multiSign: false,
          simulationPreview: Boolean(overrides.simulate),
        },
      };
    },
    async getAddress() {
      return '11111111111111111111111111111111';
    },
    async submit(request: SigningRequest) {
      return { requestId: request.id, status: 'pending' };
    },
    async poll(requestId: SigningRequestId) {
      return { requestId, status: 'pending' };
    },
    ...overrides,
  };
}

describe('SolanaSigningClient', () => {
  it('resolves signMessage when the backend approval is approved', async () => {
    let submitted: SigningRequest | null = null;
    const client = new SolanaSigningClient({
      backend: baseBackend({
        async submit(request) {
          submitted = request;
          return { requestId: request.id, status: 'pending' };
        },
        async poll(requestId) {
          return {
            requestId,
            status: 'approved',
            result: { signature: 'sig' },
          };
        },
      }),
      pollIntervalMs: 1,
    });

    await expect(
      client.signMessage('hello', { cluster: 'devnet', summary: 'sign hello' }),
    ).resolves.toEqual({ signature: 'sig' });
    expect(submitted).toMatchObject({
      kind: 'sign_message',
      payload: { data: 'hello', encoding: 'utf8' },
      cluster: 'devnet',
      display: { summary: 'sign hello' },
    });
  });

  it('throws ProtocolError(user_rejected) when approval is rejected', async () => {
    const client = new SolanaSigningClient({
      backend: baseBackend({
        async poll(requestId) {
          return rejected(requestId);
        },
      }),
      pollIntervalMs: 1,
    });

    await expect(client.signMessage('hello', { cluster: 'devnet' })).rejects.toMatchObject({
      code: 'user_rejected',
    });
  });

  it('times out and cancels pending approvals', async () => {
    let cancelled: string | null = null;
    const client = new SolanaSigningClient({
      backend: baseBackend({
        async cancel(requestId) {
          cancelled = requestId;
        },
      }),
      pollIntervalMs: 1,
      timeoutMs: 5,
    });

    await expect(client.signMessage('hello', { cluster: 'devnet' })).rejects.toMatchObject({
      code: 'expired',
    });
    expect(cancelled).toMatch(/^sar_[0-9a-f]{24}$/);
  });

  it('delegates explicit cancel calls when supported', async () => {
    let cancelled = false;
    const client = new SolanaSigningClient({
      backend: baseBackend({
        async cancel(requestId) {
          expect(requestId).toBe('sar_cancel');
          cancelled = true;
        },
      }),
    });

    await client.cancel('sar_cancel');
    expect(cancelled).toBe(true);
  });

  it('runs backend simulation and reports unsupported simulation', async () => {
    const client = new SolanaSigningClient({
      backend: baseBackend({
        async simulate(request) {
          expect(request.kind).toBe('sign_transaction');
          return { err: null, logs: ['ok'], unitsConsumed: 1 };
        },
      }),
    });

    await expect(
      client.simulateTransaction('AQID', { cluster: 'devnet', summary: 'simulate' }),
    ).resolves.toEqual({ err: null, logs: ['ok'], unitsConsumed: 1 });

    const unsupported = new SolanaSigningClient({ backend: baseBackend({}) });
    await expect(
      unsupported.simulateTransaction('AQID', { cluster: 'devnet' }),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      unsupported.simulateTransaction('AQID', { cluster: 'devnet' }),
    ).rejects.toMatchObject({ code: 'unsupported_method' });
  });
});

function rejected(requestId: SigningRequestId): ApprovalResource {
  return {
    requestId,
    status: 'rejected',
    error: {
      code: 'user_rejected',
      message: 'User rejected',
      recoverable: false,
    },
  };
}
