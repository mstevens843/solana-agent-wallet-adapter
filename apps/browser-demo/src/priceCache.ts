/**
 * Browser-side USD price cache for the agent review pipeline.
 *
 * Rules (per /goal directive):
 *   - One source per token. No corroboration in the hot path.
 *   - 30s TTL. Within the window, every caller for the same mint shares the snapshot.
 *   - Stablecoins resolve to $1.00 with ZERO API calls.
 *   - SOL goes to Pyth Hermes once per 30s.
 *   - Other tokens piggyback on existing router-fetched evidence. If a fact set already
 *     carries a USD value for the mint, we use it; otherwise the price is undefined and
 *     the fact simply displays without a USD annotation.
 *
 * USD is additive: the existing token-native amount remains the canonical display; USD
 * is appended as "(≈$X.XX)" when known.
 */

import {
  SOL_MINT_KEY,
  type PriceUsdSnapshot,
  stablecoinSnapshot,
} from '@solana-agent-wallet-adapter/workflow';

const PRICE_TTL_MS = 30_000;
const PYTH_HERMES_SOL_ENDPOINT = 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const cache = new Map<string, { snapshot: PriceUsdSnapshot; fetchedAt: number }>();

let inflightSolFetch: Promise<PriceUsdSnapshot | undefined> | null = null;

function getCached(mint: string): PriceUsdSnapshot | undefined {
  const entry = cache.get(mint);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > PRICE_TTL_MS) {
    cache.delete(mint);
    return undefined;
  }
  return entry.snapshot;
}

function setCached(snapshot: PriceUsdSnapshot): void {
  cache.set(snapshot.mint, { snapshot, fetchedAt: Date.now() });
}

/**
 * Resolve a USD price snapshot for a given mint.
 *
 *   - Stablecoin → returns immediately, $1.00, no fetch.
 *   - SOL → cached Pyth Hermes fetch (one HTTP call per 30s window).
 *   - Other → returns undefined here; callers can supplement from evidence facts.
 *
 * Always returns a snapshot object (or undefined). Never throws — pricing is best-effort.
 */
export async function getUsdPriceForMint(mint: string): Promise<PriceUsdSnapshot | undefined> {
  if (!mint) return undefined;
  const cached = getCached(mint);
  if (cached) return cached;

  const stable = stablecoinSnapshot(mint);
  if (stable) {
    setCached(stable);
    return stable;
  }

  if (mint === SOL_MINT_KEY) {
    if (!inflightSolFetch) inflightSolFetch = fetchSolUsdFromPyth();
    try {
      const snap = await inflightSolFetch;
      return snap;
    } finally {
      inflightSolFetch = null;
    }
  }

  return undefined;
}

/**
 * Synchronous lookup — returns the cached snapshot without triggering a fetch. Useful for
 * downstream code that wants to surface USD only when the price is already known.
 */
export function getCachedUsdPrice(mint: string): PriceUsdSnapshot | undefined {
  if (!mint) return undefined;
  const stable = stablecoinSnapshot(mint);
  if (stable) return stable;
  return getCached(mint);
}

/**
 * Lets callers seed the cache from existing evidence (e.g., a birdeye.price_multi fact
 * already fetched by the router). Avoids a second network call.
 */
export function seedUsdPrice(snapshot: PriceUsdSnapshot): void {
  setCached(snapshot);
}

/** For tests: clear the cache and any in-flight fetch. */
export function __resetPriceCacheForTests(): void {
  cache.clear();
  inflightSolFetch = null;
}

async function fetchSolUsdFromPyth(): Promise<PriceUsdSnapshot | undefined> {
  try {
    const response = await fetch(PYTH_HERMES_SOL_ENDPOINT, { method: 'GET' });
    if (!response.ok) return undefined;
    const payload = await response.json() as unknown;
    const parsed = parsePythHermesPayload(payload);
    if (!parsed) return undefined;
    const snapshot: PriceUsdSnapshot = {
      mint: SOL_MINT_KEY,
      usdPerToken: parsed.price,
      source: 'pyth',
      checkedAt: new Date().toISOString(),
      ...(typeof parsed.conf === 'number' ? { confidence: parsed.conf } : {}),
    };
    setCached(snapshot);
    return snapshot;
  } catch {
    return undefined;
  }
}

function parsePythHermesPayload(payload: unknown): { price: number; conf?: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const parsedField = record.parsed;
  if (!Array.isArray(parsedField) || parsedField.length === 0) return undefined;
  const first = parsedField[0];
  if (!first || typeof first !== 'object') return undefined;
  const priceContainer = (first as Record<string, unknown>).price;
  if (!priceContainer || typeof priceContainer !== 'object') return undefined;
  const priceRecord = priceContainer as Record<string, unknown>;
  const rawPrice = priceRecord.price;
  const rawExpo = priceRecord.expo;
  const rawConf = priceRecord.conf;
  if (typeof rawPrice !== 'string' || typeof rawExpo !== 'number') return undefined;
  const price = Number(rawPrice) * Math.pow(10, rawExpo);
  if (!Number.isFinite(price)) return undefined;
  const conf = typeof rawConf === 'string' ? Number(rawConf) * Math.pow(10, rawExpo) : undefined;
  return { price, ...(typeof conf === 'number' && Number.isFinite(conf) ? { conf } : {}) };
}
