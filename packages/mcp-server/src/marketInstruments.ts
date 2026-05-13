import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  requestBirdeyeNewListings,
  requestBirdeyeOhlcv,
  requestBirdeyePrice,
  requestBirdeyePriceMulti,
  requestBirdeyePriceVolumeMulti,
  requestBirdeyeTokenHolders,
  requestBirdeyeTokenListV3,
  requestBirdeyeTokenMetadata,
  requestBirdeyeTokenMetadataSingle,
  requestBirdeyeTokenSecurity,
  requestBirdeyeTrendingTokens,
  type BirdeyeOhlcvType,
  type BirdeyePriceVolumeType,
  type BirdeyeTokenListSortBy,
} from './birdeye.js';
import {
  checkHeliusMintAuthorities,
  getAuthorityTimeline,
  getHeliusTransactionHistory,
  getMintCreationTxForMint,
  getRecentEnrichedTxsForMint,
  hasHistoryBeforeTs,
  parseHeliusTransactions,
} from './helius.js';
import {
  getBirdeyeWebSocketSnapshot,
  type BirdeyeWsTopic,
} from './birdeyeWebSocket.js';
import { redactSecrets } from './trace.js';

export interface SolanaMarketDataInput {
  mint?: string;
  mints?: string[];
  includePrice?: boolean;
  includeLiquidity?: boolean;
  includePriceVolume?: boolean;
  includeMetadata?: boolean;
  includeOhlcv?: boolean;
  priceVolumeType?: BirdeyePriceVolumeType;
  ohlcvType?: BirdeyeOhlcvType;
  lookbackSeconds?: number;
}

export interface SolanaTokenListsInput {
  list: 'trending' | 'new_listings' | 'token_list_v3' | 'ws_snapshot';
  limit?: number;
  offset?: number;
  includeMeme?: boolean;
  sortBy?: BirdeyeTokenListSortBy;
  sortType?: 'asc' | 'desc';
  minLiquidity?: number;
  minVolume24hUsd?: number;
  timeTo?: number;
  startWebSocket?: boolean;
  wsTopics?: BirdeyeWsTopic[];
  minVolumeUsd?: number;
  maxVolumeUsd?: number;
}

export interface SolanaTokenSafetyEvidenceInput {
  mint: string;
  minLiquidityUsd?: number;
  maxStalenessSec?: number | null;
  includeHolders?: boolean;
  includeHelius?: boolean;
  includeTimeline?: boolean;
  holderLimit?: number;
  top1MaxPct?: number;
  top5MaxPct?: number;
  top10MaxPct?: number;
}

export interface SolanaHeliusHistoryInput {
  operation:
    | 'transaction_history'
    | 'parse_transactions'
    | 'recent_mint_txs'
    | 'mint_creation'
    | 'has_history_before'
    | 'authority';
  address?: string;
  mint?: string;
  signatures?: string[];
  before?: string;
  until?: string;
  commitment?: string;
  source?: string;
  type?: string;
  lookbackMinutes?: number;
  limit?: number;
  maxPages?: number;
  cutoffTs?: number;
}

export async function readSolanaMarketData(input: SolanaMarketDataInput): Promise<Record<string, unknown>> {
  const mints = normalizeMints(input);
  const asOf = new Date().toISOString();
  const warnings: string[] = [];
  const out: Record<string, unknown> = {
    source: 'birdeye',
    asOf,
    mints,
    warnings,
  };

  if (input.includePrice !== false) {
    const price = mints.length === 1
      ? await safeProviderCall(() => requestBirdeyePrice(mints[0]!, { includeLiquidity: input.includeLiquidity ?? true }), warnings)
      : await safeProviderCall(() => requestBirdeyePriceMulti(mints, { includeLiquidity: input.includeLiquidity ?? true }), warnings);
    if (price !== undefined) out.price = price;
  }
  if (input.includePriceVolume) {
    const priceVolume = await safeProviderCall(
      () => requestBirdeyePriceVolumeMulti(mints, { type: input.priceVolumeType ?? '24h' }),
      warnings,
    );
    if (priceVolume !== undefined) out.priceVolume = priceVolume;
  }
  if (input.includeMetadata) {
    const metadata = mints.length === 1
      ? await safeProviderCall(() => requestBirdeyeTokenMetadataSingle(mints[0]!), warnings)
      : await safeProviderCall(() => requestBirdeyeTokenMetadata(mints), warnings);
    if (metadata !== undefined) out.metadata = metadata;
  }
  if (input.includeOhlcv) {
    if (mints.length !== 1) {
      warnings.push('OHLCV requires exactly one mint; skipped.');
    } else {
      const now = Math.floor(Date.now() / 1000);
      const ohlcv = await safeProviderCall(
        () => requestBirdeyeOhlcv(mints[0]!, {
          type: input.ohlcvType ?? '15m',
          timeFrom: now - Math.max(60, Math.trunc(input.lookbackSeconds ?? 3600)),
          timeTo: now,
        }),
        warnings,
      );
      if (ohlcv !== undefined) out.ohlcv = ohlcv;
    }
  }
  out.available = warnings.length === 0;
  return redactSecrets(out) as Record<string, unknown>;
}

