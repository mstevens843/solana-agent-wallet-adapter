import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { RemoteRelayBackend } from '../remoteRelayBackend.js';

const BASE = 'https://agentic-signer.com';
const UUID = '01234567-89ab-4def-8123-456789abcdef';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('RemoteRelayBackend', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('capabilities() GETs /api/pair/:uuid/host and folds address into the capabilities', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        address: '7F.kdEmptyAddress',
        walletName: 'Phantom (mobile)',
        capabilities: {
          backend: 'remote-relay',
          cluster: ['mainnet-beta'],
          supports: {
            signMessage: true,
            signTransaction: true,
            signAndSendTransaction: false,
            multiSign: false,
            simulationPreview: false,
          },
        },
      }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    const caps = await backend.capabilities();
    expect(caps.address).toBe('7F.kdEmptyAddress');
    expect(caps.backend).toBe('remote-relay');
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe(`${BASE}/api/pair/${UUID}/host`);
  });

  it('capabilities() throws ProtocolError on 404 (host not yet registered)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'pairing_not_registered' }, { status: 404 }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    await expect(backend.capabilities()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('submit() POSTs the signing request body', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-1', status: 'pending' }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    const result = await backend.submit({
      kind: 'sign-message',
      message: 'aGVsbG8=',
    } as never);
    expect(result.requestId).toBe('req-1');
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe(`${BASE}/api/pair/${UUID}/submit`);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      request: { kind: 'sign-message', message: 'aGVsbG8=' },
    });
  });

  it('poll() GETs /api/pair/:uuid/submit/:requestId and returns the ApprovalResource', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        requestId: 'req-2',
        status: 'approved',
        result: { signature: 'abc' },
      }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    const result = await backend.poll('req-2' as never);
    expect(result.status).toBe('approved');
    expect((result.result as { signature: string }).signature).toBe('abc');
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toBe(`${BASE}/api/pair/${UUID}/submit/req-2`);
  });

  it('poll() pending response surfaces as ApprovalResource with status pending', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-3', status: 'pending' }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    const result = await backend.poll('req-3' as never);
    expect(result.status).toBe('pending');
    expect(result.result).toBeUndefined();
  });

  it('poll() treats relay rate limits as still pending', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'rate_limited', retryAfterMs: 0 }, { status: 429 }),
    );
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID, rateLimitRetryMs: 0 });
    const result = await backend.poll('req-3' as never);
    expect(result).toEqual({ requestId: 'req-3', status: 'pending' });
  });

  it('cancel() is a no-op (relay has no cancellation primitive)', async () => {
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    await expect(backend.cancel('whatever' as never)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('wraps fetch network errors as ProtocolError("wallet_unreachable")', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    await expect(backend.capabilities()).rejects.toMatchObject({
      code: 'wallet_unreachable',
    });
  });

  it('submit() retries relay rate limits before returning the approval', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', retryAfterMs: 0 }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ requestId: 'req-4', status: 'pending' }));
    const backend = new RemoteRelayBackend({
      baseUrl: BASE,
      pairingUuid: UUID,
      rateLimitRetryMs: 0,
      submitRetryCount: 1,
    });
    const result = await backend.submit({ kind: 'sign-message' } as never);
    expect(result.requestId).toBe('req-4');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws ProtocolError when submit rate limits out after retries', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', retryAfterMs: 0 }, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited', retryAfterMs: 0 }, { status: 429 }));
    const backend = new RemoteRelayBackend({
      baseUrl: BASE,
      pairingUuid: UUID,
      rateLimitRetryMs: 0,
      submitRetryCount: 1,
    });
    await expect(backend.submit({} as never)).rejects.toMatchObject({
      code: 'wallet_unreachable',
      message: 'Pairing relay is rate-limited. Retry in 0s.',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws ProtocolError on non-OK non-404 non-rate-limit responses', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'server_broke' }, { status: 500 }));
    const backend = new RemoteRelayBackend({ baseUrl: BASE, pairingUuid: UUID });
    await expect(backend.submit({} as never)).rejects.toBeInstanceOf(ProtocolError);
  });

  it('strips a trailing slash from baseUrl', () => {
    const backend = new RemoteRelayBackend({ baseUrl: `${BASE}/`, pairingUuid: UUID });
    // No fetch is called yet — just confirm the constructor's normalisation
    // by reaching into capabilities() and inspecting the constructed URL.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ address: 'a', walletName: 'w', capabilities: {} }));
    void backend.capabilities();
    // Allow the microtask to run.
    return Promise.resolve().then(() => {
      const url = fetchSpy.mock.calls[0]![0] as string;
      expect(url.startsWith(`${BASE}/`)).toBe(true);
      expect(url.includes('//api/pair')).toBe(false);
    });
  });
});
