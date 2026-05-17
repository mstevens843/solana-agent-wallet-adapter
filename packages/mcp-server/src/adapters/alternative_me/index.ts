/**
 * alternative.me Fear & Greed Index client.
 *
 * Promoted from apps/browser-demo/src/main.ts so the same fact source is
 * available to any caller through the MCP server (Codex CLI, Claude Desktop,
 * agent SDK, etc.).
 *
 * Endpoint: https://api.alternative.me/fng/?limit=1
 * No API key required. The site recommends a polling cadence of ~5 minutes;
 * we cache for 15 minutes in-process.
 *
 * The client is fetch-based and accepts an injected fetchImpl for tests.
 */

import { createFsKvCache } from './kvCaches.js';

const FEAR_GREED_ENDPOINT_DEFAULT = 'https://api.alternative.me/fng/?limit=1';
const FEAR_GREED_TTL_MS_DEFAULT = 15 * 60 * 1000;
const FEAR_GREED_KV_KEY = 'alternative_me:fng:limit-1';

export interface FearGreedIndexEntry {
  /** Numeric index value in [0, 100]. */
  value: number;
  /** Human classification (Extreme Fear, Fear, Neutral, Greed, Extreme Greed). */
  classification: string;
  /** ISO timestamp of the last on-source update. */
  updatedAt: string;
}

/**
 * Injectable KV cache abstraction for cross-process caching. Default
 * `AlternativeMeClient` uses an in-memory cache (per-process), but deployments
 * with multiple workers / serverless cold starts can plug in Redis, the local
 * bridge KV, or Cloudflare KV by providing this shape.
 *
 * Get returns the stored JSON value or undefined; set stores with a TTL hint
 * the backing store can honor or ignore.
 */
export interface KvCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
}

export interface AlternativeMeClientOptions {
  endpoint?: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the wall-clock for cache TTL math (used by tests). */
  now?: () => number;
  /** Optional cross-process cache. When provided, hits/misses are persisted under
   *  `alternative_me:fng:limit-1`. Falls back to in-memory cache on read errors. */
  kv?: KvCache;
}

interface CacheEntry {
  entry: FearGreedIndexEntry;
  fetchedAtMs: number;
}

export class AlternativeMeClient {
  private readonly endpoint: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly kv?: KvCache;
  private cache: CacheEntry | undefined;

  constructor(options: AlternativeMeClientOptions = {}) {
    this.endpoint = options.endpoint ?? FEAR_GREED_ENDPOINT_DEFAULT;
    this.ttlMs = options.ttlMs ?? FEAR_GREED_TTL_MS_DEFAULT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.kv = options.kv;
  }

  /** Returns the cached entry when still fresh, otherwise fetches from upstream. */
  async getFearGreedIndex(): Promise<FearGreedIndexEntry | undefined> {
    const now = this.now();
    if (this.cache && now - this.cache.fetchedAtMs < this.ttlMs) {
      return this.cache.entry;
    }
    // Cross-process cache check before going to network.
    if (this.kv) {
      try {
        const stored = await this.kv.get<CacheEntry>(FEAR_GREED_KV_KEY);
        if (stored && typeof stored.fetchedAtMs === 'number' && now - stored.fetchedAtMs < this.ttlMs) {
          this.cache = stored;
          return stored.entry;
        }
      } catch {
        // KV failure must not block a real fetch; fall through.
      }
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: 'GET' });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return undefined;
    }
    const entry = parseFearGreedResponse(payload);
    if (!entry) return undefined;
    const cacheEntry: CacheEntry = { entry, fetchedAtMs: now };
    this.cache = cacheEntry;
    if (this.kv) {
      // Best-effort write; never block returning the live result.
      void this.kv.set(FEAR_GREED_KV_KEY, cacheEntry, this.ttlMs).catch(() => undefined);
    }
    return entry;
  }

  /** Clear the in-memory cache. Useful for tests; not normally needed in production. */
  clearCache(): void {
    this.cache = undefined;
  }
}

/**
 * Parse the alternative.me payload into a normalized entry. Tolerates the API's
 * occasional habit of returning numeric fields as strings.
 */
export function parseFearGreedResponse(payload: unknown): FearGreedIndexEntry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  const data = Array.isArray(body.data) ? body.data : undefined;
  if (!data || data.length === 0) return undefined;
  const row = data[0];
  if (!row || typeof row !== 'object') return undefined;
  const rec = row as Record<string, unknown>;
  const rawValue = typeof rec.value === 'string' ? Number(rec.value) : typeof rec.value === 'number' ? rec.value : NaN;
  if (!Number.isFinite(rawValue)) return undefined;
  const classification = typeof rec.value_classification === 'string' && rec.value_classification.length > 0
    ? rec.value_classification
    : 'Unknown';
  const tsSeconds = typeof rec.timestamp === 'string' ? Number(rec.timestamp) : typeof rec.timestamp === 'number' ? rec.timestamp : NaN;
  const updatedAt = Number.isFinite(tsSeconds)
    ? new Date(tsSeconds * 1000).toISOString()
    : new Date().toISOString();
  return { value: rawValue, classification, updatedAt };
}

/* -------------------------------------------------------------------------- */
/* Singleton accessor                                                         */
/* -------------------------------------------------------------------------- */

let defaultClient: AlternativeMeClient | undefined;

/**
 * Return the process-wide AlternativeMeClient, building it on first access.
 *
 * Env knobs (read once at first access):
 *   - AGENT_WALLET_KV_CACHE_PATH=...  → wrap with createFsKvCache(path) for cross-process
 *     caching. Multi-worker deployments use this so each worker doesn't re-fetch Fear &
 *     Greed independently. Falls back silently to in-memory cache if the path is unset or
 *     the FS adapter can't initialize.
 */
export function getAlternativeMeClient(): AlternativeMeClient {
  if (!defaultClient) defaultClient = new AlternativeMeClient({ kv: defaultKvCacheFromEnv() });
  return defaultClient;
}

/** Reset the singleton — useful in tests. */
export function resetAlternativeMeClient(): void {
  defaultClient = undefined;
}

function defaultKvCacheFromEnv(): KvCache | undefined {
  const path = (process.env.AGENT_WALLET_KV_CACHE_PATH ?? '').trim();
  if (!path) return undefined;
  try {
    return createFsKvCache(path);
  } catch {
    return undefined;
  }
}
