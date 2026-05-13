import { describe, expect, it, vi } from 'vitest';

import {
  fetchBlinkMetadata,
  normalizeBlinkUrl,
  prepareBlinkAction,
} from '../blinkActions.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MCP Blink helpers', () => {
  it('normalizes Blink URL schemes to HTTPS action URLs', () => {
    expect(normalizeBlinkUrl('blink:https%3A%2F%2Fexample.com%2Faction')).toBe('https://example.com/action');
    expect(normalizeBlinkUrl('solana-action:https://example.com/action')).toBe('https://example.com/action');
  });

  it('rejects non-HTTPS action URLs', () => {
    expect(() => normalizeBlinkUrl('http://example.com/action')).toThrow(/must use https/);
  });

  it('fetches Blink metadata and linked action parameters', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      title: 'Claim Meteora fees',
      description: 'Claim fees from a DLMM position',
      label: 'Claim',
      links: {
        actions: [
          {
            href: 'https://example.com/claim',
            label: 'Claim fees',
            parameters: [{ name: 'position', label: 'Position', required: true }],
          },
        ],
      },
    }));

    const metadata = await fetchBlinkMetadata({
      url: 'blink:https://example.com/action',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(metadata.title).toBe('Claim Meteora fees');
    expect(metadata.actions[0]?.parameters?.[0]?.name).toBe('position');
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/action', expect.objectContaining({ method: 'GET' }));
  });

  it('prepares one Blink transaction without signing it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        account: '11111111111111111111111111111111',
        position: 'Position111',
      });
      return jsonResponse({
        transaction: 'base64-transaction',
        message: 'Review before signing',
      });
    });

    const prepared = await prepareBlinkAction({
      url: 'https://example.com/action',
      account: '11111111111111111111111111111111',
      parameters: { position: 'Position111' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(prepared.transactionBase64).toBe('base64-transaction');
    expect(prepared.message).toBe('Review before signing');
  });

  it('rejects multi-transaction Blink responses in V1', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      transactions: ['tx-1', 'tx-2'],
      mode: 'sequential',
    }));

    await expect(prepareBlinkAction({
      url: 'https://example.com/action',
      account: '11111111111111111111111111111111',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/multiple transactions/);
  });

  it('surfaces connector error responses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Unsupported position' } }, 400));

    await expect(prepareBlinkAction({
      url: 'https://example.com/action',
      account: '11111111111111111111111111111111',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/Unsupported position/);
  });
});
