import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import { PublicKey } from '@solana/web3.js';

export const DEFAULT_HELIUS_RPC_BASE = 'https://mainnet.helius-rpc.com/';
export const DEFAULT_HELIUS_PARSE_BASE = 'https://api-mainnet.helius-rpc.com';
export const DEFAULT_HELIUS_HISTORY_TTL_MS = 60_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 5_000;

export interface HeliusConfig {
  apiKey?: string;
  rpcUrl: string;
  parseTransactionsUrl?: string;
  parseTransactionHistoryUrl?: string;
  senderRpcUrl?: string;
  historyTtlMs: number;
}

export interface HeliusRequestOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface HeliusTransactionHistoryOptions extends HeliusRequestOptions {
  before?: string;
  until?: string;
  commitment?: string;
  source?: string;
  type?: string;
  timeoutMs?: number;
}

export interface HeliusComparisonFilter {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}

export interface HeliusTransferFilters {
  amount?: HeliusComparisonFilter;
  blockTime?: HeliusComparisonFilter;
  slot?: HeliusComparisonFilter;
}

export interface HeliusTransfersByAddressOptions extends HeliusRequestOptions {
  with?: string;
  direction?: 'in' | 'out' | 'any';
  mint?: string;
  solMode?: 'merged' | 'separate';
  filters?: HeliusTransferFilters;
  limit?: number;
  paginationToken?: string;
  commitment?: 'finalized' | 'confirmed' | string;
  sortOrder?: 'asc' | 'desc';
}

export interface HeliusRecentTxsResult {
  ok: boolean;
  txs: Record<string, unknown>[];
  fetchedPages: number;
  oldestBlockTime: number | null;
  stopReason: string;
  nextBeforeSignature?: string;
  partial: boolean;
  budgetExceeded: boolean;
  timedOut: boolean;
  coverage_missing: boolean;
  budgetHit: boolean;
  error?: string;
}

export interface HeliusAuthorityCheck {
  key: 'authority';
  label: 'Mint / Freeze Authority';
  source: 'helius_rpc';
  passed: boolean;
  reason: 'renounced' | 'authority_exists' | 'rpc_error' | 'no_mint';
  detail: string;
  data: {
    source: 'helius_rpc';
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    decimals?: number;
    isInitialized?: boolean;
    supplyUi?: number;
    accountBytes?: number;
    error?: string;
  };
}

export interface HeliusAuthorityTimeline {
  createdAt: number | null;
  renouncedAt: number | null;
  txSampleSize: number;
  stopReason: string | null;
}

interface CacheEntry {
  ts: number;
  data: unknown;
}

const historyCache = new Map<string, CacheEntry>();
const historyInflight = new Map<string, Promise<unknown>>();
const mintAuthCache = new Map<string, CacheEntry | { promise: Promise<HeliusAuthorityCheck> }>();
const hasHistoryBeforeCache = new Map<string, unknown>();

export function heliusConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HeliusConfig {
  const apiKey = env.HELIUS_API_KEY?.trim() || undefined;
  const rpcUrl = (env.HELIUS_RPC_URL?.trim() || (apiKey
    ? `${DEFAULT_HELIUS_RPC_BASE}?api-key=${encodeURIComponent(apiKey)}`
    : 'https://api.mainnet-beta.solana.com')).replace(/\/+$/, (match) =>
    match && match.length > 1 ? '/' : match,
  );
  const parseTransactionsUrl = env.PARSE_TRANSACTIONS_API?.trim()
    || (apiKey ? `${DEFAULT_HELIUS_PARSE_BASE}/v0/transactions/?api-key=${encodeURIComponent(apiKey)}` : undefined);
  const parseTransactionHistoryUrl = env.PARSE_TRANSACTION_HISTORY_API?.trim()
    || (apiKey ? `${DEFAULT_HELIUS_PARSE_BASE}/v0/addresses/{address}/transactions/?api-key=${encodeURIComponent(apiKey)}` : undefined);
  const historyTtlMsRaw = Number(env.HELIUS_HISTORY_TTL_MS);
  return {
    ...(apiKey ? { apiKey } : {}),
    rpcUrl,
    ...(parseTransactionsUrl ? { parseTransactionsUrl } : {}),
    ...(parseTransactionHistoryUrl ? { parseTransactionHistoryUrl } : {}),
    ...(env.SENDER_RPC_URL?.trim() ? { senderRpcUrl: env.SENDER_RPC_URL.trim() } : {}),
    historyTtlMs: Number.isFinite(historyTtlMsRaw) && historyTtlMsRaw > 0
      ? historyTtlMsRaw
      : DEFAULT_HELIUS_HISTORY_TTL_MS,
  };
}

