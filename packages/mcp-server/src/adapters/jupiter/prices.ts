import type { AgentWalletConfig } from '../../config.js';
import {
  fetchJupiterPrices,
  normalizeMintList,
  type JupiterPriceBatchInput,
  type JupiterPriceInput,
} from './tokenClient.js';

export type JupiterPriceStatus = 'found' | 'missing';

export interface JupiterPriceSnapshot {
  mint: string;
  status: JupiterPriceStatus;
  usdPrice?: number;
  decimals?: number;
  blockId?: number;
  priceChange24h?: number;
  liquidity?: number;
  createdAt?: string;
  reason?: string;
  asOf: string;
}

export interface JupiterPriceBatchResult {
  prices: JupiterPriceSnapshot[];
  totals: {
    requested: number;
    found: number;
    missing: number;
  };
  asOf: string;
}

export async function getJupiterPrice(
  config: AgentWalletConfig,
  input: JupiterPriceInput,
): Promise<JupiterPriceSnapshot> {
  const result = await getJupiterPriceBatch(config, { mints: [input.mint] });
  return result.prices[0] ?? missingPrice(input.mint.trim(), result.asOf);
}

export async function getJupiterPriceBatch(
  config: AgentWalletConfig,
  input: JupiterPriceBatchInput,
): Promise<JupiterPriceBatchResult> {
  const mints = normalizeMintList(input.mints);
  const body = await fetchJupiterPrices(config, { mints });
  const asOf = new Date().toISOString();
  const prices = mints.map((mint) => normalizePriceSnapshot(mint, body[mint], asOf));
  const found = prices.filter((price) => price.status === 'found').length;
  return {
    prices,
    totals: {
      requested: mints.length,
      found,
      missing: prices.length - found,
    },
    asOf,
  };
}

function normalizePriceSnapshot(mint: string, value: unknown, asOf: string): JupiterPriceSnapshot {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record) return missingPrice(mint, asOf);
  const usdPrice = numberField(record.usdPrice);
  if (usdPrice === undefined) return missingPrice(mint, asOf);
  return {
    mint,
    status: 'found',
    usdPrice,
    ...(numberField(record.decimals) !== undefined && { decimals: numberField(record.decimals) }),
    ...(numberField(record.blockId) !== undefined && { blockId: numberField(record.blockId) }),
    ...(numberField(record.priceChange24h) !== undefined && { priceChange24h: numberField(record.priceChange24h) }),
    ...(numberField(record.liquidity) !== undefined && { liquidity: numberField(record.liquidity) }),
    ...(stringField(record.createdAt) !== undefined && { createdAt: stringField(record.createdAt) }),
    asOf,
  };
}

function missingPrice(mint: string, asOf: string): JupiterPriceSnapshot {
  return {
    mint,
    status: 'missing',
    reason:
      'Jupiter Price API did not return a reliable price. The token may be stale, untraded recently, or flagged by Jupiter heuristics.',
    asOf,
  };
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
