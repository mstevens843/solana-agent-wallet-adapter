import type { Connection } from '@solana/web3.js';

import { getKaminoClient, type KaminoReserveSnapshot } from './client.js';
import { resolveKnownReserve } from './constants.js';

const SNAPSHOT_TTL_MS = 30_000;

interface CacheEntry {
  snapshot: KaminoReserveSnapshot;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function getReserveSnapshot(
  connection: Connection,
  reserveToken: string,
): Promise<KaminoReserveSnapshot> {
  const known = resolveKnownReserve(reserveToken);
  const mint = known?.mint ?? reserveToken.trim();
  if (!mint) {
    throw new Error('Reserve mint is required.');
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < SNAPSHOT_TTL_MS) {
    return cached.snapshot;
  }

  const snapshot = await getKaminoClient().getReserveSnapshot(connection, mint);
  cache.set(mint, { snapshot, fetchedAt: Date.now() });
  return snapshot;
}

export function invalidateReserveSnapshot(mintOrSymbol: string): void {
  const known = resolveKnownReserve(mintOrSymbol);
  cache.delete(known?.mint ?? mintOrSymbol);
}

export function clearReserveSnapshotCache(): void {
  cache.clear();
}

export async function listReserveSnapshots(connection: Connection): Promise<KaminoReserveSnapshot[]> {
  return getKaminoClient().listReserveSnapshots(connection);
}
