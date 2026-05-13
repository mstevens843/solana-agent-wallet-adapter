import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  DEFAULT_JUPITER_TOKEN_PRICE_MAX_BATCH_PRICE_IDS,
  DEFAULT_JUPITER_TOKEN_PRICE_MAX_SEARCH_MINT_IDS,
  type AgentWalletConfig,
} from '../../config.js';
import { getJupiterApiKey, jupiterFetchJson } from './client.js';

export const JUPITER_TOKEN_TAGS = ['lst', 'verified', 'stocks'] as const;
export type JupiterTokenTag = (typeof JUPITER_TOKEN_TAGS)[number];

export const JUPITER_TOKEN_CATEGORIES = ['toporganicscore', 'toptraded', 'toptrending'] as const;
export type JupiterTokenCategory = (typeof JUPITER_TOKEN_CATEGORIES)[number];

export const JUPITER_TOKEN_CATEGORY_INTERVALS = ['5m', '1h', '6h', '24h'] as const;
export type JupiterTokenCategoryInterval = (typeof JUPITER_TOKEN_CATEGORY_INTERVALS)[number];

export interface JupiterTokenSearchInput {
  query: string;
  limit?: number;
}

export interface JupiterTokenByTagInput {
  tag: JupiterTokenTag;
  limit?: number;
}

export interface JupiterTokenCategoryInput {
  category: JupiterTokenCategory;
  interval: JupiterTokenCategoryInterval;
  limit?: number;
}

export interface JupiterTokenRecentInput {
  limit?: number;
}

export interface JupiterPriceBatchInput {
  mints: string[];
}

export interface JupiterPriceInput {
  mint: string;
}

export function assertJupiterTokenPriceEnabled(config: AgentWalletConfig): void {
  if (config.connectors?.jupiter?.tokenPrice?.enabled === false) {
    throw new ProtocolError(
      'unauthorized',
      'Jupiter Token/Price reads are disabled by connectors.jupiter.tokenPrice.enabled=false.',
    );
  }
}

export function describeJupiterTokenPriceUnavailableReason(config: AgentWalletConfig): string | undefined {
  if (config.connectors?.jupiter?.tokenPrice?.enabled === false) {
    return 'Jupiter Token/Price reads are disabled by connectors.jupiter.tokenPrice.enabled=false.';
  }
  const { apiKey, envName } = getJupiterApiKey(config);
  return apiKey ? undefined : `Missing Jupiter API key. Set ${envName} or JUP_API_KEY.`;
}

export function jupiterMaxBatchPriceIds(config: AgentWalletConfig): number {
  return boundedPositiveInteger(
    config.connectors?.jupiter?.tokenPrice?.maxBatchPriceIds,
    DEFAULT_JUPITER_TOKEN_PRICE_MAX_BATCH_PRICE_IDS,
    DEFAULT_JUPITER_TOKEN_PRICE_MAX_BATCH_PRICE_IDS,
  );
}

export function jupiterMaxSearchMintIds(config: AgentWalletConfig): number {
  return boundedPositiveInteger(
    config.connectors?.jupiter?.tokenPrice?.maxSearchMintIds,
    DEFAULT_JUPITER_TOKEN_PRICE_MAX_SEARCH_MINT_IDS,
    DEFAULT_JUPITER_TOKEN_PRICE_MAX_SEARCH_MINT_IDS,
  );
}

export async function fetchJupiterTokenSearch(
  config: AgentWalletConfig,
  input: JupiterTokenSearchInput,
): Promise<Record<string, unknown>[]> {
  assertJupiterTokenPriceEnabled(config);
  const query = requiredTrimmed(input.query, 'query');
  const mintIds = commaSeparatedParts(query);
  const maxSearchMintIds = jupiterMaxSearchMintIds(config);
  if (mintIds.length > maxSearchMintIds) {
    throw new ProtocolError(
      'invalid_request',
      `Jupiter token search accepts at most ${maxSearchMintIds} comma-separated mint ids; received ${mintIds.length}.`,
    );
  }
  const body = await jupiterFetchJson(config, 'tokens', '/search', {
    searchParams: { query },
  });
  return limitRows(jupiterArrayResponse(body), input.limit ?? (mintIds.length > 1 ? mintIds.length : 20));
}

export async function fetchJupiterTokensByTag(
  config: AgentWalletConfig,
  input: JupiterTokenByTagInput,
): Promise<Record<string, unknown>[]> {
  assertJupiterTokenPriceEnabled(config);
  const body = await jupiterFetchJson(config, 'tokens', '/tag', {
    searchParams: { query: input.tag },
  });
  return limitRows(jupiterArrayResponse(body), input.limit);
}

export async function fetchJupiterTokenCategory(
  config: AgentWalletConfig,
  input: JupiterTokenCategoryInput,
): Promise<Record<string, unknown>[]> {
  assertJupiterTokenPriceEnabled(config);
  const limit = boundedPositiveInteger(input.limit, 50, 100);
  const body = await jupiterFetchJson(config, 'tokens', `/${input.category}/${input.interval}`, {
    searchParams: { limit },
  });
  return jupiterArrayResponse(body);
}

export async function fetchJupiterRecentTokens(
  config: AgentWalletConfig,
  input: JupiterTokenRecentInput = {},
): Promise<Record<string, unknown>[]> {
  assertJupiterTokenPriceEnabled(config);
  const body = await jupiterFetchJson(config, 'tokens', '/recent');
  return limitRows(jupiterArrayResponse(body), input.limit ?? 30);
}

export async function fetchJupiterPrices(
  config: AgentWalletConfig,
  input: JupiterPriceBatchInput,
): Promise<Record<string, unknown>> {
  assertJupiterTokenPriceEnabled(config);
  const mints = normalizeMintList(input.mints);
  const maxBatchPriceIds = jupiterMaxBatchPriceIds(config);
  if (mints.length === 0) {
    throw new ProtocolError('invalid_request', 'mints must include at least one mint address.');
  }
  if (mints.length > maxBatchPriceIds) {
    throw new ProtocolError(
      'invalid_request',
      `Jupiter price reads accept at most ${maxBatchPriceIds} ids per request; received ${mints.length}.`,
    );
  }
  return jupiterFetchJson(config, 'price', '', {
    searchParams: { ids: mints.join(',') },
  });
}

export function normalizeMintList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function jupiterArrayResponse(body: Record<string, unknown>): Record<string, unknown>[] {
  const value = body.data ?? body.tokens ?? body.results ?? body.items ?? body.list;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)),
  );
}

function limitRows<T>(rows: T[], limit: number | undefined): T[] {
  if (limit === undefined) return rows;
  return rows.slice(0, boundedPositiveInteger(limit, rows.length, rows.length));
}

function requiredTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ProtocolError('invalid_request', `${field} is required.`);
  return trimmed;
}

function commaSeparatedParts(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) return fallback;
  return Math.min(value, max);
}
