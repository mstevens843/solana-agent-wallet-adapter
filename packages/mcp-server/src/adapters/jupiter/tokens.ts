import type { AgentWalletConfig } from '../../config.js';
import {
  fetchJupiterRecentTokens,
  fetchJupiterTokenCategory,
  fetchJupiterTokenSearch,
  fetchJupiterTokensByTag,
  type JupiterTokenByTagInput,
  type JupiterTokenCategoryInput,
  type JupiterTokenRecentInput,
  type JupiterTokenSearchInput,
} from './tokenClient.js';

export interface JupiterTokenStats {
  priceChange?: number;
  holderChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupiterTokenFirstPool {
  id?: string;
  createdAt?: string;
}

export interface JupiterTokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimals?: number;
  tokenProgram?: string;
  createdAt?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
  dev?: string;
  mintAuthority?: string;
  freezeAuthority?: string;
  circSupply?: number;
  totalSupply?: number;
  launchpad?: string;
  partnerConfig?: string;
  graduatedPool?: string;
  graduatedAt?: string;
  holderCount?: number;
  fdv?: number;
  mcap?: number;
  usdPrice?: number;
  priceBlockId?: number;
  liquidity?: number;
  firstPool?: JupiterTokenFirstPool;
  audit?: Record<string, unknown>;
  organicScore?: number;
  organicScoreLabel?: 'high' | 'medium' | 'low' | string;
  isVerified?: boolean | null;
  cexes?: string[];
  tags?: string[];
  stats5m?: JupiterTokenStats;
  stats1h?: JupiterTokenStats;
  stats6h?: JupiterTokenStats;
  stats24h?: JupiterTokenStats;
  updatedAt?: string;
}

export interface JupiterTokenReadResult {
  source: 'search' | 'tag' | 'category' | 'recent';
  query?: string;
  tag?: string;
  category?: string;
  interval?: string;
  tokens: JupiterTokenInfo[];
  asOf: string;
}

export async function getJupiterTokenSearch(
  config: AgentWalletConfig,
  input: JupiterTokenSearchInput,
): Promise<JupiterTokenReadResult> {
  const rows = await fetchJupiterTokenSearch(config, input);
  return {
    source: 'search',
    query: input.query.trim(),
    tokens: normalizeJupiterTokens(rows),
    asOf: new Date().toISOString(),
  };
}

export async function getJupiterTokensByTag(
  config: AgentWalletConfig,
  input: JupiterTokenByTagInput,
): Promise<JupiterTokenReadResult> {
  const rows = await fetchJupiterTokensByTag(config, input);
  return {
    source: 'tag',
    tag: input.tag,
    tokens: normalizeJupiterTokens(rows),
    asOf: new Date().toISOString(),
  };
}

export async function getJupiterTokenCategory(
  config: AgentWalletConfig,
  input: JupiterTokenCategoryInput,
): Promise<JupiterTokenReadResult> {
  const rows = await fetchJupiterTokenCategory(config, input);
  return {
    source: 'category',
    category: input.category,
    interval: input.interval,
    tokens: normalizeJupiterTokens(rows),
    asOf: new Date().toISOString(),
  };
}

export async function getJupiterRecentTokens(
  config: AgentWalletConfig,
  input: JupiterTokenRecentInput = {},
): Promise<JupiterTokenReadResult> {
  const rows = await fetchJupiterRecentTokens(config, input);
  return {
    source: 'recent',
    tokens: normalizeJupiterTokens(rows),
    asOf: new Date().toISOString(),
  };
}

export function normalizeJupiterTokens(rows: Record<string, unknown>[]): JupiterTokenInfo[] {
  return rows
    .map(normalizeJupiterToken)
    .filter((token): token is JupiterTokenInfo => token !== undefined);
}