export async function readSolanaTokenLists(input: SolanaTokenListsInput): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
  const asOf = new Date().toISOString();
  const warnings: string[] = [];
  let data: unknown;
  if (input.list === 'trending') {
    data = await safeProviderCall(async () => {
      const pages = Math.ceil(limit / 20);
      const rows: Record<string, unknown>[] = [];
      for (let page = 0; page < pages; page++) {
        const payload = await requestBirdeyeTrendingTokens({
          limit: Math.min(20, limit - rows.length),
          offset: Math.max(0, Math.trunc(input.offset ?? 0)) + page * 20,
        });
        rows.push(...extractRows(payload));
        if (rows.length >= limit) break;
      }
      return { tokens: dedupeByAddress(rows).slice(0, limit) };
    }, warnings);
  } else if (input.list === 'new_listings') {
    data = await safeProviderCall(
      () => requestBirdeyeNewListings({
        limit,
        includeMeme: input.includeMeme ?? true,
        timeTo: input.timeTo,
      }),
      warnings,
    );
  } else if (input.list === 'token_list_v3') {
    data = await safeProviderCall(
      () => requestBirdeyeTokenListV3({
        limit,
        offset: input.offset,
        sortBy: input.sortBy,
        sortType: input.sortType,
        minLiquidity: input.minLiquidity,
        minVolume24hUsd: input.minVolume24hUsd,
        includeMeme: input.includeMeme,
      }),
      warnings,
    );
  } else {
    data = getBirdeyeWebSocketSnapshot({
      start: input.startWebSocket ?? true,
      topics: input.wsTopics,
      limit,
      minVolumeUsd: input.minVolumeUsd,
      maxVolumeUsd: input.maxVolumeUsd,
    });
  }
  return redactSecrets({
    source: input.list === 'ws_snapshot' ? 'birdeye_ws' : 'birdeye',
    asOf,
    list: input.list,
    available: warnings.length === 0,
    warnings,
    data,
  }) as Record<string, unknown>;
}

export async function readSolanaTokenSafetyEvidence(
  input: SolanaTokenSafetyEvidenceInput,
): Promise<Record<string, unknown>> {
  const mint = requireMint(input.mint);
  const asOf = new Date().toISOString();
  const minLiquidityUsd = input.minLiquidityUsd ?? 0;
  const maxStalenessSec = input.maxStalenessSec === null ? Infinity : input.maxStalenessSec ?? 600;
  const top1MaxPct = input.top1MaxPct ?? 30;
  const top5MaxPct = input.top5MaxPct ?? 50;
  const top10MaxPct = input.top10MaxPct ?? 75;
  const warnings: string[] = [];
  const checks: Record<string, unknown>[] = [];
  const raw: Record<string, unknown> = {};

  const price = await safeProviderCall(() => requestBirdeyePrice(mint, { includeLiquidity: true }), warnings);
  if (price !== undefined) {
    raw.price = price;
    checks.push(liquidityCheckFromPrice(price, minLiquidityUsd, maxStalenessSec));
  }

  const metadata = await safeProviderCall(() => requestBirdeyeTokenMetadataSingle(mint), warnings);
  if (metadata !== undefined) {
    raw.metadata = metadata;
    checks.push(verifiedCheckFromMetadata(metadata));
  }

  const security = await safeProviderCall(() => requestBirdeyeTokenSecurity(mint), warnings);
  if (security !== undefined) {
    raw.security = security;
    checks.push({
      key: 'birdeyeTokenSecurity',
      label: 'Birdeye token security',
      source: 'birdeye',
      status: 'INFO',
      passed: true,
      data: unwrapData(security),
    });
  }

  if (input.includeHolders !== false) {
    const holders = await safeProviderCall(
      () => requestBirdeyeTokenHolders(mint, { limit: input.holderLimit ?? 100 }),
      warnings,
    );
    if (holders !== undefined) {
      raw.holders = holders;
      checks.push(holderConcentrationCheck(holders, { top1MaxPct, top5MaxPct, top10MaxPct }));
    }
  }

  if (input.includeHelius !== false) {
    const authority = await safeProviderCall(() => checkHeliusMintAuthorities(mint), warnings);
    if (authority !== undefined) {
      raw.heliusAuthority = authority;
      checks.push({
        key: authority.key,
        label: authority.label,
        source: authority.source,
        status: authority.passed ? 'PASS' : 'FAIL',
        passed: authority.passed,
        reason: authority.reason,
        detail: authority.detail,
        data: authority.data,
      });
    }
    if (input.includeTimeline !== false) {
      const timeline = await safeProviderCall(() => getAuthorityTimeline(mint, { mode: 'fast' }), warnings);
      if (timeline !== undefined) {
        raw.authorityTimeline = timeline;
        checks.push({
          key: 'authorityTimeline',
          label: 'Authority timeline',
          source: 'helius',
          status: timeline.createdAt ? 'INFO' : 'WARN',
          passed: true,
          data: timeline,
        });
      }
    }
  }

  return redactSecrets({
    source: 'composite',
    asOf,
    mint,
    available: warnings.length === 0 || checks.length > 0,
    warnings,
    checks,
    raw,
  }) as Record<string, unknown>;
}

