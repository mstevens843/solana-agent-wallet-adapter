import { PublicKey } from '@solana/web3.js';

import { AdapterError, type DAppAdapterContext } from '../types.js';
import { PHOENIX_ADAPTER_ID, PHOENIX_TRADER_PDA_INDEX_DEFAULT } from './constants.js';
import {
  resolvePhoenixClient,
  withPhoenixErrors,
  type PhoenixHealthPreview,
} from './client.js';
import {
  combinePosition,
  liquidationBufferPct,
  projectLiquidationPriceUsd,
  projectMarginRatio,
} from './sharedMath.js';

export interface PhoenixHealthPreviewInput {
  walletAddress?: string;
  symbol: string;
  side: 'long' | 'short';
  baseSize: number | string;
  leverage: number;
  action?: 'open' | 'close' | 'modify_collateral';
  traderPdaIndex?: number;
}

export interface PhoenixHealthPreviewResult extends PhoenixHealthPreview {
  walletAddress: string;
  symbol: string;
  side: 'long' | 'short';
  leverage: number;
  baseSize: string;
  asOf: string;
}

function assertPubkey(value: string, field: string): void {
  try {
    new PublicKey(value);
  } catch {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', `${field} is not a valid Solana public key.`);
  }
}

function parsePositiveNumber(value: number | string, field: string): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', `${field} must be a positive finite number.`);
  }
  return num;
}

/**
 * Project the post-action liquidation price, margin ratio, and free collateral for a hypothetical Phoenix action.
 *
 * Loads the user's current trader state + market snapshot, then uses `combinePosition` to model how the requested
 * `action` (open / close / modify_collateral) would interact with any existing position on the same symbol.
 *
 * When the projected position is flat (e.g., closing an entire position), liquidation price and margin ratio are
 * omitted with an explanatory warning. When mark price is missing from the market snapshot, projected liq is
 * omitted similarly. When the API does not return `freeCollateralUsd`, projected margin ratio is omitted.
 *
 * @example
 *   const preview = await previewHealth(ctx, {
 *     symbol: 'SOL-PERP', side: 'long', baseSize: 0.5, leverage: 3, action: 'open',
 *   });
 *   // preview.projectedLiquidationPriceUsd, preview.liquidationBufferPct, preview.warnings, …
 */
export async function previewHealth(
  ctx: DAppAdapterContext,
  input: PhoenixHealthPreviewInput,
): Promise<PhoenixHealthPreviewResult> {
  const symbol = input.symbol.trim();
  if (!symbol) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'symbol is required for Phoenix health preview.');
  }
  const side = input.side === 'short' ? 'short' : 'long';
  const baseSize = parsePositiveNumber(input.baseSize, 'baseSize');
  const leverage = parsePositiveNumber(input.leverage, 'leverage');

  const walletAddress = (input.walletAddress?.trim()) || (await ctx.backend.getAddress());
  assertPubkey(walletAddress, 'walletAddress');

  const client = resolvePhoenixClient(ctx);
  await withPhoenixErrors('activateIfNeeded', () => client.activateIfNeeded(walletAddress));
  const [trader, market] = await Promise.all([
    withPhoenixErrors('fetchTraderState', () =>
      client.fetchTraderState({
        authority: walletAddress,
        traderPdaIndex: input.traderPdaIndex ?? PHOENIX_TRADER_PDA_INDEX_DEFAULT,
      }),
    ),
    withPhoenixErrors('fetchMarketSnapshot', () => client.fetchMarketSnapshot({ symbol })),
  ]);

  const markPriceStr = market.markPriceUsd;
  const markPrice = markPriceStr ? Number(markPriceStr) : undefined;
  const warnings: string[] = [];
  if (markPrice === undefined || !Number.isFinite(markPrice) || markPrice <= 0) {
    warnings.push('Phoenix market snapshot did not include a mark price; projected liquidation is omitted.');
  }

  const collateralKnown =
    trader.freeCollateralUsd !== undefined && Number.isFinite(Number(trader.freeCollateralUsd));
  const collateralUsd = collateralKnown ? Number(trader.freeCollateralUsd) : 0;
  if (!collateralKnown) {
    warnings.push('Phoenix trader state did not include freeCollateralUsd; projected margin ratio is omitted.');
  }

  const action = input.action ?? 'open';
  const existingRow = trader.positions.find((row) => row.symbol.toUpperCase() === symbol.toUpperCase());
  const existing =
    existingRow && existingRow.entryPriceUsd && Number(existingRow.entryPriceUsd) > 0
      ? {
          baseSize: Number(existingRow.baseSize),
          entryPriceUsd: Number(existingRow.entryPriceUsd),
          side: existingRow.side,
        }
      : undefined;

  let projectedLiquidationPriceUsd: string | undefined;
  let bufferPct: number | undefined;
  let marginRatio: number | undefined;
  let combineWarnings: string[] = [];

  if (markPrice !== undefined && Number.isFinite(markPrice) && markPrice > 0) {
    const projected = combinePosition({
      ...(existing !== undefined && { existing }),
      delta: { baseSize, side },
      action,
      markPriceUsd: markPrice,
    });
    combineWarnings = projected.warnings;

    if (projected.baseSize > 0) {
      const liq = projectLiquidationPriceUsd({
        side: projected.side,
        entryPriceUsd: projected.entryPriceUsd,
        leverage,
      });
      projectedLiquidationPriceUsd = liq.toFixed(6);
      bufferPct = liquidationBufferPct(markPrice, liq, projected.side);

      if (collateralKnown) {
        const projectedNotionalUsd = markPrice * projected.baseSize;
        marginRatio = projectMarginRatio({ collateralUsd, notionalUsd: projectedNotionalUsd / leverage });
      }
    } else if (action === 'close' || existing !== undefined) {
      // Position would be flat — no liq, no margin ratio.
      combineWarnings.push('Projected position is flat; liquidation price and margin ratio are not applicable.');
    }
  }

  const allWarnings = [...warnings, ...combineWarnings];

  return {
    walletAddress,
    symbol,
    side,
    leverage,
    baseSize: String(baseSize),
    ...(market.markPriceUsd !== undefined && { projectedMarkPriceUsd: market.markPriceUsd }),
    ...(projectedLiquidationPriceUsd !== undefined && { projectedLiquidationPriceUsd }),
    ...(marginRatio !== undefined && Number.isFinite(marginRatio) && { projectedMarginRatio: marginRatio }),
    ...(trader.freeCollateralUsd !== undefined && {
      projectedFreeCollateralUsd: trader.freeCollateralUsd,
    }),
    ...(bufferPct !== undefined && { liquidationBufferPct: bufferPct }),
    asOf: new Date().toISOString(),
    ...(allWarnings.length > 0 && { warnings: allWarnings }),
  };
}
