import type { Cluster } from './types.js';

export const WALLET_BALANCE_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const WALLET_BALANCE_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export type WalletBalanceCoverage = 'primary' | 'full';
export type WalletBalancePriceStatus = 'ready' | 'partial' | 'unavailable';

export interface WalletBalanceKnownToken {
  symbol: string;
  mint: string;
  decimals: number;
}

export interface WalletBalanceTokenRow {
  mint: string;
  amount: number;
  decimals: number;
  rawAmount?: string;
  source?: 'token' | 'token-2022' | 'unknown';
}

export interface WalletBalanceAsset {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number;
  priceUsd?: number;
  valueUsd?: number;
  source: 'native' | 'token' | 'token-2022' | 'unknown';
}

export interface WalletBalanceSnapshot {
  walletAddress: string;
  cluster: string;
  loadedAt: number;
  coverage: WalletBalanceCoverage;
  totalUsd: number;
  hasMissingPrices: boolean;
  priceStatus: WalletBalancePriceStatus;
  sol: WalletBalanceAsset;
  usdc: WalletBalanceAsset;
  others: WalletBalanceAsset[];
}

export interface BuildWalletBalanceSnapshotInput {
  walletAddress: string;
  cluster: string;
  solLamports: number | string | bigint;
  tokenRows: WalletBalanceTokenRow[];
  prices: Map<string, number>;
  knownTokens?: Record<string, WalletBalanceKnownToken>;
  loadedAt?: number;
  coverage?: WalletBalanceCoverage;
  pricingEnabled?: boolean;
}

export function walletBalanceUsdPricingEnabled(cluster: string | Cluster): boolean {
  return cluster === 'mainnet-beta';
}

export function walletBalanceRowsFromParsedAccounts(
  value: unknown,
  source: WalletBalanceTokenRow['source'] = 'unknown',
): WalletBalanceTokenRow[] {
  const entries = parsedAccountEntries(value);
  const rows: WalletBalanceTokenRow[] = [];
  for (const entry of entries) {
    const account = asRecord(entry)?.account;
    const data = asRecord(asRecord(account)?.data);
    const parsed = asRecord(data?.parsed);
    const info = asRecord(parsed?.info);
    const tokenAmount = asRecord(info?.tokenAmount);
    const mint = stringField(info?.mint);
    const rawAmount = stringField(tokenAmount?.amount);
    const decimals = numberField(tokenAmount?.decimals);
    if (!mint || !tokenAmount || decimals === undefined || !Number.isInteger(decimals) || decimals < 0) continue;
    const amount = tokenAmountUiAmount(tokenAmount, rawAmount, decimals);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    rows.push({
      mint,
      amount,
      decimals,
      ...(rawAmount ? { rawAmount } : {}),
      source,
    });
  }
  return rows;
}

export function mergeWalletBalanceTokenRows(rows: WalletBalanceTokenRow[]): WalletBalanceTokenRow[] {
  const byMint = new Map<string, WalletBalanceTokenRow>();
  for (const row of rows) {
    if (!row.mint || !Number.isFinite(row.amount) || row.amount <= 0) continue;
    const existing = byMint.get(row.mint);
    if (!existing) {
      byMint.set(row.mint, { ...row });
      continue;
    }
    const decimals = existing.decimals === row.decimals ? existing.decimals : Math.max(existing.decimals, row.decimals);
    byMint.set(row.mint, {
      mint: row.mint,
      amount: existing.amount + row.amount,
      decimals,
      source: existing.source === row.source ? existing.source : 'unknown',
    });
  }
  return [...byMint.values()];
}

export function walletBalancePriceMapFromBirdeye(payload: unknown): Map<string, number> {
  const prices = new Map<string, number>();
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  if (!data) return prices;
  for (const [mint, value] of Object.entries(data)) {
    const price = walletBalancePriceFromBirdeyeValue(value);
    if (!mint || price === undefined || !Number.isFinite(price) || price < 0) continue;
    prices.set(mint, price);
  }
  return prices;
}

export function walletBalanceFallbackPriceMap(mints: string[], cluster: string | Cluster = 'mainnet-beta'): Map<string, number> {
  const prices = new Map<string, number>();
  if (walletBalanceUsdPricingEnabled(cluster) && mints.includes(WALLET_BALANCE_USDC_MINT)) {
    prices.set(WALLET_BALANCE_USDC_MINT, 1);
  }
  return prices;
}

