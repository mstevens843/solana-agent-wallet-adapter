import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readSolanaHeliusHistory,
  readSolanaTokenLists,
  readSolanaTokenSafetyEvidence,
} from '../marketInstruments.js';
import {
  birdeyeWebSocketManager,
  getBirdeyeWebSocketSnapshot,
  resetBirdeyeWebSocketFactory,
  setBirdeyeWebSocketFactory,
  type BirdeyeWebSocketFactory,
} from '../birdeyeWebSocket.js';

describe('market instruments', () => {
  afterEach(() => {
    birdeyeWebSocketManager.stop();
    resetBirdeyeWebSocketFactory();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('reads Birdeye trending tokens across pages', async () => {
    const calls: string[] = [];
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      calls.push(url.toString());
      expect(new Headers(init?.headers).get('x-api-key')).toBe('birdeye-test-key');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      return jsonResponse({
        data: {
          tokens: Array.from({ length: limit }, (_, index) => ({
            address: `Token${String(offset + index).padStart(3, '0')}${'A'.repeat(36)}`,
            rank: offset + index + 1,
          })),
        },
      });
    }) as typeof fetch);

    const result = await readSolanaTokenLists({ list: 'trending', limit: 30 });
    const tokens = (((result.data as Record<string, unknown>).tokens ?? []) as unknown[]);

    expect(tokens).toHaveLength(30);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/defi/token_trending');
    expect(calls[0]).toContain('limit=20');
    expect(calls[1]).toContain('offset=20');
  });

  it('combines Birdeye and Helius token safety evidence', async () => {
    vi.stubEnv('BIRDEYE_API_KEY', 'birdeye-test-key');
    vi.stubEnv('HELIUS_API_KEY', 'helius-test-key');
    vi.stubEnv('HELIUS_RPC_URL', 'https://helius.example');
    const nowSec = Math.floor(Date.now() / 1000);
    const mintAccount = mintAccountBase64();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.hostname === 'helius.example') {
        expect(new Headers(init?.headers).get('x-api-key')).toBe('helius-test-key');
        return jsonResponse({
          result: {
            value: {
              data: [mintAccount, 'base64'],
            },
          },
        });
      }
      if (url.pathname === '/defi/price') {
        return jsonResponse({ data: { value: 0.25, liquidity: 5000, updateUnixTime: nowSec } });
      }
      if (url.pathname === '/defi/v3/token/meta-data/single') {
        return jsonResponse({ data: { name: 'Test Token', symbol: 'TEST', extensions: { website: 'https://example.test' } } });
      }
      if (url.pathname === '/defi/token_security') {
        return jsonResponse({ data: { ownerPct: 1.5 } });
      }
      if (url.pathname === '/defi/v3/token/holder') {
        return jsonResponse({
          data: {
            items: [
              { wallet: 'holder1', percentage: 0.1 },
              { wallet: 'holder2', percentage: 0.08 },
            ],
          },
        });
      }
      return jsonResponse({});
    }) as typeof fetch);

    const result = await readSolanaTokenSafetyEvidence({
      mint: 'So11111111111111111111111111111111111111112',
      minLiquidityUsd: 1000,
      includeTimeline: false,
    });
    const checks = result.checks as Array<Record<string, unknown>>;

    expect(result.available).toBe(true);
    expect(checks.find((check) => check.key === 'birdeyeLiquidity')?.status).toBe('PASS');
    expect(checks.find((check) => check.key === 'birdeyeVerifiedMetadata')?.status).toBe('PASS');
    expect(checks.find((check) => check.key === 'authority')?.status).toBe('PASS');
  });

  it('reads Helius parsed transfer history by address with JSON-RPC options', async () => {
    const owner = '11111111111111111111111111111111';
    const counterparty = 'So11111111111111111111111111111111111111112';
    let rpcBody: Record<string, unknown> | undefined;
    vi.stubEnv('HELIUS_API_KEY', 'helius-test-key');
    vi.stubEnv('HELIUS_RPC_URL', 'https://helius.example');
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      rpcBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(new Headers(init?.headers).get('x-api-key')).toBe('helius-test-key');
      return jsonResponse({
        result: {
          data: [{
            signature: 'sig1',
            blockTime: 1774635210,
            type: 'transfer',
            fromUserAccount: owner,
            toUserAccount: counterparty,
            mint: counterparty,
            uiAmount: '1',
          }],
          paginationToken: 'next-page',
        },
      });
    }) as typeof fetch);

    const result = await readSolanaHeliusHistory({
      operation: 'transfers_by_address',
      address: owner,
      with: counterparty,
      direction: 'out',
      mint: counterparty,
      solMode: 'merged',
      filters: { blockTime: { gte: 1774000000 } },
      limit: 250,
      sortOrder: 'desc',
    });

    expect(result.available).toBe(true);
    expect(rpcBody).toMatchObject({
      jsonrpc: '2.0',
      method: 'getTransfersByAddress',
      params: [
        owner,
        {
          with: counterparty,
          direction: 'out',
          mint: counterparty,
          solMode: 'merged',
          filters: { blockTime: { gte: 1774000000 } },
          limit: 100,
          sortOrder: 'desc',
        },
      ],
    });
    expect(result.data).toMatchObject({
      data: [expect.objectContaining({ signature: 'sig1' })],
      paginationToken: 'next-page',
    });
  });

  it('reports Helius transfer history as unavailable without a Helius RPC config', async () => {
    vi.stubGlobal('fetch', vi.fn() as unknown as typeof fetch);

    const result = await readSolanaHeliusHistory({
      operation: 'transfers_by_address',
      address: '11111111111111111111111111111111',
    });

    expect(result.available).toBe(false);
    expect(String((result.warnings as string[])[0])).toContain('Missing Helius RPC endpoint');
  });

  it('keeps an on-demand Birdeye websocket snapshot buffer', () => {
    vi.stubEnv('BIRDEYE_WS_URL', 'wss://public-api.birdeye.so/socket/solana?x-api-key=secret-key');
    let socket: FakeSocket | undefined;
    const factory: BirdeyeWebSocketFactory = (url, protocol) => {
      socket = new FakeSocket(url, protocol);
      return socket;
    };
    setBirdeyeWebSocketFactory(factory);

    const initial = getBirdeyeWebSocketSnapshot({
      start: true,
      topics: ['new_listings', 'large_trades'],
    });
    expect(initial.status).toBe('connecting');
    expect(initial.wsUrl).toContain('%5Bredacted%5D');

    socket?.emit('open');
    expect(socket?.sent.map((raw) => JSON.parse(raw) as { type: string }).map((msg) => msg.type)).toEqual([
      'SUBSCRIBE_TOKEN_NEW_LISTING',
      'SUBSCRIBE_LARGE_TRADE_TXS',
    ]);

    socket?.emit('message', JSON.stringify({
      type: 'TOKEN_NEW_LISTING_DATA',
      data: { address: 'Token1111111111111111111111111111111111111', symbol: 'NEW', liquidity: 1234 },
    }));
    const snapshot = getBirdeyeWebSocketSnapshot({ limit: 5 });

    expect(snapshot.status).toBe('open');
    expect(snapshot.buffers.newListings).toHaveLength(1);
    expect(snapshot.buffers.newListings[0]?.symbol).toBe('NEW');
  });
});

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  #listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly url: string, readonly protocol?: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'open') this.readyState = 1;
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mintAccountBase64(): string {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(0, 0);
  buf.writeBigUInt64LE(1_000_000n, 36);
  buf.writeUInt8(6, 44);
  buf.writeUInt8(1, 45);
  buf.writeUInt32LE(0, 46);
  return buf.toString('base64');
}
