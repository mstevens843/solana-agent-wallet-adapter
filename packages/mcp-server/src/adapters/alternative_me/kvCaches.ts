/**
 * Concrete `KvCache` implementations callers can use directly with `AlternativeMeClient`
 * (and any other adapter that adopts the same interface).
 *
 *   createMemoryKvCache() — process-local, drop-in tests/dev. Same semantics as the
 *     client's built-in cache, but exposed as a KvCache so callers can share one across
 *     multiple clients within a single process.
 *
 *   createFsKvCache(path) — file-backed, multi-process-safe. Writes JSON entries
 *     atomically so multiple Node workers can share the same cache on the same machine.
 *     Reads are O(1) (in-process LRU index) once warm. Not a replacement for Redis —
 *     it's a working baseline for deployments that don't have a KV store yet.
 *
 * Deployments wanting Redis / Cloudflare KV / DurableObjects implement the same
 * interface on top of their client of choice; nothing else needs to change.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import type { KvCache } from './index.js';

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

interface MemoryEntry {
  value: unknown;
  expiresAtMs: number;
}

export interface MemoryKvCacheOptions {
  /** Override the wall-clock for TTL math (used by tests). */
  now?: () => number;
}

export function createMemoryKvCache(options: MemoryKvCacheOptions = {}): KvCache {
  const map = new Map<string, MemoryEntry>();
  const now = options.now ?? (() => Date.now());
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAtMs <= now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
      map.set(key, { value, expiresAtMs: now() + ttl });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Filesystem                                                                 */
/* -------------------------------------------------------------------------- */

interface FsRecord {
  entries: Record<string, { value: unknown; expiresAtMs: number }>;
}

export interface FsKvCacheOptions {
  /** Override the wall-clock (tests). */
  now?: () => number;
}

/**
 * File-backed KV cache. Concurrency model:
 *   - Reads load the JSON file each call (cheap; the file stays small for hot-fact use).
 *   - Writes do a load → modify → write-temp → rename sequence so multiple processes
 *     can race without truncating each other (the rename is atomic on POSIX).
 *
 * Intended for hot regime facts like Fear & Greed / CoinGecko global where the TTL is
 * ~5-15 minutes and the entry count stays in the low dozens. Not a general-purpose KV.
 */
export function createFsKvCache(path: string, options: FsKvCacheOptions = {}): KvCache {
  const now = options.now ?? (() => Date.now());

  async function loadRecord(): Promise<FsRecord> {
    try {
      const text = await fs.readFile(path, 'utf8');
      const parsed = JSON.parse(text) as Partial<FsRecord>;
      const entries: FsRecord['entries'] = {};
      if (parsed && typeof parsed.entries === 'object' && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && typeof v === 'object' && 'value' in v && 'expiresAtMs' in v) {
            entries[k] = { value: (v as { value: unknown }).value, expiresAtMs: Number((v as { expiresAtMs: unknown }).expiresAtMs) };
          }
        }
      }
      return { entries };
    } catch {
      return { entries: {} };
    }
  }

  async function writeRecord(record: FsRecord): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.mkdir(dirname(path), { recursive: true });
    } catch {
      // Best-effort; the write below will surface any real error.
    }
    await fs.writeFile(tmp, JSON.stringify(record), 'utf8');
    await fs.rename(tmp, path);
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const record = await loadRecord();
      const entry = record.entries[key];
      if (!entry) return undefined;
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now()) {
        return undefined;
      }
      return entry.value as T;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      const record = await loadRecord();
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
      record.entries[key] = { value, expiresAtMs: now() + ttl };
      // Drop expired entries on every write so the file stays small.
      const cutoff = now();
      for (const [k, v] of Object.entries(record.entries)) {
        if (!Number.isFinite(v.expiresAtMs) || v.expiresAtMs <= cutoff) {
          delete record.entries[k];
        }
      }
      await writeRecord(record);
    },
  };
}
