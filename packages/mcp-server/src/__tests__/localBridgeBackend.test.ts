import { describe, expect, it } from 'vitest';

import { newSigningRequestId } from '@solana-agent-wallet-adapter/core';

import { LocalBridgeBackend } from '../localBridgeBackend.js';

describe('LocalBridgeBackend', () => {
  it('requires a connected browser wallet before returning an address', async () => {
    const backend = new LocalBridgeBackend({ cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' });

    await expect(backend.getAddress()).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('queues pending requests for the browser host and resolves them', async () => {
    const backend = new LocalBridgeBackend({ cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' });
    backend.setApprovalBaseUrl('http://127.0.0.1:8787/');
    backend.connectHost('11111111111111111111111111111111', {
      backend: 'test-host',
      cluster: ['devnet'],
      supports: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        multiSign: false,
        simulationPreview: false,
      },
      address: '11111111111111111111111111111111',
    });

    const request = {
      id: newSigningRequestId(),
      kind: 'sign_message' as const,
      payload: { data: 'hello', encoding: 'utf8' as const },
      cluster: 'devnet' as const,
    };
    const approval = await backend.submit(request);
    expect(approval.status).toBe('pending');
    expect(approval.approvalUri).toContain('token=');
    expect(backend.nextPendingRequest()).toEqual(request);
    expect(backend.nextPendingRequest()).toBeNull();

    backend.resolveRequest(request.id, { signature: 'sig' });

    await expect(backend.poll(request.id)).resolves.toMatchObject({
      status: 'approved',
      result: { signature: 'sig' },
    });
  });

  it('expires claimed requests instead of returning them again', async () => {
    const backend = new LocalBridgeBackend({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      requestTtlMs: 1,
    });
    backend.connectHost('11111111111111111111111111111111', {
      backend: 'test-host',
      cluster: ['devnet'],
      supports: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        multiSign: false,
        simulationPreview: false,
      },
      address: '11111111111111111111111111111111',
    });

    const request = {
      id: newSigningRequestId(),
      kind: 'sign_message' as const,
      payload: { data: 'hello', encoding: 'utf8' as const },
      cluster: 'devnet' as const,
    };
    await backend.submit(request);
    expect(backend.nextPendingRequest()).toEqual(request);
    expect(backend.nextPendingRequest()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(backend.poll(request.id)).resolves.toMatchObject({
      status: 'expired',
    });
    expect(backend.nextPendingRequest()).toBeNull();
  });
});
