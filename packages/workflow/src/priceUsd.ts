/**
 * USD pricing helpers for the agent review pipeline.
 *
 * Design constraints (per user-set goal):
 *   - One price source per token, no cross-source corroboration in the hot path.
 *   - Stablecoins resolve to $1.00 with zero API calls.
 *   - SOL gets a single Pyth fetch (handled in the browser layer).
 *   - Other tokens piggyback on existing router-fetched price evidence; if absent,
 *     the fact carries no USD value (token-native remains the source of truth).
 *
 * USD values are ADDITIVE annotations — never a replacement for the native amount.
 * Receipts persist both `amountLamports` (canonical) and `usd` (annotation).
 */

export type PriceUsdSource = 'stablecoin' | 'pyth' | 'jupiter' | 'birdeye' | 'coingecko' | 'evidence';

export interface PriceUsdSnapshot {
  /** 'SOL' or an SPL mint address. */
  mint: string;
  usdPerToken: number;
  source: PriceUsdSource;
  checkedAt: string;
  /** Optional confidence interval when the source provides one (e.g., Pyth). */
  confidence?: number;
}

/**
 * Mints that are USD-pegged stablecoins. Resolves to $1.00 with no API call.
 *
 * Cross-checked against the per-adapter constants in packages/mcp-server/src/adapters/
 * (notably lulo/constants.ts which uses these exact mints).
 */
export const STABLECOIN_USD_MAP: Readonly<Record<string, number>> = Object.freeze({
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1, // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 1, // PYUSD
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: 1, // USDS
});

/**
 * The canonical SOL "mint" placeholder used throughout the workflow. SOL is native,
 * not an SPL token, but the rest of the price pipeline treats it as a mint-keyed
 * lookup for consistency.
 */
export const SOL_MINT_KEY = 'SOL';

/** Convenience: returns true for any known $1-pegged stablecoin (case-sensitive). */
export function isStablecoinMint(mint: string): boolean {
  return Object.prototype.hasOwnProperty.call(STABLECOIN_USD_MAP, mint);
}

/**
 * Build a $1.00 PriceUsdSnapshot for a known stablecoin. Returns undefined for
 * non-stablecoin mints — callers should fall back to a price source.
 */
export function stablecoinSnapshot(mint: string, checkedAtIso?: string): PriceUsdSnapshot | undefined {
  if (!isStablecoinMint(mint)) return undefined;
  return {
    mint,
    usdPerToken: STABLECOIN_USD_MAP[mint]!,
    source: 'stablecoin',
    checkedAt: checkedAtIso ?? new Date().toISOString(),
  };
}

/**
 * Convert a raw lamport-style amount (string for precision) into a USD number.
 * Returns undefined when usdPerToken is missing or non-finite.
 */
export function tokenAmountToUsd(
  rawAmount: string | number | bigint,
  decimals: number,
  usdPerToken: number | undefined,
): number | undefined {
  if (typeof usdPerToken !== 'number' || !Number.isFinite(usdPerToken)) return undefined;
  if (!Number.isFinite(decimals) || decimals < 0) return undefined;
  const tokens = rawToTokens(rawAmount, decimals);
  if (tokens === undefined) return undefined;
  return tokens * usdPerToken;
}

function rawToTokens(rawAmount: string | number | bigint, decimals: number): number | undefined {
  if (typeof rawAmount === 'bigint') {
    return Number(rawAmount) / Math.pow(10, decimals);
  }
  if (typeof rawAmount === 'number') {
    if (!Number.isFinite(rawAmount)) return undefined;
    return rawAmount / Math.pow(10, decimals);
  }
  if (typeof rawAmount === 'string' && rawAmount.trim()) {
    const num = Number(rawAmount.trim());
    if (!Number.isFinite(num)) return undefined;
    return num / Math.pow(10, decimals);
  }
  return undefined;
}

/**
 * Display formatter: "1 SOL ($142.50)" / "100 USDC ($100.00)" / "1 SOL" when price
 * is unknown. USD is always parenthetical and additive — never replaces the native.
 */
export function formatTokenWithUsd(
  rawAmount: string | number | bigint,
  decimals: number,
  symbol: string,
  usdPerToken: number | undefined,
): string {
  const tokens = rawToTokens(rawAmount, decimals);
  const native = tokens === undefined
    ? `${String(rawAmount)} ${symbol}`
    : `${formatNumber(tokens)} ${symbol}`;
  const usd = typeof usdPerToken === 'number' && Number.isFinite(usdPerToken) && tokens !== undefined
    ? formatUsd(tokens * usdPerToken)
    : undefined;
  return usd ? `${native} (${usd})` : native;
}

/** Pretty-print a USD value, "$1,234.56" / "$0.0042" / "<$0.01". */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$?';
  if (value === 0) return '$0.00';
  const abs = Math.abs(value);
  if (abs < 0.01) return value < 0 ? '-<$0.01' : '<$0.01';
  if (abs < 1) return `${value < 0 ? '-' : ''}$${abs.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return formatter.format(value);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
  }
  // Sub-1 values: trim trailing zeros but show up to 8 significant decimals.
  return Number(value.toPrecision(8)).toString();
}

/**
 * Apply a USD snapshot to an evidence-fact value string. Returns the augmented value
 * if a snapshot is available, otherwise returns the input unchanged.
 */
export function augmentValueWithUsd(value: string, usd: number | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return value;
  return `${value} (${formatUsd(usd)})`;
}