export function buildWalletBalanceSnapshot(input: BuildWalletBalanceSnapshotInput): WalletBalanceSnapshot {
  const loadedAt = input.loadedAt ?? Date.now();
  const knownByMint = knownTokensByMint(input.knownTokens);
  const mergedRows = mergeWalletBalanceTokenRows(input.tokenRows);
  const solAmount = lamportsToSol(input.solLamports);
  const usdcRow = mergedRows.find((row) => row.mint === WALLET_BALANCE_USDC_MINT);
  const usdcKnown = knownByMint.get(WALLET_BALANCE_USDC_MINT);
  const pricingEnabled = input.pricingEnabled ?? walletBalanceUsdPricingEnabled(input.cluster);
  const sol = assetFromAmount({
    mint: WALLET_BALANCE_SOL_MINT,
    amount: solAmount,
    decimals: 9,
    symbol: 'SOL',
    source: 'native',
    prices: input.prices,
  });
  const usdc = assetFromAmount({
    mint: WALLET_BALANCE_USDC_MINT,
    amount: usdcRow?.amount ?? 0,
    decimals: usdcRow?.decimals ?? usdcKnown?.decimals ?? 6,
    symbol: usdcKnown?.symbol ?? 'USDC',
    source: usdcRow?.source ?? 'token',
    prices: input.prices,
  });
  const others = mergedRows
    .filter((row) => row.mint !== WALLET_BALANCE_USDC_MINT && row.mint !== WALLET_BALANCE_SOL_MINT)
    .map((row) => {
      const known = knownByMint.get(row.mint);
      return assetFromAmount({
        mint: row.mint,
        amount: row.amount,
        decimals: row.decimals,
        symbol: known?.symbol ?? walletBalanceShortMint(row.mint),
        source: row.source ?? 'unknown',
        prices: input.prices,
      });
    })
    .sort(walletBalanceAssetSort);
  const assets = [sol, usdc, ...others].filter((asset) => asset.amount > 0);
  const hasMissingPrices = pricingEnabled && assets.some((asset) => asset.priceUsd === undefined);
  return {
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    loadedAt,
    coverage: input.coverage ?? 'primary',
    totalUsd: assets.reduce((sum, asset) => sum + (asset.valueUsd ?? 0), 0),
    hasMissingPrices,
    priceStatus: pricingEnabled ? (hasMissingPrices ? 'partial' : 'ready') : 'unavailable',
    sol,
    usdc,
    others,
  };
}

export function formatWalletBalanceSnapshotUsd(
  snapshot: WalletBalanceSnapshot,
  options: { markPartialCoverage?: boolean } = {},
): string {
  if (snapshot.priceStatus === 'unavailable') return 'USD unavailable';
  const partial = snapshot.hasMissingPrices || (options.markPartialCoverage === true && snapshot.coverage === 'primary');
  return formatWalletBalanceUsd(snapshot.totalUsd, partial);
}

export function formatWalletBalanceUsd(value: number | undefined, partial = false): string {
  if (value === undefined || !Number.isFinite(value)) return 'Price unavailable';
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return partial ? '<$0.01+' : '<$0.01';
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: abs >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);
  return partial ? `${formatted}+` : formatted;
}

export function formatWalletBalanceAmount(amount: number, symbol: string): string {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const upper = symbol.toUpperCase();
  const maximumFractionDigits = upper === 'USDC'
    ? 2
    : safeAmount >= 1
      ? 4
      : safeAmount >= 0.000001
        ? 6
        : 9;
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
    minimumFractionDigits: upper === 'USDC' ? 2 : 0,
  }).format(safeAmount);
  return `${formatted} ${symbol}`;
}

export function walletBalanceShortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;
}

function walletBalancePriceFromBirdeyeValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  const record = asRecord(value);
  if (!record) return numberField(value);
  const nestedData = asRecord(record.data);
  return numberField(record.value)
    ?? numberField(record.price)
    ?? numberField(record.priceUsd)
    ?? numberField(record.price_usd)
    ?? numberField(nestedData?.value)
    ?? numberField(nestedData?.price)
    ?? numberField(nestedData?.priceUsd)
    ?? numberField(nestedData?.price_usd);
}

function parsedAccountEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (Array.isArray(record?.value)) return record.value;
  return [];
}

function tokenAmountUiAmount(tokenAmount: Record<string, unknown>, rawAmount: string | undefined, decimals: number): number {
  const uiAmount = numberField(tokenAmount.uiAmount);
  if (uiAmount !== undefined) return uiAmount;
  const uiAmountString = stringField(tokenAmount.uiAmountString);
  if (uiAmountString) {
    const parsed = Number(uiAmountString);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (!rawAmount) return 0;
  return rawAmountToNumber(rawAmount, decimals);
}

function rawAmountToNumber(rawAmount: string, decimals: number): number {
  try {
    const decimal = decimalStringFromRaw(BigInt(rawAmount), decimals);
    const parsed = Number(decimal);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function decimalStringFromRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString();
  if (decimals <= 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(decimals + 1, '0');
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

function lamportsToSol(lamports: number | string | bigint): number {
  try {
    return Number(decimalStringFromRaw(BigInt(lamports), 9));
  } catch {
    const parsed = Number(lamports);
    return Number.isFinite(parsed) ? parsed / 1_000_000_000 : 0;
  }
}

function assetFromAmount(input: {
  mint: string;
  amount: number;
  decimals: number;
  symbol: string;
  source: WalletBalanceAsset['source'];
  prices: Map<string, number>;
}): WalletBalanceAsset {
  const priceUsd = input.prices.get(input.mint);
  return {
    mint: input.mint,
    symbol: input.symbol,
    amount: input.amount,
    decimals: input.decimals,
    source: input.source,
    ...(priceUsd !== undefined ? { priceUsd, valueUsd: input.amount * priceUsd } : {}),
  };
}

function walletBalanceAssetSort(left: WalletBalanceAsset, right: WalletBalanceAsset): number {
  const leftValue = left.valueUsd ?? -1;
  const rightValue = right.valueUsd ?? -1;
  if (rightValue !== leftValue) return rightValue - leftValue;
  return right.amount - left.amount;
}

function knownTokensByMint(tokens: Record<string, WalletBalanceKnownToken> | undefined): Map<string, WalletBalanceKnownToken> {
  const byMint = new Map<string, WalletBalanceKnownToken>();
  for (const token of Object.values(tokens ?? {})) {
    byMint.set(token.mint, token);
  }
  return byMint;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
