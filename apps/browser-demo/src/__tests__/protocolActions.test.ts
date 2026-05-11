import { describe, expect, it, vi } from 'vitest';

import {
  fetchBlinkMetadata,
  fetchDialectPositions,
  fetchMeteoraPosition,
  normalizeBlinkUrl,
  prepareBlinkAction,
} from '../protocolActions.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('protocolActions Blink helpers', () => {
  it('normalizes blink and solana-action URLs to https action URLs', () => {
    expect(normalizeBlinkUrl('blink:https%3A%2F%2Fexample.com%2Faction')).toBe('https://example.com/action');
    expect(normalizeBlinkUrl('solana-action:https://example.com/action')).toBe('https://example.com/action');
    expect(() => normalizeBlinkUrl('http://example.com/action')).toThrow(/https/);
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

  it('prepares a single Blink transaction without signing it', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        account: 'Wallet111111111111111111111111111111111',
        protocol: 'Meteora',
      });
      return jsonResponse({
        transaction: 'base64-transaction',
        message: 'Review before signing',
      });
    });

    const prepared = await prepareBlinkAction({
      url: 'https://example.com/action',
      account: 'Wallet111111111111111111111111111111111',
      parameters: { protocol: 'Meteora' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(prepared.transactionBase64).toBe('base64-transaction');
    expect(prepared.message).toBe('Review before signing');
  });

  it('normalizes multi-transaction Blink responses for callers to decide support', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      transactions: ['tx-1', 'tx-2'],
      mode: 'sequential',
    }));

    const prepared = await prepareBlinkAction({
      url: 'https://example.com/action',
      account: 'Wallet111111111111111111111111111111111',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(prepared.transactions).toEqual(['tx-1', 'tx-2']);
    expect(prepared.mode).toBe('sequential');
  });

  it('surfaces connector error responses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Unsupported position' } }, 400));

    await expect(prepareBlinkAction({
      url: 'https://example.com/action',
      account: 'Wallet111111111111111111111111111111111',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/Unsupported position/);
  });
});

describe('protocolActions read helpers', () => {
  it('reads Dialect positions with client-key and wallet query', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/positions/owners');
      expect(url).toContain('walletAddresses=Wallet');
      expect((init?.headers as Record<string, string>)['x-dialect-client-key']).toBe('dialect-key');
      return jsonResponse({ positions: [] });
    });

    await expect(fetchDialectPositions({
      walletAddress: 'Wallet',
      clientKey: 'dialect-key',
      providers: ['meteora'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual({ positions: [] });
  });

  it('requires a Dialect client key before position reads', async () => {
    await expect(fetchDialectPositions({ walletAddress: 'Wallet' })).rejects.toThrow(/client key/);
  });

  it('reads a Meteora position by address', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/position/Position111');
      return jsonResponse({ address: 'Position111' });
    });

    await expect(fetchMeteoraPosition({
      positionAddress: 'Position111',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toEqual({ address: 'Position111' });
  });
});