export async function estimateHeliusPriorityFee(
  options: HeliusRequestOptions & {
    rpcUrl?: string;
    serializedTransaction?: string;
    enabled?: boolean;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? ['1', 'true', 'yes'].includes((env.USE_PRIORITY_FEE_API ?? '').toLowerCase());
  if (!enabled) return DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  const config = heliusConfigFromEnv(env);
  const rpcUrl = options.rpcUrl ?? config.rpcUrl;
  try {
    const body = {
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'getPriorityFeeEstimate',
      params: [
        { transaction: options.serializedTransaction || null },
        { recommended: true },
      ],
    };
    const data = await requestHeliusRpc(rpcUrl, body, { env, fetchImpl: options.fetchImpl });
    const recommended = numberField(asRecord(asRecord(data.result)?.priorityFeeEstimate)?.recommended);
    return recommended === undefined ? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS : Math.floor(recommended);
  } catch {
    return DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  }
}

// Account touched by virtually every SPL token tx — a representative network sample when the caller
// has no specific tx/accounts (for a generic "what's the current priority fee / is it congested" read).
const PRIORITY_FEE_SAMPLE_ACCOUNT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Full priority-fee breakdown for the chat/planner READ atom — UNGATED (always queries Helius), unlike
// estimateHeliusPriorityFee which is the swap-path variant (env-gated, returns only `recommended`).
// Returns all levels so the agent can describe congestion. micro-lamports per compute unit.
export async function getHeliusPriorityFeeLevels(
  options: HeliusRequestOptions & { accountKeys?: string[]; serializedTransaction?: string } = {},
): Promise<Record<string, unknown>> {
  const config = heliusConfigFromEnv(options.env);
  const target = options.serializedTransaction
    ? { transaction: options.serializedTransaction }
    : { accountKeys: options.accountKeys && options.accountKeys.length ? options.accountKeys : [PRIORITY_FEE_SAMPLE_ACCOUNT] };
  const body = {
    jsonrpc: '2.0',
    id: 'getPriorityFeeLevels',
    method: 'getPriorityFeeEstimate',
    params: [{ ...target, options: { includeAllPriorityFeeLevels: true } }],
  };
  const data = await requestHeliusRpc(config.rpcUrl, body, { env: options.env, fetchImpl: options.fetchImpl });
  const root = asRecord(data.result) ?? {};
  const levels = asRecord(root.priorityFeeLevels) ?? {};
  const floorOrNull = (v: unknown): number | null => {
    const n = numberField(v);
    return n === undefined ? null : Math.floor(n);
  };
  // priorityFeeEstimate may be a number or { recommended }; fall back to a mid level.
  const estNum = numberField(root.priorityFeeEstimate);
  const estObj = asRecord(root.priorityFeeEstimate);
  const recommended = estNum ?? numberField(estObj?.recommended) ?? numberField(levels.medium) ?? numberField(levels.high);
  return {
    recommendedMicroLamports: recommended === undefined ? null : Math.floor(recommended),
    levels: {
      min: floorOrNull(levels.min),
      low: floorOrNull(levels.low),
      medium: floorOrNull(levels.medium),
      high: floorOrNull(levels.high),
      veryHigh: floorOrNull(levels.veryHigh),
      unsafeMax: floorOrNull(levels.unsafeMax),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* DAS API (assets / NFTs) — getAsset + getAssetsByOwner                       */
/* -------------------------------------------------------------------------- */

export interface HeliusCompactAsset {
  mint: string;
  name?: string;
  symbol?: string;
  collection?: string;
  image?: string;
  compressed?: boolean;
  interface?: string;
  royaltyPct?: number;
  frozen?: boolean;
  attributes?: Array<Record<string, unknown>>;
  creators?: Array<Record<string, unknown>>;
}

// Project a raw DAS asset into a compact, token-efficient shape. Shared by the server
// wrappers and the DAS proxy so every path returns identical data.
export function compactHeliusAsset(asset: Record<string, unknown>): HeliusCompactAsset {
  const content = asRecord(asset.content);
  const metadata = asRecord(content?.metadata);
  const links = asRecord(content?.links);
  const grouping = Array.isArray(asset.grouping) ? (asset.grouping as unknown[]).map(asRecord) : [];
  const collection = grouping.find((g) => g?.group_key === 'collection');
  const royalty = asRecord(asset.royalty);
  const compression = asRecord(asset.compression);
  const ownership = asRecord(asset.ownership);
  const bps = numberField(royalty?.basis_points);
  const pct = numberField(royalty?.percent);
  const royaltyPct = bps !== undefined ? bps / 100 : pct !== undefined ? Math.round(pct * 100 * 100) / 100 : undefined;
  const attributes = Array.isArray(metadata?.attributes)
    ? (metadata!.attributes as unknown[]).map(asRecord).filter((a): a is Record<string, unknown> => Boolean(a)).slice(0, 12)
    : undefined;
  const creators = Array.isArray(asset.creators)
    ? (asset.creators as unknown[]).map(asRecord).filter((c): c is Record<string, unknown> => Boolean(c)).slice(0, 5).map((c) => ({
      ...(typeof c.address === 'string' ? { address: c.address } : {}),
      ...(numberField(c.share) !== undefined ? { share: numberField(c.share) } : {}),
      ...(typeof c.verified === 'boolean' ? { verified: c.verified } : {}),
    }))
    : undefined;
  return {
    mint: typeof asset.id === 'string' ? asset.id : '',
    ...(typeof metadata?.name === 'string' ? { name: metadata.name } : {}),
    ...(typeof metadata?.symbol === 'string' ? { symbol: metadata.symbol } : {}),
    ...(typeof collection?.group_value === 'string' ? { collection: collection.group_value } : {}),
    ...(typeof links?.image === 'string' ? { image: links.image } : {}),
    ...(typeof compression?.compressed === 'boolean' ? { compressed: compression.compressed } : {}),
    ...(typeof asset.interface === 'string' ? { interface: asset.interface } : {}),
    ...(royaltyPct !== undefined ? { royaltyPct } : {}),
    ...(typeof ownership?.frozen === 'boolean' ? { frozen: ownership.frozen } : {}),
    ...(attributes && attributes.length ? { attributes } : {}),
    ...(creators && creators.length ? { creators } : {}),
  };
}

export async function getHeliusAsset(mint: string, options: HeliusRequestOptions = {}): Promise<HeliusCompactAsset | undefined> {
  if (!mint.trim()) return undefined;
  const config = heliusConfigFromEnv(options.env);
  const body = {
    jsonrpc: '2.0',
    id: 'getAsset',
    method: 'getAsset',
    params: { id: mint, options: { showFungible: true, showCollectionMetadata: true } },
  };
  const data = await requestHeliusRpc(config.rpcUrl, body, options);
  const result = asRecord(data.result);
  return result ? compactHeliusAsset(result) : undefined;
}

export async function getHeliusAssetsByOwner(
  owner: string,
  input: { tokenType?: 'fungible' | 'nonFungible' | 'regularNft' | 'compressedNft' | 'all'; limit?: number; page?: number } = {},
  options: HeliusRequestOptions = {},
): Promise<{ total?: number; count: number; items: HeliusCompactAsset[] }> {
  if (!owner.trim()) return { count: 0, items: [] };
  const config = heliusConfigFromEnv(options.env);
  const body = {
    jsonrpc: '2.0',
    id: 'getAssetsByOwner',
    method: 'getAssetsByOwner',
    params: {
      ownerAddress: owner,
      tokenType: input.tokenType ?? 'nonFungible',
      page: input.page ?? 1,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 1000),
      options: { showCollectionMetadata: true },
    },
  };
  const data = await requestHeliusRpc(config.rpcUrl, body, options);
  const result = asRecord(data.result);
  const items = Array.isArray(result?.items) ? (result!.items as unknown[]).map(asRecord).filter((a): a is Record<string, unknown> => Boolean(a)) : [];
  return {
    ...(numberField(result?.total) !== undefined ? { total: numberField(result?.total) } : {}),
    count: items.length,
    items: items.map(compactHeliusAsset),
  };
}

export async function sendViaHeliusSender(
  serializedTransaction: string | Buffer,
  options: HeliusRequestOptions = {},
): Promise<unknown> {
  const config = heliusConfigFromEnv(options.env);
  if (!config.senderRpcUrl) {
    throw new ProtocolError('unauthorized', 'Missing Helius Sender URL. Set SENDER_RPC_URL.');
  }
  const base64 = Buffer.isBuffer(serializedTransaction)
    ? serializedTransaction.toString('base64')
    : serializedTransaction;
  const payload = {
    jsonrpc: '2.0',
    id: Date.now().toString(),
    method: 'sendTransaction',
    params: [
      base64,
      {
        encoding: 'base64',
        skipPreflight: true,
        maxRetries: 0,
      },
    ],
  };
  const data = await requestHeliusRpc(config.senderRpcUrl, payload, options);
  return data.result;
}

/**
 * Resolve the operator's Helius backrun-rebate recipient from the environment.
 *
 * Helius "Backrun Rebates" pay 50% of the MEV a transaction creates, in SOL, in
 * the same block, to whatever address is passed as `?rebate-address=` on a
 * `sendTransaction` call to a Helius RPC. This returns the validated base58
 * recipient (the operator's collection wallet) or `null` when unset/invalid.
 * See `sendRawTransactionWithRebate`. Docs:
 * https://www.helius.dev/docs/sending-transactions/backrun-rebates
 */
export function resolveRebateAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HELIUS_REBATE_ADDRESS?.trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    return null;
  }
}

/**
 * True when an RPC URL points at a Helius RPC that honors `?rebate-address`.
 *
 * Only the standard Helius RPC hosts (`mainnet.helius-rpc.com`, regional
 * `*.helius-rpc.com`) credit rebates; the Sender host (`sender.helius-rpc.com`)
 * and any non-Helius provider do not, so they are excluded.
 */
export function isRebateEligibleRpcUrl(rpcUrl: string | undefined): boolean {
  if (!rpcUrl) return false;
  try {
    const host = new URL(rpcUrl).host.toLowerCase();
    return host.endsWith('helius-rpc.com') && !host.startsWith('sender.');
  } catch {
    return false;
  }
}

function appendRebateAddress(rpcUrl: string, rebateAddress: string): string {
  const url = new URL(rpcUrl);
  url.searchParams.set('rebate-address', rebateAddress);
  return url.toString();
}

/**
 * Broadcast a fully-signed (base64) transaction so it earns Helius backrun
 * rebates: POST `sendTransaction` to a Helius RPC URL carrying
 * `?rebate-address=<operator wallet>`.
 *
 * Falls back to `fallback()` (the caller's normal `connection.sendRawTransaction`)
 * when no rebate address is configured, no Helius RPC is available, or the rebate
 * POST fails — so transaction landing is never degraded by the rebate wrapper.
 * Re-sending the same signed transaction via `fallback()` is idempotent (same
 * signature → the cluster dedups), so a failed rebate POST is safe.
 *
 * Preference order for the send endpoint: the caller's own RPC URL when it is
 * already a rebate-eligible Helius URL (keeps the exact endpoint, just adds the
 * param), otherwise the Helius RPC resolved from `HELIUS_API_KEY`/`HELIUS_RPC_URL`.
 */
export async function sendRawTransactionWithRebate(
  base64Transaction: string,
  fallback: () => Promise<string>,
  options: HeliusRequestOptions & { rpcUrl?: string } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const rebateAddress = resolveRebateAddress(env);
  if (!rebateAddress) return fallback();
  const heliusUrl = heliusConfigFromEnv(env).rpcUrl;
  const base = isRebateEligibleRpcUrl(options.rpcUrl)
    ? options.rpcUrl!
    : (isRebateEligibleRpcUrl(heliusUrl) ? heliusUrl : null);
  if (!base) return fallback();
  const payload = {
    jsonrpc: '2.0',
    id: Date.now().toString(),
    method: 'sendTransaction',
    params: [
      base64Transaction,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 },
    ],
  };
  try {
    const data = await requestHeliusRpc(appendRebateAddress(base, rebateAddress), payload, {
      env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const sig = data.result;
    return typeof sig === 'string' && sig ? sig : fallback();
  } catch {
    // Rebate POST failed (network / preflight / error response). Re-broadcast via
    // the normal path so landing is unaffected; identical signature is idempotent.
    return fallback();
  }
}

export async function parseHeliusTransactions(
  signatures: string[] | string,
  options: HeliusRequestOptions = {},
): Promise<unknown[]> {
  const list = (Array.isArray(signatures) ? signatures : [signatures])
    .map((signature) => signature.trim())
    .filter(Boolean);
  if (!list.length) {
    throw new ProtocolError('invalid_request', 'At least one transaction signature is required.');
  }
  const config = heliusConfigFromEnv(options.env);
  if (!config.parseTransactionsUrl) {
    throw new ProtocolError('unauthorized', 'Missing Helius enhanced transaction endpoint. Set HELIUS_API_KEY or PARSE_TRANSACTIONS_API.');
  }
  const response = await (options.fetchImpl ?? fetch)(config.parseTransactionsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transactions: list }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw httpError('parseHeliusTransactions', response.status, payload);
  }
  return Array.isArray(payload) ? payload : [payload];
}

export async function getHeliusTransactionHistory(
  address: string,
  options: HeliusTransactionHistoryOptions = {},
): Promise<unknown> {
  const trimmed = requireTrimmed(address, 'address');
  const config = heliusConfigFromEnv(options.env);
  if (!config.parseTransactionHistoryUrl) {
    throw new ProtocolError('unauthorized', 'Missing Helius enhanced history endpoint. Set HELIUS_API_KEY or PARSE_TRANSACTION_HISTORY_API.');
  }
  const url = new URL(config.parseTransactionHistoryUrl.replace('{address}', encodeURIComponent(trimmed)));
  const allowed: Array<keyof HeliusTransactionHistoryOptions> = ['before', 'until', 'commitment', 'source', 'type'];
  for (const key of allowed) {
    const value = options[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  const cacheKey = url.toString();
  const now = Date.now();
  const cached = historyCache.get(cacheKey);
  if (cached && now - cached.ts < config.historyTtlMs) {
    return cached.data;
  }
  const inflight = historyInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = fetchHistoryUrl(url, options);
  historyInflight.set(cacheKey, promise);
  try {
    const data = await promise;
    historyCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } finally {
    historyInflight.delete(cacheKey);
  }
}

export async function getTransfersByAddress(
  address: string,
  options: HeliusTransfersByAddressOptions = {},
): Promise<unknown> {
  const owner = normalizedPublicKey(address, 'address');
  const env = options.env ?? process.env;
  const config = heliusConfigFromEnv(env);
  if (!config.apiKey && !env.HELIUS_RPC_URL?.trim()) {
    throw new ProtocolError(
      'unauthorized',
      'Missing Helius RPC endpoint for getTransfersByAddress. Set HELIUS_API_KEY or HELIUS_RPC_URL to a Helius-compatible RPC URL.',
    );
  }
  const rpcConfig = heliusTransfersConfig(options);
  const params = Object.keys(rpcConfig).length ? [owner, rpcConfig] : [owner];
  const body = {
    jsonrpc: '2.0',
    id: Date.now().toString(),
    method: 'getTransfersByAddress',
    params,
  };
  const cacheKey = `transfers:${config.rpcUrl}:${JSON.stringify(params)}`;
  const now = Date.now();
  const cached = historyCache.get(cacheKey);
  if (cached && now - cached.ts < config.historyTtlMs) {
    return cached.data;
  }
  const inflight = historyInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = requestHeliusRpc(config.rpcUrl, body, options).then((data) => data.result);
  historyInflight.set(cacheKey, promise);
  try {
    const data = await promise;
    historyCache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } finally {
    historyInflight.delete(cacheKey);
  }
}

export async function getRecentEnrichedTxsForMint(
  mint: string,
  lookbackMinutes = 15,
  limit = 100,
  options: HeliusTransactionHistoryOptions & {
    maxPages?: number;
    startBeforeSignature?: string;
    maxMs?: number;
    deadlineMs?: number;
    pageTimeoutCapMs?: number;
  } = {},
): Promise<HeliusRecentTxsResult> {
  const trimmed = mint.trim();
  if (!trimmed) {
    return failedRecentTxs('missing_mint');
  }
  const maxTxs = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const lookbackSec = (Number.isFinite(lookbackMinutes) ? lookbackMinutes : 15) * 60;
  const cutoff = Math.floor(Date.now() / 1000) - lookbackSec;
  const txs: Record<string, unknown>[] = [];
  let fetchedPages = 0;
  let oldestBlockTime: number | null = null;
  let before = options.startBeforeSignature;
  const maxPages = options.maxPages ?? (maxTxs ? Number.POSITIVE_INFINITY : 3);
  const startMs = Date.now();
  const relativeDeadline = options.maxMs && options.maxMs > 0 ? startMs + options.maxMs : undefined;
  const deadlineMs = [relativeDeadline, options.deadlineMs]
    .filter((value): value is number => Number.isFinite(value))
    .reduce<number | undefined>((min, value) => min === undefined ? value : Math.min(min, value), undefined);
  let partial = false;
  let budgetExceeded = false;
  let timedOut = false;
  let stopReason = 'exhausted';
  let nextBeforeSignature: string | undefined;

  while (true) {
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      partial = true;
      budgetExceeded = true;
      stopReason = 'budget_exceeded';
      break;
    }
    if (Number.isFinite(maxPages) && fetchedPages >= maxPages) {
      partial = true;
      stopReason = 'hit_max_pages';
      nextBeforeSignature = before;
      break;
    }
    let timeoutMs = options.timeoutMs;
    if (deadlineMs !== undefined) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        partial = true;
        budgetExceeded = true;
        stopReason = 'budget_exceeded';
        break;
      }
      const cap = options.pageTimeoutCapMs && options.pageTimeoutCapMs > 0 ? options.pageTimeoutCapMs : 800;
      timeoutMs = Math.max(150, Math.min(remainingMs - 50, cap));
    }
    let raw: unknown;
    try {
      raw = await getHeliusTransactionHistory(trimmed, {
        ...copyHistoryOptions(options),
        ...(before ? { before } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('timeout')) {
        partial = true;
        budgetExceeded = true;
        timedOut = true;
        stopReason = 'timeout';
        break;
      }
      return failedRecentTxs(msg);
    }
    fetchedPages++;
    const list = extractTxList(raw);
    if (!list.length) {
      stopReason = 'exhausted';
      break;
    }
    let reachedCutoff = false;
    for (const tx of list) {
      const ts = txTimestamp(tx);
      if (ts !== undefined) {
        if (oldestBlockTime === null || ts < oldestBlockTime) oldestBlockTime = ts;
        if (ts < cutoff) {
          reachedCutoff = true;
          break;
        }
        txs.push(tx);
        if (maxTxs && txs.length >= maxTxs) {
          stopReason = 'hit_limit';
          break;
        }
      }
    }
    if (stopReason === 'hit_limit') break;
    if (reachedCutoff) {
      stopReason = 'hit_cutoff';
      break;
    }
    before = txSignature(list[list.length - 1]);
    if (!before) {
      stopReason = 'exhausted';
      break;
    }
  }
  const coverageMissing = partial || budgetExceeded || timedOut;
  return {
    ok: true,
    txs,
    fetchedPages,
    oldestBlockTime,
    stopReason,
    ...(nextBeforeSignature ? { nextBeforeSignature } : {}),
    partial,
    budgetExceeded,
    timedOut,
    coverage_missing: coverageMissing,
    budgetHit: budgetExceeded,
  };
}

export function analyzeLpPatternFromTxs(txs: unknown[]): {
  lpAdds: number;
  lpRemoves: number;
  firstLpAddTime: number | null;
  lastLpAction: 'add' | 'remove' | 'none';
  lastLpActionTime: number | null;
} {
  let lpAdds = 0;
  let lpRemoves = 0;
  let firstLpAddTime: number | null = null;
  let lastLpAction: 'add' | 'remove' | 'none' = 'none';
  let lastLpActionTime: number | null = null;
  for (const tx of txs) {
    const record = asRecord(tx);
    if (!record) continue;
    const type = String(record.type ?? record.description ?? '').toUpperCase();
    const ts = txTimestamp(record);
    if (ts === undefined) continue;
    const isAdd = type.includes('ADD_LIQUIDITY')
      || type.includes('ADD_TO_POOL')
      || type.includes('BOOTSTRAP_LIQUIDITY')
      || type.includes('CREATE_POOL');
    const isRemove = type.includes('REMOVE_LIQUIDITY')
      || type.includes('REMOVE_FROM_POOL')
      || type.includes('CLOSE_POOL');
    if (isAdd) {
      lpAdds++;
      if (firstLpAddTime === null || ts < firstLpAddTime) firstLpAddTime = ts;
      if (lastLpActionTime === null || ts > lastLpActionTime) {
        lastLpAction = 'add';
        lastLpActionTime = ts;
      }
    }
    if (isRemove) {
      lpRemoves++;
      if (lastLpActionTime === null || ts > lastLpActionTime) {
        lastLpAction = 'remove';
        lastLpActionTime = ts;
      }
    }
  }
  return { lpAdds, lpRemoves, firstLpAddTime, lastLpAction, lastLpActionTime };
}

export async function getMintCreationTxForMint(
  mint: string,
  options: HeliusTransactionHistoryOptions & { type?: string } = {},
): Promise<{ ok: boolean; tx?: Record<string, unknown>; reason?: string; txs?: Record<string, unknown>[]; warnings?: unknown[]; fallbackUsed?: boolean; status?: number }> {
  if (!mint.trim()) return { ok: false, reason: 'missing_mint' };
  try {
    const raw = await getHeliusTransactionHistory(mint, {
      ...copyHistoryOptions(options),
      type: options.type ?? process.env.DEVPROBE_MINT_CREATE_TX_TYPE ?? 'TOKEN_MINT',
    });
    const list = extractTxList(raw);
    if (!list.length) return { ok: false, reason: 'no_matching_tx' };
    return { ok: true, tx: earliestTx(list) };
  } catch (err) {
    if (err instanceof HeliusHttpError && err.status === 404) {
      try {
        const raw = await getHeliusTransactionHistory(mint, copyHistoryOptions(options));
        const list = extractTxList(raw);
        if (!list.length) return { ok: false, reason: 'no_matching_tx', status: 404 };
        return {
          ok: true,
          tx: earliestTx(list),
          warnings: [{ source: 'helius_tx_history', error: 'token_mint_404_fallback' }],
          fallbackUsed: true,
        };
      } catch {
        return { ok: false, reason: 'token_mint_history_unavailable', status: 404 };
      }
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkHeliusMintAuthorities(
  mint: string,
  options: HeliusRequestOptions & { ttlMs?: number } = {},
): Promise<HeliusAuthorityCheck> {
  const resultBase = {
    key: 'authority' as const,
    label: 'Mint / Freeze Authority' as const,
    source: 'helius_rpc' as const,
  };
  const trimmed = mint.trim();
  if (!trimmed) {
    return {
      ...resultBase,
      passed: false,
      reason: 'no_mint',
      detail: 'No mint provided',
      data: { source: 'helius_rpc' },
    };
  }
  const ttlMs = (options.ttlMs ?? Number(process.env.DEVPROBE_MINT_AUTH_TTL_MS)) || 300_000;
  const cached = mintAuthCache.get(trimmed);
  if (cached) {
    if ('data' in cached && Date.now() - cached.ts < ttlMs) return cached.data as HeliusAuthorityCheck;
    if ('promise' in cached) return cached.promise;
  }
  const promise = (async (): Promise<HeliusAuthorityCheck> => {
    try {
      const dataB64 = await getAccountInfoBase64(trimmed, options);
      const parsed = parseSplMintAccount(Buffer.from(dataB64, 'base64'));
      const passed = parsed.mintAuthority === null && parsed.freezeAuthority === null;
      return {
        ...resultBase,
        passed,
        reason: passed ? 'renounced' : 'authority_exists',
        detail: `mint=${short(parsed.mintAuthority)}, freeze=${short(parsed.freezeAuthority)}, dec=${parsed.decimals}, init=${parsed.isInitialized}`,
        data: {
          source: 'helius_rpc',
          mintAuthority: parsed.mintAuthority,
          freezeAuthority: parsed.freezeAuthority,
          decimals: parsed.decimals,
          isInitialized: parsed.isInitialized,
          supplyUi: parsed.supplyUi,
          accountBytes: parsed.accountBytes,
        },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ...resultBase,
        passed: false,
        reason: 'rpc_error',
        detail,
        data: { source: 'helius_rpc', error: detail },
      };
    }
  })();
  mintAuthCache.set(trimmed, { promise });
  const resolved = await promise;
  mintAuthCache.set(trimmed, { ts: Date.now(), data: resolved });
  return resolved;
}

export async function getAuthorityTimeline(
  mint: string,
  options: HeliusTransactionHistoryOptions & { maxPages?: number; timeoutMs?: number; mode?: 'fast' | 'deep'; skipTimeline?: boolean } = {},
): Promise<HeliusAuthorityTimeline> {
  if (options.skipTimeline) {
    return { createdAt: null, renouncedAt: null, txSampleSize: 0, stopReason: 'skipped' };
  }
  const maxPages = options.maxPages ?? (options.mode === 'fast' ? 2 : 5);
  if (!mint.trim()) {
    return { createdAt: null, renouncedAt: null, txSampleSize: 0, stopReason: 'no_mint' };
  }
  let createdAt: number | null = null;
  let renouncedAt: number | null = null;
  let earliestTs: number | null = null;
  let foundCreationMarker = false;
  let txSampleSize = 0;
  let before: string | undefined;
  let stopReason: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    let raw: unknown;
    try {
      raw = await getHeliusTransactionHistory(mint, {
        ...copyHistoryOptions(options),
        ...(before ? { before } : {}),
      });
    } catch {
      stopReason = 'error';
      break;
    }
    const txs = extractTxList(raw);
    if (!txs.length) {
      stopReason = 'exhausted';
      break;
    }
    txSampleSize += txs.length;
    for (const tx of txs) {
      const ts = txTimestamp(tx);
      if (ts !== undefined) {
        if (earliestTs === null || ts < earliestTs) earliestTs = ts;
        const typeNorm = String(tx.type ?? '').toUpperCase().replace(/[_\s]/g, '');
        const descNorm = String(tx.description ?? '').toUpperCase().replace(/[_\s]/g, '');
        const isCreation = typeNorm.includes('TOKENMINT')
          || typeNorm.includes('MINT')
          || descNorm.includes('TOKENMINT')
          || descNorm.includes('INITIALIZEMINT')
          || descNorm.includes('CREATE')
          || descNorm.includes('MINT');
        if (isCreation) {
          foundCreationMarker = true;
          if (createdAt === null || ts < createdAt) createdAt = ts;
        }
        const combined = `${String(tx.type ?? '')} ${String(tx.description ?? '')}`.toUpperCase().replace(/[_\s]/g, '');
        if (combined.includes('SETAUTHORITY') && (renouncedAt === null || ts < renouncedAt)) {
          renouncedAt = ts;
        }
      }
    }
    if (createdAt !== null && renouncedAt !== null) {
      stopReason = 'found';
      break;
    }
    if (createdAt !== null && foundCreationMarker) {
      stopReason = 'creation_tx_found';
      break;
    }
    before = txSignature(txs[txs.length - 1]);
    if (!before) {
      stopReason = 'exhausted';
      break;
    }
  }
  if (!foundCreationMarker && createdAt === null && earliestTs !== null) {
    createdAt = earliestTs;
    stopReason = 'fallback_earliest_seen';
  }
  return {
    createdAt,
    renouncedAt,
    txSampleSize,
    stopReason: stopReason ?? 'max_pages',
  };
}

export async function hasHistoryBeforeTs(
  address: string,
  cutoffTs: number,
  options: HeliusTransactionHistoryOptions & { maxPages?: number } = {},
): Promise<{ ok: boolean; hasOlder?: boolean; evidenceTs?: number; minSeenTs?: number | null; pagesScanned?: number; txsScanned?: number; confidence?: string; reason?: string }> {
  const trimmed = address.trim();
  if (!trimmed) return { ok: false, reason: 'invalid_address' };
  if (!Number.isFinite(cutoffTs)) return { ok: false, reason: 'invalid_cutoff' };
  const maxPages = options.maxPages ?? 3;
  const cacheKey = `${trimmed}:${cutoffTs}:${maxPages}:${options.source ?? ''}:${options.type ?? ''}`;
  const cached = hasHistoryBeforeCache.get(cacheKey);
  if (cached) return cached as Awaited<ReturnType<typeof hasHistoryBeforeTs>>;
  let before: string | undefined;
  let pagesScanned = 0;
  let txsScanned = 0;
  let minSeenTs: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    let raw: unknown;
    try {
      raw = await getHeliusTransactionHistory(trimmed, {
        ...copyHistoryOptions(options),
        ...(before ? { before } : {}),
      });
    } catch (err) {
      const result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      hasHistoryBeforeCache.set(cacheKey, result);
      return result;
    }
    pagesScanned++;
    const list = extractTxList(raw);
    for (const tx of list) {
      txsScanned++;
      const ts = txTimestamp(tx);
      if (ts === undefined) continue;
      if (minSeenTs === null || ts < minSeenTs) minSeenTs = ts;
      if (ts < cutoffTs) {
        const result = { ok: true, hasOlder: true, evidenceTs: ts, pagesScanned, txsScanned };
        hasHistoryBeforeCache.set(cacheKey, result);
        return result;
      }
    }
    before = txSignature(list[list.length - 1]);
    if (!before) break;
  }
  const result = {
    ok: true,
    hasOlder: false,
    minSeenTs,
    pagesScanned,
    txsScanned,
    confidence: pagesScanned > 1 ? 'medium' : 'low',
  };
  hasHistoryBeforeCache.set(cacheKey, result);
  return result;
}

async function getAccountInfoBase64(mint: string, options: HeliusRequestOptions): Promise<string> {
  const config = heliusConfigFromEnv(options.env);
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [mint, { encoding: 'base64' }],
  };
  const data = await requestHeliusRpc(config.rpcUrl, body, options);
  const value = asRecord(asRecord(data.result)?.value);
  const rawData = value?.data;
  const dataB64 = Array.isArray(rawData) && typeof rawData[0] === 'string' ? rawData[0] : undefined;
  if (!dataB64) throw new Error('No account data');
  return dataB64;
}

async function requestHeliusRpc(
  rpcUrl: string,
  body: Record<string, unknown>,
  options: HeliusRequestOptions,
): Promise<Record<string, unknown>> {
  const config = heliusConfigFromEnv(options.env);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey && !rpcUrl.includes('api-key=')) headers['x-api-key'] = config.apiKey;
  const response = await (options.fetchImpl ?? fetch)(rpcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  const record = asRecord(payload) ?? {};
  if (!response.ok) throw httpError('Helius RPC', response.status, record);
  if (record.error) throw new Error(JSON.stringify(record.error));
  return record;
}

async function fetchHistoryUrl(url: URL, options: HeliusTransactionHistoryOptions): Promise<unknown> {
  const controller = options.timeoutMs && options.timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    });
    const payload = await readJson(response);
    if (!response.ok) throw httpError('getHeliusTransactionHistory', response.status, payload);
    return payload;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('getHeliusTransactionHistory: timeout');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(async () => {
    const text = await response.text().catch(() => '');
    return text ? { error: text } : {};
  });
}

class HeliusHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function httpError(label: string, status: number, payload: unknown): HeliusHttpError {
  return new HeliusHttpError(`${label}: HTTP ${status} ${JSON.stringify(payload)}`, status);
}

function parseSplMintAccount(buf: Buffer): {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  isInitialized: boolean;
  supplyUi: number;
  accountBytes: number;
} {
  if (buf.length < 82) throw new Error(`Mint account data too short: ${buf.length} bytes`);
  const sentinel = '11111111111111111111111111111111';
  const mintAuthority = buf.readUInt32LE(0) === 0 ? null : new PublicKey(buf.subarray(4, 36)).toBase58();
  const supply = buf.readBigUInt64LE(36);
  const decimals = buf.readUInt8(44);
  const isInitialized = Boolean(buf.readUInt8(45));
  const freezeAuthority = buf.readUInt32LE(46) === 0 ? null : new PublicKey(buf.subarray(50, 82)).toBase58();
  return {
    mintAuthority: mintAuthority === sentinel ? null : mintAuthority,
    freezeAuthority: freezeAuthority === sentinel ? null : freezeAuthority,
    decimals,
    isInitialized,
    supplyUi: Number(supply) / 10 ** decimals,
    accountBytes: buf.length,
  };
}

function extractTxList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isRecord);
  const record = asRecord(raw);
  const candidates = [record?.transactions, record?.items, record?.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

function earliestTx(txs: Record<string, unknown>[]): Record<string, unknown> {
  return txs.slice().sort((a, b) => (txTimestamp(a) ?? 0) - (txTimestamp(b) ?? 0))[0] ?? {};
}

function txTimestamp(tx: Record<string, unknown> | undefined): number | undefined {
  if (!tx) return undefined;
  const value = numberField(tx.blockTime) ?? numberField(tx.timestamp);
  return value !== undefined && value > 0 ? value : undefined;
}

function txSignature(tx: Record<string, unknown> | undefined): string | undefined {
  if (!tx) return undefined;
  if (typeof tx.signature === 'string' && tx.signature.trim()) return tx.signature.trim();
  if (typeof tx.signatureString === 'string' && tx.signatureString.trim()) return tx.signatureString.trim();
  if (typeof tx.sig === 'string' && tx.sig.trim()) return tx.sig.trim();
  if (typeof tx.txHash === 'string' && tx.txHash.trim()) return tx.txHash.trim();
  if (Array.isArray(tx.signatures) && typeof tx.signatures[0] === 'string') return tx.signatures[0];
  return undefined;
}

function copyHistoryOptions(options: HeliusTransactionHistoryOptions): HeliusTransactionHistoryOptions {
  return {
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.commitment !== undefined ? { commitment: options.commitment } : {}),
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };
}

