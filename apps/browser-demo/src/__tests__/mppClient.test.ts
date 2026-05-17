import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MppApiError,
  getMppConfig,
  getMppInbound,
  postMppSessionPay,
  postMppSettle,
} from '../mppClient.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mppClient', () => {
  it('parses config responses and sends cookies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ acceptedRails: ['sol', 'usdc'], maxChallengeAmount: '10' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getMppConfig()).resolves.toEqual({ acceptedRails: ['sol', 'usdc'], maxChallengeAmount: '10' });
    expect(fetchMock).toHaveBeenCalledWith('/api/mpp/config', expect.objectContaining({
      credentials: 'include',
      method: 'GET',
    }));
  });

  it('supports optional signed evidence settle payloads', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      receiptId: 'evidence_mpp_1',
      receiptHash: 'a'.repeat(64),
      signedEvidence: {
        status: 'created',
        receiptId: 'evidence_signed_1',
        receiptHash: 'a'.repeat(64),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await postMppSettle({
      approvalId: 'approval_1',
      txid: 'tx_1',
      signedEvidence: {
        signingMessage: 'mpp-payment-receipt:approval_1:hash',
        signature: 'sig',
        signatureEncoding: 'base58',
      },
    });

    expect(result.signedEvidence?.status).toBe('created');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls[0]?.[1];
    if (!init) throw new Error('Expected fetch init.');
    expect(JSON.parse(String(init.body))).toMatchObject({
      approvalId: 'approval_1',
      signedEvidence: { signatureEncoding: 'base58' },
    });
  });

  it('lists inbound MPP requests and posts session-pay decisions', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/mpp/inbound') {
        return jsonResponse({ inbound: [{ id: 'approval_1', status: 'ready', summary: 'MPP request' }] });
      }
      return jsonResponse({
        approvalId: 'approval_1',
        accepted: true,
        finality: 'voucher_accepted',
        status: 'voucher_accepted',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getMppInbound()).resolves.toMatchObject({
      inbound: [{ id: 'approval_1' }],
    });
    await expect(postMppSessionPay({ approvalId: 'approval_1', sessionId: 'sess_2' })).resolves.toMatchObject({
      accepted: true,
      finality: 'voucher_accepted',
    });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/mpp/session-pay', expect.objectContaining({
      credentials: 'include',
      method: 'POST',
    }));
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ approvalId: 'approval_1', sessionId: 'sess_2' });
  });

  it('wraps non-JSON success responses as invalid_response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', { status: 200 })));

    await expect(getMppConfig()).rejects.toMatchObject({
      name: 'MppApiError',
      code: 'invalid_response',
    } satisfies Partial<MppApiError>);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