export async function readSolanaHeliusHistory(input: SolanaHeliusHistoryInput): Promise<Record<string, unknown>> {
  const asOf = new Date().toISOString();
  const warnings: string[] = [];
  let data: unknown;
  if (input.operation === 'transaction_history') {
    data = await safeProviderCall(
      () => getHeliusTransactionHistory(requireAddress(input.address ?? input.mint, 'address'), historyOptions(input)),
      warnings,
    );
  } else if (input.operation === 'parse_transactions') {
    const signatures = input.signatures?.map((sig) => sig.trim()).filter(Boolean) ?? [];
    if (!signatures.length) throw new ProtocolError('invalid_request', 'signatures is required for parse_transactions.');
    data = await safeProviderCall(() => parseHeliusTransactions(signatures), warnings);
  } else if (input.operation === 'recent_mint_txs') {
    data = await safeProviderCall(
      () => getRecentEnrichedTxsForMint(
        requireAddress(input.mint ?? input.address, 'mint'),
        input.lookbackMinutes ?? 15,
        input.limit ?? 100,
        { ...historyOptions(input), maxPages: input.maxPages },
      ),
      warnings,
    );
  } else if (input.operation === 'mint_creation') {
    data = await safeProviderCall(
      () => getMintCreationTxForMint(requireAddress(input.mint ?? input.address, 'mint'), historyOptions(input)),
      warnings,
    );
  } else if (input.operation === 'has_history_before') {
    if (input.cutoffTs === undefined) throw new ProtocolError('invalid_request', 'cutoffTs is required for has_history_before.');
    data = await safeProviderCall(
      () => hasHistoryBeforeTs(requireAddress(input.address ?? input.mint, 'address'), input.cutoffTs!, {
        ...historyOptions(input),
        maxPages: input.maxPages,
      }),
      warnings,
    );
  } else {
    data = await safeProviderCall(() => checkHeliusMintAuthorities(requireAddress(input.mint ?? input.address, 'mint')), warnings);
  }
  return redactSecrets({
    source: 'helius',
    asOf,
    operation: input.operation,
    available: warnings.length === 0 && data !== undefined,
    warnings,
    data,
  }) as Record<string, unknown>;
}

