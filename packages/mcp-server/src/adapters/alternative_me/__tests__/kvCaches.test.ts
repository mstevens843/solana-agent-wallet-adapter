import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFsKvCache, createMemoryKvCache } from '../kvCaches.js';

describe('createMemoryKvCache', () => {
  it('stores and reads back values within TTL', async () => {
    let nowMs = 1_000_000;
    const cache = createMemoryKvCache({ now: () => nowMs });
    await cache.set('a', { foo: 1 }, 60_000);
    expect(await cache.get('a')).toEqual({ foo: 1 });
  });

  it('returns undefined for expired entries and evicts them', async () => {
    let nowMs = 1_000_000;
    const cache = createMemoryKvCache({ now: () => nowMs });
    await cache.set('a', 'x', 1_000);
    nowMs += 5_000;
    expect(await cache.get('a')).toBeUndefined();
    // After eviction, a subsequent set should still work.
    await cache.set('a', 'y', 10_000);
    expect(await cache.get('a')).toBe('y');
  });

  it('returns undefined for missing keys', async () => {
    const cache = createMemoryKvCache();
    expect(await cache.get('missing')).toBeUndefined();
  });
});

describe('createFsKvCache', () => {
  let tmpPath: string;

  beforeEach(async () => {
    tmpPath = join(tmpdir(), `kv-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(async () => {
    try { await fs.unlink(tmpPath); } catch { /* file may not exist */ }
  });

  it('persists values across two cache instances pointed at the same file', async () => {
    const writer = createFsKvCache(tmpPath);
    await writer.set('fng', { value: 42, classification: 'Fear' }, 60_000);

    const reader = createFsKvCache(tmpPath);
    const value = await reader.get<{ value: number; classification: string }>('fng');
    expect(value).toEqual({ value: 42, classification: 'Fear' });
  });

  it('honors per-key TTL and drops expired entries on subsequent writes', async () => {
    let nowMs = 1_000_000;
    const cache = createFsKvCache(tmpPath, { now: () => nowMs });
    await cache.set('hot', 1, 5_000);
    await cache.set('keep', 2, 60_000);
    nowMs += 10_000;
    // hot is now expired; reads return undefined and a subsequent set prunes it.
    expect(await cache.get('hot')).toBeUndefined();
    await cache.set('newer', 3, 60_000);
    const text = await fs.readFile(tmpPath, 'utf8');
    const record = JSON.parse(text) as { entries: Record<string, unknown> };
    expect(record.entries.hot).toBeUndefined();
    expect(record.entries.keep).toBeDefined();
    expect(record.entries.newer).toBeDefined();
  });

  it('returns undefined for an unreadable or missing file (no throw)', async () => {
    const cache = createFsKvCache('/nonexistent/dir/that/never/should/exist/cache.json');
    expect(await cache.get('any')).toBeUndefined();
  });
});
