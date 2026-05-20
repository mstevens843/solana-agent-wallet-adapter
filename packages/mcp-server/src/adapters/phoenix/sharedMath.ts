import { PHOENIX_TICKS_PER_USD } from './constants.js';

/**
 * Phoenix uses tick-based prices for stop-loss / take-profit triggers. Convert a USD-denominated price into a Phoenix
 * tick (rounded toward zero). 1 USD = `PHOENIX_TICKS_PER_USD` ticks (defaults to 1e6, i.e. 6-decimal precision).
 */
export function usdToTickPrice(priceUsd: number | string): bigint {
  const value = typeof priceUsd === 'number' ? priceUsd : Number(priceUsd);
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Phoenix tick price requires a non-negative finite USD value; received ${priceUsd}.`);
  }
  return BigInt(Math.trunc(value * Number(PHOENIX_TICKS_PER_USD)));
}

export function tickPriceToUsd(ticks: bigint | string | number): string {
  const value = typeof ticks === 'bigint' ? ticks : BigInt(String(ticks).split('.')[0] ?? '0');
  const whole = value / PHOENIX_TICKS_PER_USD;
  const fraction = value % PHOENIX_TICKS_PER_USD;
  if (fraction === 0n) return whole.toString();
  const fractionStr = fraction.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fractionStr}`;
}

/**
 * Project the liquidation price for a *hypothetical* position. Conservative model: assumes isolated-margin
 * accounting at the requested leverage; for cross-margin the on-chain program may give a more favourable number, so
 * this function intentionally errs toward earlier liquidation. Used only for previews, never for on-chain decisions.
 */
export function projectLiquidationPriceUsd(input: {
  side: 'long' | 'short';
  entryPriceUsd: number;
  leverage: number;
  /** Maintenance margin requirement as a fraction (e.g. 0.05 for 5%). Defaults to 0.05. */
  maintenanceMarginRatio?: number;
}): number {
  const { side, entryPriceUsd, leverage } = input;
  const maintenance = input.maintenanceMarginRatio ?? 0.05;
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    throw new RangeError(`entryPriceUsd must be a positive number; received ${entryPriceUsd}.`);
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new RangeError(`leverage must be a positive number; received ${leverage}.`);
  }
  if (!Number.isFinite(maintenance) || maintenance < 0 || maintenance >= 1) {
    throw new RangeError(`maintenanceMarginRatio must be in [0, 1); received ${maintenance}.`);
  }
  const drawdown = 1 / leverage - maintenance;
  if (side === 'long') {
    return entryPriceUsd * (1 - drawdown);
  }
  return entryPriceUsd * (1 + drawdown);
}

/**
 * Buffer % between current mark and projected liquidation. Larger is safer.
 * Returns a value in `[0, 100]`.
 */
export function liquidationBufferPct(markPriceUsd: number, liquidationPriceUsd: number, side: 'long' | 'short'): number {
  if (!Number.isFinite(markPriceUsd) || markPriceUsd <= 0) return 0;
  if (!Number.isFinite(liquidationPriceUsd) || liquidationPriceUsd <= 0) return 0;
  if (side === 'long') {
    if (markPriceUsd <= liquidationPriceUsd) return 0;
    return ((markPriceUsd - liquidationPriceUsd) / markPriceUsd) * 100;
  }
  if (liquidationPriceUsd <= markPriceUsd) return 0;
  return ((liquidationPriceUsd - markPriceUsd) / markPriceUsd) * 100;
}

/** Margin ratio = collateral / notional. Higher is safer. */
export function projectMarginRatio(input: {
  collateralUsd: number;
  notionalUsd: number;
}): number {
  if (!Number.isFinite(input.notionalUsd) || input.notionalUsd <= 0) return Number.POSITIVE_INFINITY;
  return input.collateralUsd / input.notionalUsd;
}

export interface ProjectedPosition {
  /** Effective size after the hypothetical action. 0 means flat. */
  baseSize: number;
  /** Effective average entry price after the hypothetical action. */
  entryPriceUsd: number;
  /** Direction of the resulting position. Meaningless when baseSize === 0. */
  side: 'long' | 'short';
  /** Warnings about how the combination was modeled (e.g., opposite-side flips). */
  warnings: string[];
}

/**
 * Combine an existing position with a hypothetical delta into a single projected position.
 *
 * Modeled conservatively:
 *  - `open` same side: weighted-average entry; size accumulates.
 *  - `open` opposite side: treat the delta as a partial close of the existing position; if it overshoots,
 *    the remainder becomes a new position on the delta's side at `markPriceUsd`. Adds a warning because
 *    overshoot pricing can drift from on-chain settlement.
 *  - `close`: shrink the existing position (clamped to 0). The `side` of `delta` is ignored — we always
 *    reduce the existing exposure.
 *  - `modify_collateral`: no size change; same entry; size and side unchanged.
 *
 * When `existing` is `undefined`, the projected position is the delta itself (or flat for close).
 */
export function combinePosition(input: {
  existing?: { baseSize: number; entryPriceUsd: number; side: 'long' | 'short' };
  delta: { baseSize: number; side: 'long' | 'short' };
  action: 'open' | 'close' | 'modify_collateral';
  markPriceUsd: number;
}): ProjectedPosition {
  const { existing, delta, action, markPriceUsd } = input;
  const warnings: string[] = [];

  if (action === 'modify_collateral') {
    if (!existing || existing.baseSize <= 0) {
      return { baseSize: 0, entryPriceUsd: markPriceUsd, side: delta.side, warnings };
    }
    return { baseSize: existing.baseSize, entryPriceUsd: existing.entryPriceUsd, side: existing.side, warnings };
  }

  if (action === 'close') {
    if (!existing || existing.baseSize <= 0) {
      return { baseSize: 0, entryPriceUsd: markPriceUsd, side: delta.side, warnings };
    }
    const remaining = Math.max(0, existing.baseSize - delta.baseSize);
    if (remaining === 0) return { baseSize: 0, entryPriceUsd: existing.entryPriceUsd, side: existing.side, warnings };
    return { baseSize: remaining, entryPriceUsd: existing.entryPriceUsd, side: existing.side, warnings };
  }

  // action === 'open'
  if (!existing || existing.baseSize <= 0) {
    return { baseSize: delta.baseSize, entryPriceUsd: markPriceUsd, side: delta.side, warnings };
  }

  if (existing.side === delta.side) {
    const totalSize = existing.baseSize + delta.baseSize;
    const weightedEntry =
      (existing.baseSize * existing.entryPriceUsd + delta.baseSize * markPriceUsd) / totalSize;
    return { baseSize: totalSize, entryPriceUsd: weightedEntry, side: existing.side, warnings };
  }

  // Opposite side: net out the smaller against the larger.
  if (delta.baseSize === existing.baseSize) {
    warnings.push('Hypothetical action fully closes the existing position; result is flat.');
    return { baseSize: 0, entryPriceUsd: existing.entryPriceUsd, side: existing.side, warnings };
  }
  if (delta.baseSize < existing.baseSize) {
    warnings.push(
      'Hypothetical action partially closes the existing position; projected liquidation reflects the residual.',
    );
    return {
      baseSize: existing.baseSize - delta.baseSize,
      entryPriceUsd: existing.entryPriceUsd,
      side: existing.side,
      warnings,
    };
  }
  warnings.push(
    'Hypothetical action exceeds the existing position; projected liquidation models the post-flip residual on the new side at mark price (actual on-chain settlement may differ).',
  );
  return {
    baseSize: delta.baseSize - existing.baseSize,
    entryPriceUsd: markPriceUsd,
    side: delta.side,
    warnings,
  };
}