function heliusTransfersConfig(options: HeliusTransfersByAddressOptions): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.with !== undefined && options.with.trim()) config.with = normalizedPublicKey(options.with, 'with');
  if (options.direction !== undefined) config.direction = options.direction;
  if (options.mint !== undefined && options.mint.trim()) config.mint = normalizedPublicKey(options.mint, 'mint');
  if (options.solMode !== undefined) config.solMode = options.solMode;
  if (options.filters !== undefined) {
    const filters = sanitizeTransferFilters(options.filters);
    if (Object.keys(filters).length) config.filters = filters;
  }
  if (options.limit !== undefined) config.limit = Math.min(Math.max(Math.trunc(options.limit), 1), 100);
  if (options.paginationToken !== undefined && options.paginationToken.trim()) config.paginationToken = options.paginationToken.trim();
  if (options.commitment !== undefined && options.commitment.trim()) config.commitment = options.commitment.trim();
  if (options.sortOrder !== undefined) config.sortOrder = options.sortOrder;
  return config;
}

function sanitizeTransferFilters(filters: HeliusTransferFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const amount = sanitizeComparisonFilter(filters.amount);
  const blockTime = sanitizeComparisonFilter(filters.blockTime);
  const slot = sanitizeComparisonFilter(filters.slot);
  if (amount) out.amount = amount;
  if (blockTime) out.blockTime = blockTime;
  if (slot) out.slot = slot;
  return out;
}

function sanitizeComparisonFilter(filter: HeliusComparisonFilter | undefined): Record<string, number> | undefined {
  if (!filter) return undefined;
  const out: Record<string, number> = {};
  for (const key of ['gt', 'gte', 'lt', 'lte'] as const) {
    const value = filter[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function failedRecentTxs(error: string): HeliusRecentTxsResult {
  return {
    ok: false,
    txs: [],
    fetchedPages: 0,
    oldestBlockTime: null,
    stopReason: 'error',
    partial: false,
    budgetExceeded: false,
    timedOut: false,
    coverage_missing: false,
    budgetHit: false,
    error,
  };
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ProtocolError('invalid_request', `${field} is required.`);
  return trimmed;
}

function normalizedPublicKey(value: string, field: string): string {
  const trimmed = requireTrimmed(value, field);
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new ProtocolError('invalid_request', `${field} must be a valid Solana public key.`);
  }
}

function short(value: string | null): string {
  return value ? `${value.slice(0, 4)}...${value.slice(-4)}` : 'null';
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
