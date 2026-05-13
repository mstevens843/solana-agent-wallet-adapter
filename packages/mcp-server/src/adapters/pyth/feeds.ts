import type { DAppAdapterContext } from '../types.js';
import { AdapterError } from '../types.js';

import { getPythClient, type PythHermesFeedMetadata } from './client.js';
import {
  PYTH_ADAPTER_ID,
  PYTH_ALIAS_ENTRIES,
  PYTH_DEFAULT_HERMES_URL,
  type PythAssetType,
  normalizePriceFeedId,
  resolveAlias,
  withFeedIdPrefix,
} from './constants.js';

export interface PythFeedMetadata {
  priceFeedId: string;
  priceFeedIdHex: string;
  symbol?: string;
  displayName?: string;
  description?: string;
  assetType?: PythAssetType;
  base?: string;
  quoteCurrency?: string;
  source: 'alias' | 'hermes';
}

export interface PythFeedSearchInput {
  query: string;
  assetType?: PythAssetType;
  limit?: number;
}

export interface PythFeedSearchResult {
  query: string;
  assetType: PythAssetType;
  results: PythFeedMetadata[];
  hermesUrlHost: string;
  asOfIso: string;
}

export async function searchFeeds(
  input: PythFeedSearchInput,
  _ctx: DAppAdapterContext,
): Promise<PythFeedSearchResult> {
  void _ctx;
  const query = input.query?.trim() ?? '';
  if (!query) {
    throw new AdapterError(PYTH_ADAPTER_ID, 'invalid_query', 'Pyth feed search requires a non-empty query.');
  }
  const assetType: PythAssetType = input.assetType ?? 'crypto';
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const client = getPythClient();
  const aliasMatches = matchAliases(query, assetType, limit);
  const hermes = await safeHermesSearch(query, assetType);
  const merged = mergeResults(aliasMatches, hermes, limit);
  return {
    query,
    assetType,
    results: merged,
    hermesUrlHost: clientHost(client.hermesUrl),
    asOfIso: new Date().toISOString(),
  };
}

export async function resolveFeedId(
  input: { priceFeedId?: string; symbol?: string },
  ctx: DAppAdapterContext,
): Promise<PythFeedMetadata> {
  if (input.priceFeedId?.trim()) {
    const normalized = normalizePriceFeedId(input.priceFeedId);
    if (!normalized) {
      throw new AdapterError(PYTH_ADAPTER_ID, 'invalid_feed_id', 'priceFeedId is not a valid hex string.');
    }
    const alias = PYTH_ALIAS_ENTRIES.find((entry) => entry.feedId === normalized);
    if (alias) return aliasToMetadata(alias);
    const remote = await safeFeedById(normalized);
    if (remote) {
      return mergeMetadata({
        priceFeedId: normalized,
        priceFeedIdHex: withFeedIdPrefix(normalized),
        source: 'hermes',
      }, remote);
    }
    return {
      priceFeedId: normalized,
      priceFeedIdHex: withFeedIdPrefix(normalized),
      source: 'hermes',
    };
  }
  if (input.symbol?.trim()) {
    const alias = resolveAlias(input.symbol);
    if (alias) return aliasToMetadata(alias);
    const search = await searchFeeds({ query: input.symbol, assetType: 'crypto', limit: 1 }, ctx);
    const first = search.results[0];
    if (!first) {
      throw new AdapterError(PYTH_ADAPTER_ID, 'unknown_symbol', `No Pyth feed matched symbol "${input.symbol}".`);
    }
    return first;
  }
  throw new AdapterError(
    PYTH_ADAPTER_ID,
    'invalid_request',
    'Provide priceFeedId or symbol to resolve a Pyth feed.',
  );
}

function matchAliases(query: string, assetType: PythAssetType, limit: number): PythFeedMetadata[] {
  const needle = query.trim().toUpperCase().replace(/[\s_-]+/g, '');
  if (!needle) return [];
  const matches: PythFeedMetadata[] = [];
  for (const entry of PYTH_ALIAS_ENTRIES) {
    if (assetType !== 'all' && assetType !== 'crypto') continue;
    const haystack = `${entry.symbol}${entry.displayName}`.toUpperCase().replace(/[\s_-]+/g, '');
    if (haystack.includes(needle)) {
      matches.push(aliasToMetadata(entry));
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

async function safeHermesSearch(
  query: string,
  assetType: PythAssetType,
): Promise<PythHermesFeedMetadata[]> {
  try {
    const client = getPythClient();
    return await client.getPriceFeeds({
      query,
      ...(assetType !== 'all' ? { assetType } : {}),
    });
  } catch {
    return [];
  }
}

async function safeFeedById(priceFeedId: string): Promise<PythHermesFeedMetadata | null> {
  try {
    return await getPythClient().getPriceFeedById(priceFeedId);
  } catch {
    return null;
  }
}

function mergeResults(
  aliasMatches: PythFeedMetadata[],
  hermes: PythHermesFeedMetadata[],
  limit: number,
): PythFeedMetadata[] {
  const seen = new Set<string>();
  const out: PythFeedMetadata[] = [];
  for (const entry of aliasMatches) {
    if (seen.has(entry.priceFeedId)) continue;
    seen.add(entry.priceFeedId);
    out.push(entry);
    if (out.length >= limit) return out;
  }
  for (const entry of hermes) {
    if (seen.has(entry.priceFeedId)) continue;
    seen.add(entry.priceFeedId);
    const metadata: PythFeedMetadata = {
      priceFeedId: entry.priceFeedId,
      priceFeedIdHex: withFeedIdPrefix(entry.priceFeedId),
      source: 'hermes',
    };
    if (entry.symbol) metadata.symbol = entry.symbol;
    if (entry.description) metadata.description = entry.description;
    if (entry.assetType) metadata.assetType = entry.assetType;
    if (entry.base) metadata.base = entry.base;
    if (entry.quoteCurrency) metadata.quoteCurrency = entry.quoteCurrency;
    out.push(metadata);
    if (out.length >= limit) break;
  }
  return out;
}

function aliasToMetadata(entry: (typeof PYTH_ALIAS_ENTRIES)[number]): PythFeedMetadata {
  return {
    priceFeedId: entry.feedId,
    priceFeedIdHex: withFeedIdPrefix(entry.feedId),
    symbol: entry.symbol,
    displayName: entry.displayName,
    assetType: 'crypto',
    source: 'alias',
  };
}

function mergeMetadata(
  base: PythFeedMetadata,
  remote: PythHermesFeedMetadata,
): PythFeedMetadata {
  const merged: PythFeedMetadata = { ...base };
  if (remote.symbol) merged.symbol = remote.symbol;
  if (remote.description) merged.description = remote.description;
  if (remote.assetType) merged.assetType = remote.assetType;
  if (remote.base) merged.base = remote.base;
  if (remote.quoteCurrency) merged.quoteCurrency = remote.quoteCurrency;
  return merged;
}

export function clientHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || new URL(PYTH_DEFAULT_HERMES_URL).host;
  }
}
