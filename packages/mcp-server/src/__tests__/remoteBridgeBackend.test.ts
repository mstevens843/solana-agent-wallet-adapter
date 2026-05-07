import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteBridgeBackend } from '../remoteBridgeBackend.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('RemoteBridgeBackend', () => {
  it('reads capabilities from the running bridge', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      backend: 'local-browser-bridge',
      cluster: ['mainnet-beta'],
      supports: {
        signMessage: true,
        signTransaction: true,
        signAndSendTransaction: true,
        multiSign: false,
        simulationPreview: false,
      },
      address: '11111111111111111111111111111111',
    })) as typeof fetch;

    const backend = new RemoteBridgeBackend({
      bridgeUrl: 'http://127.0.0.1:8787',
      token: 'local-agent-wallet',
    });

    await expect(backend.getAddress()).resolves.toBe('11111111111111111111111111111111');
    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]?.toString()).toContain(
      'token=local-agent-wallet',
    );
  });

  it('surfaces a clear error when the bridge is offline', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const backend = new RemoteBridgeBackend({
      bridgeUrl: 'http://127.0.0.1:8787',
      token: 'local-agent-wallet',
    });

    await expect(backend.capabilities()).rejects.toMatchObject({
      code: 'wallet_unreachable',
    });
  });

  it('submits requests to the bridge daemon instead of owning port 8787', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      requestId: 'sar_test',
      status: 'pending',
      approvalUri: 'http://127.0.0.1:8787/?token=local-agent-wallet',
    })) as typeof fetch;

    const backend = new RemoteBridgeBackend({
      bridgeUrl: 'http://127.0.0.1:8787',
      token: 'local-agent-wallet',
    });
    await backend.submit({
      id: 'sar_test',
      kind: 'sign_message',
      payload: { data: 'hello', encoding: 'utf8' },
      cluster: 'mainnet-beta',
    });

    expect(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]?.toString()).toContain('/bridge/submit');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
