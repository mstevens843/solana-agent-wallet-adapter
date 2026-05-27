import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { RemoteBridgeBackend } from '../remoteBridgeBackend.js';

const ORIGIN = 'http://127.0.0.1:8787';
const TOKEN = 'super-secret';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('RemoteBridgeBackend', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs /bridge/status for capabilities and forwards the auth header', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        backend: 'remote-bridge',
        cluster: ['devnet'],
        supports: {
          signMessage: true,
          signTransaction: true,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: true,
        },
        address: '7F.kdEmptyAddress',
      }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    const caps = await backend.capabilities();
    expect(caps.backend).toBe('remote-bridge');
    expect(caps.address).toBe('7F.kdEmptyAddress');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const [url, init] = call;
    expect((url as URL).href).toBe(`${ORIGIN}/bridge/status`);
    const headers = (init as RequestInit | undefined)?.headers as Headers;
    expect(headers.get('x-agent-wallet-token')).toBe(TOKEN);
  });

  it('getAddress throws ProtocolError when no host is connected', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        backend: 'remote-bridge',
        cluster: ['devnet'],
        supports: {
          signMessage: true,
          signTransaction: true,
          signAndSendTransaction: false,
          multiSign: false,
          simulationPreview: true,
        },
      }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    await expect(backend.getAddress()).rejects.toBeInstanceOf(ProtocolError);
  });

  it('submit POSTs the signing request as JSON', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-1', status: 'approved' }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    const result = await backend.submit({
      kind: 'sign-message',
      message: 'aGVsbG8=',
    } as never);
    expect(result.requestId).toBe('req-1');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      request: { kind: 'sign-message', message: 'aGVsbG8=' },
    });
  });

  it('calls the pending approval hook after a request is queued', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-1', status: 'pending' }),
    );
    const onPendingApproval = vi.fn();
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN, onPendingApproval });
    const request = {
      id: 'req-1',
      kind: 'sign_message',
      payload: { data: 'hello', encoding: 'utf8' },
      cluster: 'devnet',
    } as never;

    const result = await backend.submit(request);

    expect(result.status).toBe('pending');
    expect(onPendingApproval).toHaveBeenCalledWith(result, request);
  });

  it('does not call the pending approval hook for completed submit responses', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-1', status: 'approved' }),
    );
    const onPendingApproval = vi.fn();
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN, onPendingApproval });

    await backend.submit({
      kind: 'sign-message',
      message: 'aGVsbG8=',
    } as never);

    expect(onPendingApproval).not.toHaveBeenCalled();
  });

  it('cancels the queued request when the pending approval hook fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ requestId: 'req-1', status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const onPendingApproval = vi.fn().mockRejectedValueOnce(new Error('popup blocked'));
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN, onPendingApproval });

    await expect(backend.submit({
      id: 'req-1',
      kind: 'sign_message',
      payload: { data: 'hello', encoding: 'utf8' },
      cluster: 'devnet',
    } as never)).rejects.toThrow('popup blocked');

    const cancelUrl = fetchSpy.mock.calls[1]![0] as URL;
    const cancelInit = fetchSpy.mock.calls[1]![1] as RequestInit | undefined;
    expect(cancelUrl.pathname).toBe('/bridge/cancel');
    expect(JSON.parse(String(cancelInit?.body))).toEqual({ requestId: 'req-1' });
  });

  it('poll GETs /bridge/poll with the requestId query', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ requestId: 'req-2', status: 'pending' }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    const result = await backend.poll('req-2' as never);
    expect(result.status).toBe('pending');
    const url = fetchSpy.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe('/bridge/poll');
    expect(url.searchParams.get('requestId')).toBe('req-2');
  });

  it('maps 401 responses to ProtocolError("unauthorized")', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: 'bad token' }, { status: 401 }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: 'wrong' });
    await expect(backend.capabilities()).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('maps non-401 errors to ProtocolError("wallet_unreachable") with the server message', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'boom' } }, { status: 500 }),
    );
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    await expect(backend.capabilities()).rejects.toMatchObject({
      code: 'wallet_unreachable',
      message: 'boom',
    });
  });

  it('wraps fetch network errors as ProtocolError("wallet_unreachable")', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const backend = new RemoteBridgeBackend({ bridgeUrl: ORIGIN, token: TOKEN });
    await expect(backend.capabilities()).rejects.toMatchObject({
      code: 'wallet_unreachable',
    });
  });

  it('appends trailing slash to bridge URL automatically', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ backend: 'x', cluster: [], supports: {} }));
    const backend = new RemoteBridgeBackend({ bridgeUrl: 'http://1.2.3.4:9999', token: TOKEN });
    await backend.capabilities();
    expect((fetchSpy.mock.calls[0]![0] as URL).href).toBe('http://1.2.3.4:9999/bridge/status');
  });
});