export function normalizeJupiterToken(row: Record<string, unknown>): JupiterTokenInfo | undefined {
  const id = stringField(row.id ?? row.mint ?? row.address);
  if (!id) return undefined;
  return {
    id,
    ...(stringField(row.name) !== undefined && { name: stringField(row.name) }),
    ...(stringField(row.symbol) !== undefined && { symbol: stringField(row.symbol) }),
    ...(stringField(row.icon) !== undefined && { icon: stringField(row.icon) }),
    ...(numberField(row.decimals) !== undefined && { decimals: numberField(row.decimals) }),
    ...(stringField(row.tokenProgram) !== undefined && { tokenProgram: stringField(row.tokenProgram) }),
    ...(stringField(row.createdAt) !== undefined && { createdAt: stringField(row.createdAt) }),
    ...(stringField(row.twitter) !== undefined && { twitter: stringField(row.twitter) }),
    ...(stringField(row.telegram) !== undefined && { telegram: stringField(row.telegram) }),
    ...(stringField(row.website) !== undefined && { website: stringField(row.website) }),
    ...(stringField(row.discord) !== undefined && { discord: stringField(row.discord) }),
    ...(stringField(row.dev) !== undefined && { dev: stringField(row.dev) }),
    ...(stringField(row.mintAuthority) !== undefined && { mintAuthority: stringField(row.mintAuthority) }),
    ...(stringField(row.freezeAuthority) !== undefined && { freezeAuthority: stringField(row.freezeAuthority) }),
    ...(numberField(row.circSupply) !== undefined && { circSupply: numberField(row.circSupply) }),
    ...(numberField(row.totalSupply) !== undefined && { totalSupply: numberField(row.totalSupply) }),
    ...(stringField(row.launchpad) !== undefined && { launchpad: stringField(row.launchpad) }),
    ...(stringField(row.partnerConfig) !== undefined && { partnerConfig: stringField(row.partnerConfig) }),
    ...(stringField(row.graduatedPool) !== undefined && { graduatedPool: stringField(row.graduatedPool) }),
    ...(stringField(row.graduatedAt) !== undefined && { graduatedAt: stringField(row.graduatedAt) }),
    ...(numberField(row.holderCount) !== undefined && { holderCount: numberField(row.holderCount) }),
    ...(numberField(row.fdv) !== undefined && { fdv: numberField(row.fdv) }),
    ...(numberField(row.mcap) !== undefined && { mcap: numberField(row.mcap) }),
    ...(numberField(row.usdPrice) !== undefined && { usdPrice: numberField(row.usdPrice) }),
    ...(numberField(row.priceBlockId) !== undefined && { priceBlockId: numberField(row.priceBlockId) }),
    ...(numberField(row.liquidity) !== undefined && { liquidity: numberField(row.liquidity) }),
    ...(normalizeFirstPool(row.firstPool) !== undefined && { firstPool: normalizeFirstPool(row.firstPool) }),
    ...(recordField(row.audit) !== undefined && { audit: recordField(row.audit) }),
    ...(numberField(row.organicScore) !== undefined && { organicScore: numberField(row.organicScore) }),
    ...(stringField(row.organicScoreLabel) !== undefined && { organicScoreLabel: stringField(row.organicScoreLabel) }),
    ...(booleanOrNullField(row.isVerified) !== undefined && { isVerified: booleanOrNullField(row.isVerified) }),
    ...(stringArrayField(row.cexes) !== undefined && { cexes: stringArrayField(row.cexes) }),
    ...(stringArrayField(row.tags) !== undefined && { tags: stringArrayField(row.tags) }),
    ...(normalizeStats(row.stats5m) !== undefined && { stats5m: normalizeStats(row.stats5m) }),
    ...(normalizeStats(row.stats1h) !== undefined && { stats1h: normalizeStats(row.stats1h) }),
    ...(normalizeStats(row.stats6h) !== undefined && { stats6h: normalizeStats(row.stats6h) }),
    ...(normalizeStats(row.stats24h) !== undefined && { stats24h: normalizeStats(row.stats24h) }),
    ...(stringField(row.updatedAt) !== undefined && { updatedAt: stringField(row.updatedAt) }),
  };
}

function normalizeFirstPool(value: unknown): JupiterTokenFirstPool | undefined {
  const record = recordField(value);
  if (!record) return undefined;
  const firstPool: JupiterTokenFirstPool = {};
  const id = stringField(record.id);
  const createdAt = stringField(record.createdAt);
  if (id !== undefined) firstPool.id = id;
  if (createdAt !== undefined) firstPool.createdAt = createdAt;
  return Object.keys(firstPool).length > 0 ? firstPool : undefined;
}

function normalizeStats(value: unknown): JupiterTokenStats | undefined {
  const record = recordField(value);
  if (!record) return undefined;
  const stats: JupiterTokenStats = {};
  for (const key of [
    'priceChange',
    'holderChange',
    'liquidityChange',
    'volumeChange',
    'buyVolume',
    'sellVolume',
    'buyOrganicVolume',
    'sellOrganicVolume',
    'numBuys',
    'numSells',
    'numTraders',
    'numOrganicBuyers',
    'numNetBuyers',
  ] as const) {
    const value = numberField(record[key]);
    if (value !== undefined) stats[key] = value;
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function booleanOrNullField(value: unknown): boolean | null | undefined {
  if (typeof value === 'boolean') return value;
  return value === null ? null : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  return rows.length > 0 ? rows : undefined;
}
