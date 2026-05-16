import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MppApiError,
  getMppConfig,
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