async function safeProviderCall<T>(run: () => Promise<T>, warnings: string[]): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    warnings.push(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function liquidityCheckFromPrice(payload: Record<string, unknown>, minLiquidityUsd: number, maxStalenessSec: number): Record<string, unknown> {
  const data = unwrapData(payload);
  const liquidity = numberField(data.liquidity);
  const updateUnixTime = numberField(data.updateUnixTime);
  const nowSec = Math.floor(Date.now() / 1000);
  const stalenessSec = updateUnixTime ? Math.max(0, nowSec - updateUnixTime) : Number.POSITIVE_INFINITY;
  const fresh = stalenessSec <= maxStalenessSec;
  const liquid = (liquidity ?? 0) >= minLiquidityUsd;
  return {
    key: 'birdeyeLiquidity',
    label: 'Birdeye liquidity',
    source: 'birdeye',
    status: fresh && liquid ? 'PASS' : 'FAIL',
    passed: fresh && liquid,
    reason: fresh
      ? (liquid ? 'liquidity_ok' : 'liquidity_below_threshold')
      : 'stale_price_data',
    data: {
      liquidity,
      minLiquidityUsd,
      updateUnixTime,
      stalenessSec,
      maxStalenessSec: Number.isFinite(maxStalenessSec) ? maxStalenessSec : null,
      price: numberField(data.value),
    },
  };
}

function verifiedCheckFromMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const data = unwrapData(payload);
  const extensions = asRecord(data.extensions) ?? {};
  const verified = Boolean(
    extensions.coingecko_id
      || extensions.website
      || extensions.twitter
      || extensions.discord
      || extensions.github,
  );
  return {
    key: 'birdeyeVerifiedMetadata',
    label: 'Birdeye verified metadata',
    source: 'birdeye',
    status: verified ? 'PASS' : 'WARN',
    passed: verified,
    reason: verified ? 'metadata_extensions_present' : 'no_official_metadata_extensions',
    data: {
      name: data.name ?? null,
      symbol: data.symbol ?? null,
      logoURI: data.logo_uri ?? data.logoURI ?? null,
      extensions,
    },
  };
}

function holderConcentrationCheck(
  payload: Record<string, unknown>,
  thresholds: { top1MaxPct: number; top5MaxPct: number; top10MaxPct: number },
): Record<string, unknown> {
  const holders = extractRows(payload);
  const percentages = holders.map(holderPercent).filter((value): value is number => value !== undefined);
  const top1Pct = percentages[0];
  const top5Pct = sum(percentages.slice(0, 5));
  const top10Pct = sum(percentages.slice(0, 10));
  const canEvaluate = top1Pct !== undefined;
  const failed = canEvaluate && (
    top1Pct > thresholds.top1MaxPct
      || top5Pct > thresholds.top5MaxPct
      || top10Pct > thresholds.top10MaxPct
  );
  return {
    key: 'topHolders',
    label: 'Holder concentration',
    source: 'birdeye',
    status: canEvaluate ? (failed ? 'FAIL' : 'PASS') : 'WARN',
    passed: canEvaluate ? !failed : false,
    reason: canEvaluate ? (failed ? 'holder_concentration_high' : 'holder_concentration_ok') : 'holder_percentages_unavailable',
    data: {
      holderCount: holders.length,
      top1Pct,
      top5Pct,
      top10Pct,
      thresholds,
      topHolders: holders.slice(0, 10).map((holder) => holder.wallet ?? holder.address ?? holder.owner).filter(Boolean),
    },
  };
}

function historyOptions(input: SolanaHeliusHistoryInput) {
  return {
    ...(input.before !== undefined ? { before: input.before } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(input.commitment !== undefined ? { commitment: input.commitment } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
  };
}

function normalizeMints(input: SolanaMarketDataInput): string[] {
  const values = [...(input.mints ?? []), ...(input.mint ? [input.mint] : [])];
  const list = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!list.length) throw new ProtocolError('invalid_request', 'mint or mints is required.');
  if (list.length > 100) throw new ProtocolError('invalid_request', 'At most 100 mints are supported.');
  return list;
}

function requireMint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ProtocolError('invalid_request', 'mint is required.');
  return trimmed;
}

function requireAddress(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new ProtocolError('invalid_request', `${field} is required.`);
  return trimmed;
}

function unwrapData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return payload;
}

function extractRows(payload: Record<string, unknown>): Record<string, unknown>[] {
  const data = unwrapData(payload);
  const candidates = [data.tokens, data.items, data.list, payload.tokens, payload.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object' && !Array.isArray(item)),
      );
    }
  }
  return [];
}

function dedupeByAddress(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const address = stringField(row.address ?? row.mint ?? row.tokenAddress);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(row);
  }
  return out;
}

function holderPercent(holder: Record<string, unknown>): number | undefined {
  const raw = numberField(
    holder.percentage
      ?? holder.percent
      ?? holder.uiAmountPercent
      ?? holder.amountPercent
      ?? holder.pct,
  );
  if (raw === undefined) return undefined;
  return raw <= 1 ? raw * 100 : raw;
}

function sum(values: number[]): number {
  return Number(values.reduce((total, value) => total + value, 0).toFixed(2));
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
