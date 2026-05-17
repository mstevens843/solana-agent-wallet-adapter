import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AlternativeMeClient,
  getAlternativeMeClient,
  parseFearGreedResponse,
  resetAlternativeMeClient,
} from '../index.js';

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('parseFearGreedResponse', () => {
  it('parses a well-formed alternative.me payload (strings)', () => {
    const entry = parseFearGreedResponse({
      data: [{ value: '42', value_classification: 'Fear', timestamp: '1700000000' }],
    });
    expect(entry).toMatchObject({ value: 42, classification: 'Fear' });
    expect(new Date(entry!.updatedAt).getUTCFullYear()).toBeGreaterThanOrEqual(2023);
  });

  it('parses numeric fields', () => {
    const entry = parseFearGreedResponse({
      data: [{ value: 25, value_classification: 'Extreme Fear', timestamp: 1700000000 }],
    });
    expect(entry).toMatchObject({ value: 25, classification: 'Extreme Fear' });
  });

  it('returns undefined for empty / malformed payloads', () => {
    expect(parseFearGreedResponse(null)).toBeUndefined();
    expect(parseFearGreedResponse({})).toBeUndefined();
    expect(parseFearGreedResponse({ data: [] })).toBeUndefined();
    expect(parseFearGreedResponse({ data: [{ value: 'abc' }] })).toBeUndefined();
  });

  it('falls back to "Unknown" classification when missing and uses now() for timestamp', () => {
    const entry = parseFearGreedResponse({ data: [{ value: '50' }] });
    expect(entry?.classification).toBe('Unknown');
    expect(typeof entry?.updatedAt).toBe('string');
  });
});

describe('AlternativeMeClient', () => {
  it('returns the parsed entry on a successful HTTP call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [{ value: '42', value_classification: 'Fear', timestamp: '1700000000' }],
    }));
    const client = new AlternativeMeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const entry = await client.getFearGreedIndex();
    expect(entry).toMatchObject({ value: 42, classification: 'Fear' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caches within the TTL and bypasses re-fetch', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ data: [{ value: 50, value_classification: 'Neutral', timestamp: 1700000000 }] });
    });
    let nowMs = 1_000_000;
    const client = new AlternativeMeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 10_000,
      now: () => nowMs,
    });
    await client.getFearGreedIndex();
    await client.getFearGreedIndex();
    expect(calls).toBe(1);
    // Advance past TTL
    nowMs += 11_000;
    await client.getFearGreedIndex();
    expect(calls).toBe(2);
  });

  it('returns undefined when the upstream HTTP errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream blew up', { status: 502 }));
    const client = new AlternativeMeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getFearGreedIndex()).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network unreachable'); });
    const client = new AlternativeMeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getFearGreedIndex()).toBeUndefined();
  });

  it('returns undefined when the JSON body is malformed', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new AlternativeMeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.getFearGreedIndex()).toBeUndefined();
  });

  it('uses the injected KvCache before going to the network', async () => {
    const cachedEntry = { entry: { value: 77, classification: 'Greed', updatedAt: '2025-01-01T00:00:00Z' }, fetchedAtMs: 1_000_000 };
    const kv: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async () => cachedEntry),
      set: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = new AlternativeMeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      kv,
      ttlMs: 60_000,
      now: () => 1_005_000, // 5s after cachedEntry.fetchedAtMs → still fresh
    });
    const entry = await client.getFearGreedIndex();
    expect(entry?.value).toBe(77);
    expect(kv.get).toHaveBeenCalledWith('alternative_me:fng:limit-1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('writes to KvCache after a fresh network fetch', async () => {
    const kv: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ value: '15', value_classification: 'Extreme Fear', timestamp: '1700000000' }] }));
    const client = new AlternativeMeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      kv,
      ttlMs: 60_000,
    });
    await client.getFearGreedIndex();
    // KV set is fire-and-forget; await a microtask for the .catch chain to schedule.
    await new Promise((resolve) => setImmediate(resolve));
    expect(kv.set).toHaveBeenCalledWith('alternative_me:fng:limit-1', expect.objectContaining({ entry: expect.objectContaining({ value: 15 }) }), 60_000);
  });

  it('falls back to network when KvCache read throws', async () => {
    const kv: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } = {
      get: vi.fn(async () => { throw new Error('redis down'); }),
      set: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ value: '30', value_classification: 'Fear', timestamp: '1700000000' }] }));
    const client = new AlternativeMeClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      kv,
      ttlMs: 60_000,
    });
    const entry = await client.getFearGreedIndex();
    expect(entry?.value).toBe(30);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('clearCache forces a re-fetch on the next call', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ data: [{ value: 60, value_classification: 'Greed', timestamp: 1700000000 }] });
    });
    const client = new AlternativeMeClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.getFearGreedIndex();
    client.clearCache();
    await client.getFearGreedIndex();
    expect(calls).toBe(2);
  });

  afterEach(() => {
    resetAlternativeMeClient();
  });
});

describe('getAlternativeMeClient — env-based KV cache auto-wire', () => {
  let tmpPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `kv-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    originalPath = process.env.AGENT_WALLET_KV_CACHE_PATH;
    resetAlternativeMeClient();
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.AGENT_WALLET_KV_CACHE_PATH;
    else process.env.AGENT_WALLET_KV_CACHE_PATH = originalPath;
    resetAlternativeMeClient();
    try { await fs.unlink(tmpPath); } catch { /* file may not exist */ }
  });

  it('uses no KV when AGENT_WALLET_KV_CACHE_PATH is unset', () => {
    delete process.env.AGENT_WALLET_KV_CACHE_PATH;
    const client = getAlternativeMeClient();
    expect(client).toBeInstanceOf(AlternativeMeClient);
    // No exception, just an in-memory-only client.
  });

  it('wires a KV cache when AGENT_WALLET_KV_CACHE_PATH is set', async () => {
    process.env.AGENT_WALLET_KV_CACHE_PATH = tmpPath;
    // Pre-populate the KV file so the client (when built) reads the cached entry instead
    // of fetching. This deterministically proves the env wiring connects the singleton
    // to the file path without depending on fire-and-forget write timing.
    const { createFsKvCache } = await import('../kvCaches.js');
    const seed = createFsKvCache(tmpPath);
    await seed.set('alternative_me:fng:limit-1', {
      entry: { value: 77, classification: 'Greed', updatedAt: '2025-01-01T00:00:00Z' },
      fetchedAtMs: Date.now(),
    }, 60_000);
    // Build the singleton — env auto-wire should mean it reads from the same file.
    resetAlternativeMeClient();
    const client = getAlternativeMeClient();
    // Stub fetch to throw — if the env wiring works, we should get the cached value first
    // and never hit the network.
    const stubFetch = vi.fn(async () => { throw new Error('should not be called'); });
    (client as unknown as { fetchImpl: typeof fetch }).fetchImpl = stubFetch as unknown as typeof fetch;
    const entry = await client.getFearGreedIndex();
    expect(entry).toMatchObject({ value: 77, classification: 'Greed' });
    expect(stubFetch).not.toHaveBeenCalled();
  });
});
