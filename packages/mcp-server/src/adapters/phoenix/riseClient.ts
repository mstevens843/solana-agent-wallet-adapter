/**
 * Rise SDK–backed `PhoenixClient` implementation.
 *
 * Wraps `@ellipsis-labs/rise@0.4.9`'s `createPhoenixClient(...)` and adapts:
 *   • Reads → existing `PhoenixClient` interface (typed normalization in `_riseNormalizers.ts`).
 *   • Writes → optional `build*Ixs(...)` methods returning kit Instructions (consumed by `actions.ts` +
 *     `instructionBridge.ts`).
 *
 * We import Rise at the top of this file but treat the runtime object surface as semi-opaque (`unknown`
 * via the `RiseClientLike` shape). This avoids leaking `@solana/kit`'s zod-4 schema branding into the
 * rest of the adapter, which still lives in the kit-2.3.0 world via Kamino.
 */

import { createPhoenixClient } from '@ellipsis-labs/rise';

import { AdapterError } from '../types.js';
import { PHOENIX_ADAPTER_ID, PHOENIX_DEFAULT_API_BASE_URL } from './constants.js';
import type {
  PhoenixClient,
  PhoenixFundingHistoryEntry,
  PhoenixMarketSnapshot,
  PhoenixOpenOrder,
  PhoenixPosition,
  PhoenixTraderStateSnapshot,
} from './client.js';
import { withPhoenixErrors } from './client.js';
import type { KitInstructionLike } from './instructionBridge.js';
import { instructionsFromRiseResult } from './instructionBridge.js';

// ---- Action-input shapes consumed by actions.ts (Rise-specific surface) ---------------------------------------------

export interface RiseOpenIxsInput {
  authority: string;
  symbol: string;
  /** 'long' → bid; 'short' → ask. */
  side: 'long' | 'short';
  /** Base units (e.g. 0.5 SOL = "0.5"). Rise's `buildMarketOrderPacket` accepts strings/numbers. */
  baseUnits: string;
  /** Optional price limit in USD. If omitted, the order is a pure market order. */
  priceLimitUsd?: string;
  /** Optional trader PDA index (default 0). */
  traderPdaIndex?: number;
}

export interface RiseCloseIxsInput {
  authority: string;
  symbol: string;
  /** Current position side. We invert it for the close. */
  currentSide: 'long' | 'short';
  /** Base units to close (defaults to current position size if unspecified — but caller should pass explicitly). */
  baseUnits: string;
  traderPdaIndex?: number;
}

export interface RiseCancelOrderIxsInput {
  authority: string;
  symbol: string;
  /**
   * Price in USD ticks. The cancel ix is keyed by (price, sequenceNumber). Rise's `buildCancelOrdersById` accepts
   * `number | bigint`; pass a bigint when in doubt to avoid float precision loss for large tick values.
   */
  priceTicks: number | bigint | string;
  orderSequenceNumber: string | number;
  traderPdaIndex?: number;
}

export interface RisePlaceTriggerIxsInput {
  authority: string;
  symbol: string;
  /** Stop-loss trigger price in USD ticks (use `usdToTickPrice` from sharedMath). */
  triggerPriceTicks: bigint;
  /** Optional execution price ticks; if omitted the trigger fires as IOC market. */
  executionPriceTicks?: bigint;
  /** The trade side that fires when triggered (opposite of the position we're protecting). */
  tradeSide: 'long' | 'short';
  /** When price moves in this direction (less = stop on drop, greater = stop on rise). */
  triggerDirection: 'less_than' | 'greater_than';
  /** 'ioc' (default) or 'limit'. Limit needs executionPriceTicks. */
  orderKind?: 'ioc' | 'limit';
  traderPdaIndex?: number;
}

export interface RiseModifyCollateralIxsInput {
  authority: string;
  /** 'deposit' adds collateral to the trader account; 'withdraw' pulls funds out. */
  direction: 'deposit' | 'withdraw';
  /** Amount in base units of USDC. Will be converted to lamports (6 decimals) before submission. */
  amountUsdc: string;
  traderPdaIndex?: number;
}

// ---- Extension to PhoenixClient — actions.ts checks for these at runtime --------------------------------------------

export interface PhoenixRiseExtensions {
  buildOpenIxs(input: RiseOpenIxsInput): Promise<KitInstructionLike[]>;
  buildCloseIxs(input: RiseCloseIxsInput): Promise<KitInstructionLike[]>;
  buildCancelOrderIxs(input: RiseCancelOrderIxsInput): Promise<KitInstructionLike[]>;
  buildPlaceTriggerIxs(input: RisePlaceTriggerIxsInput): Promise<KitInstructionLike[]>;
  buildModifyCollateralIxs(input: RiseModifyCollateralIxsInput): Promise<KitInstructionLike[]>;
  /** Release Rise resources (websocket connections, caches). Safe to call multiple times. */
  dispose(): void;
}

export type RisePhoenixClient = PhoenixClient & PhoenixRiseExtensions;

export function hasRiseExtensions(client: PhoenixClient): client is RisePhoenixClient {
  return typeof (client as Partial<PhoenixRiseExtensions>).buildOpenIxs === 'function';
}

// ---- Rise runtime types (duck-typed; avoids re-exporting zod-4 brands) ---------------------------------------------

interface RiseClientLike {
  api: {
    invite(): { activateInvite(req: { authority: string; code: string }): Promise<{ trader_pda: string }> };
    markets(): {
      getMarket(symbol: string): Promise<unknown>;
      getMarkets(): Promise<unknown[]>;
    };
    traders(): {
      getTraderState(authority: string, request?: { pdaIndex?: number }): Promise<unknown>;
    };
    funding(): {
      getFundingRateHistory(symbol: string, request?: { limit?: number }): Promise<unknown>;
    };
  };
  orderPackets: {
    buildMarketOrderPacket(params: {
      symbol: string;
      side: number;
      baseUnits: string;
      priceLimitUsd?: string | null;
    }): Promise<unknown>;
  };
  ixs: {
    placeMarketOrder(params: unknown): Promise<unknown>;
    buildCancelOrdersById(params: unknown): Promise<unknown>;
    buildPlaceStopLoss(params: unknown): Promise<unknown>;
    buildDepositIxs(params: unknown): Promise<unknown>;
    buildWithdrawIxs(params: unknown): Promise<unknown>;
  };
  dispose(): void;
}

// Rise's Side enum: 0 = Bid (buy), 1 = Ask (sell). Long → Bid, Short → Ask.
const SIDE_BID = 0;
const SIDE_ASK = 1;
const sideForLongShort = (s: 'long' | 'short'): number => (s === 'long' ? SIDE_BID : SIDE_ASK);
const inverseSide = (s: 'long' | 'short'): 'long' | 'short' => (s === 'long' ? 'short' : 'long');

// Rise's Direction enum (verified against @ellipsis-labs/rise dist/index.d.ts line 1307-1310):
//   Direction.GreaterThan = 0, Direction.LessThan = 1.
// StopLossOrderKind (line 1316-1319): IOC = 0, Limit = 1.
// IMPORTANT: do NOT flip these without updating the regression test in __tests__/adapters/phoenix/riseClient.test.ts
// (the test pins these constants against Rise's exported enum to catch silent re-inversion).
const DIRECTION_GREATER_THAN = 0;
const DIRECTION_LESS_THAN = 1;
const STOP_LOSS_IOC = 0;
const STOP_LOSS_LIMIT = 1;

const USDC_DECIMALS = 6;

// ---- Factory --------------------------------------------------------------------------------------------------------

export interface BuildRisePhoenixClientOptions {
  accessCode: string;
  apiUrl?: string;
  rpcUrl?: string;
}

/**
 * Build a Rise-backed `PhoenixClient`. The returned client is also a `RisePhoenixClient` (carries the
 * action-builder methods). Activation is lazy + idempotent — `activateIfNeeded` triggers it once per
 * (process, authority) and caches the success.
 */
export function buildRisePhoenixClient(options: BuildRisePhoenixClientOptions): RisePhoenixClient {
  if (!options.accessCode?.trim()) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'invalid_request',
      'buildRisePhoenixClient: accessCode is required.',
    );
  }

  const apiUrl = options.apiUrl?.trim() || PHOENIX_DEFAULT_API_BASE_URL;
  const rpcUrl = options.rpcUrl?.trim();

  // createPhoenixClient's config type is precise; we cast through `unknown` to ride the duck-typed surface.
  const rise = createPhoenixClient({
    apiUrl,
    apiKey: options.accessCode,
    ...(rpcUrl ? { rpcUrl } : {}),
    // Disable WS by default — adapter only uses HTTP today. Reduces resource use + zod-4 surface area.
    ws: false,
  } as unknown as Parameters<typeof createPhoenixClient>[0]) as unknown as RiseClientLike;

  const activatedAuthorities = new Set<string>();
  const accessCode = options.accessCode;

  /**
   * Closure over the BYO access code. Forwards to `withPhoenixErrors` so any error message thrown by Rise (e.g. an
   * HTTP body that includes the access code in a URL or header) gets the BYO code scrubbed alongside the env code.
   */
  const wrapErrors = <T>(method: string, fn: () => Promise<T>): Promise<T> =>
    withPhoenixErrors(method, fn, [accessCode]);

  const activate = async (authority: string): Promise<{ activatedAt: string }> => {
    return wrapErrors('activate', async () => {
      await rise.api.invite().activateInvite({ authority, code: accessCode });
      activatedAuthorities.add(authority);
      return { activatedAt: new Date().toISOString() };
    });
  };

  const activateIfNeeded = async (authority: string): Promise<void> => {
    if (activatedAuthorities.has(authority)) return;
    try {
      await activate(authority);
    } catch (err) {
      // If Rise responds "already activated", treat as success. Anything else surfaces normally.
      const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      if (message.includes('already') || message.includes('whitelist')) {
        activatedAuthorities.add(authority);
        return;
      }
      throw err;
    }
  };

  return {
    // --- reads -------------------------------------------------------------------------------------------------------

    async activate(input) {
      return activate(input.authority);
    },

    async activateIfNeeded(authority) {
      await activateIfNeeded(authority);
    },

    async fetchMarketSnapshot({ symbol }) {
      return wrapErrors('fetchMarketSnapshot', async () => {
        const raw = await rise.api.markets().getMarket(symbol);
        return normalizeMarket(raw);
      });
    },

    async fetchMarketCatalog() {
      return wrapErrors('fetchMarketCatalog', async () => {
        const raw = await rise.api.markets().getMarkets();
        return raw.map(normalizeMarket);
      });
    },

    async fetchTraderState({ authority, traderPdaIndex }) {
      return wrapErrors('fetchTraderState', async () => {
        await activateIfNeeded(authority);
        const request = traderPdaIndex !== undefined ? { pdaIndex: traderPdaIndex } : undefined;
        const raw = await rise.api.traders().getTraderState(authority, request);
        return normalizeTraderState(raw, authority, traderPdaIndex);
      });
    },

    async fetchFundingHistory({ symbol, limit }) {
      return wrapErrors('fetchFundingHistory', async () => {
        const request = limit !== undefined ? { limit } : undefined;
        const raw = await rise.api.funding().getFundingRateHistory(symbol, request);
        return normalizeFundingHistory(raw, symbol);
      });
    },

    // --- writes ------------------------------------------------------------------------------------------------------

    async buildOpenIxs(input) {
      return wrapErrors('buildOpenIxs', async () => {
        await activateIfNeeded(input.authority);
        const packet = await rise.orderPackets.buildMarketOrderPacket({
          symbol: input.symbol,
          side: sideForLongShort(input.side),
          baseUnits: input.baseUnits,
          ...(input.priceLimitUsd ? { priceLimitUsd: input.priceLimitUsd } : {}),
        });
        const result = await rise.ixs.placeMarketOrder({
          authority: input.authority,
          symbol: input.symbol,
          orderPacket: packet,
          ...(input.traderPdaIndex !== undefined ? { traderPdaIndex: input.traderPdaIndex } : {}),
        });
        return instructionsFromRiseResult(result);
      });
    },

    async buildCloseIxs(input) {
      return wrapErrors('buildCloseIxs', async () => {
        await activateIfNeeded(input.authority);
        const closeSide = inverseSide(input.currentSide);
        const packet = await rise.orderPackets.buildMarketOrderPacket({
          symbol: input.symbol,
          side: sideForLongShort(closeSide),
          baseUnits: input.baseUnits,
        });
        const result = await rise.ixs.placeMarketOrder({
          authority: input.authority,
          symbol: input.symbol,
          orderPacket: packet,
          ...(input.traderPdaIndex !== undefined ? { traderPdaIndex: input.traderPdaIndex } : {}),
        });
        return instructionsFromRiseResult(result);
      });
    },

    async buildCancelOrderIxs(input) {
      return wrapErrors('buildCancelOrderIxs', async () => {
        await activateIfNeeded(input.authority);
        // Rise's `buildCancelOrdersById` accepts `number | bigint`. Coerce strings to bigint to preserve
        // precision for large tick values (>2^53) and to satisfy Rise's runtime type narrowing.
        const price =
          typeof input.priceTicks === 'string' ? BigInt(input.priceTicks) : input.priceTicks;
        const result = await rise.ixs.buildCancelOrdersById({
          authority: input.authority,
          symbol: input.symbol,
          orders: [{ price, orderSequenceNumber: input.orderSequenceNumber }],
          ...(input.traderPdaIndex !== undefined ? { traderPdaIndex: input.traderPdaIndex } : {}),
        });
        return instructionsFromRiseResult(result);
      });
    },

    async buildPlaceTriggerIxs(input) {
      return wrapErrors('buildPlaceTriggerIxs', async () => {
        await activateIfNeeded(input.authority);
        const orderKind = input.orderKind === 'limit' ? STOP_LOSS_LIMIT : STOP_LOSS_IOC;
        if (orderKind === STOP_LOSS_LIMIT && input.executionPriceTicks === undefined) {
          throw new AdapterError(
            PHOENIX_ADAPTER_ID,
            'invalid_request',
            'buildPlaceTriggerIxs: limit orderKind requires executionPriceTicks.',
          );
        }
        const result = await rise.ixs.buildPlaceStopLoss({
          authority: input.authority,
          symbol: input.symbol,
          triggerPrice: input.triggerPriceTicks,
          ...(input.executionPriceTicks !== undefined ? { executionPrice: input.executionPriceTicks } : {}),
          tradeSide: sideForLongShort(input.tradeSide),
          executionDirection:
            input.triggerDirection === 'less_than' ? DIRECTION_LESS_THAN : DIRECTION_GREATER_THAN,
          orderKind,
          ...(input.traderPdaIndex !== undefined ? { traderPdaIndex: input.traderPdaIndex } : {}),
        });
        return instructionsFromRiseResult(result);
      });
    },

    async buildModifyCollateralIxs(input) {
      return wrapErrors('buildModifyCollateralIxs', async () => {
        await activateIfNeeded(input.authority);
        const lamports = usdcToLamports(input.amountUsdc);
        const params = {
          authority: input.authority,
          amount: lamports,
          ...(input.traderPdaIndex !== undefined ? { traderPdaIndex: input.traderPdaIndex } : {}),
        };
        const result =
          input.direction === 'deposit'
            ? await rise.ixs.buildDepositIxs(params)
            : await rise.ixs.buildWithdrawIxs(params);
        return instructionsFromRiseResult(result);
      });
    },

    dispose() {
      rise.dispose();
      activatedAuthorities.clear();
    },
  };
}

// ---- Helpers (exported for unit testing) ---------------------------------------------------------------------------

/** Rise enum constants exposed for regression tests pinning them to the SDK's actual exports. */
export const RISE_ENUM_CONSTANTS = {
  SIDE_BID,
  SIDE_ASK,
  DIRECTION_GREATER_THAN,
  DIRECTION_LESS_THAN,
  STOP_LOSS_IOC,
  STOP_LOSS_LIMIT,
} as const;

/**
 * Convert a positive USDC amount string (e.g. "1.5") to bigint lamports (6 decimals). Throws on:
 *  - Non-numeric input (alphabetic, scientific notation, multiple decimal points).
 *  - Negative input — Phoenix collateral operations always use positive amounts; direction is a separate flag.
 *
 * The fractional part is truncated (not rounded) past 6 decimals — operators should not rely on precision beyond
 * USDC's native resolution.
 */
export function usdcToLamports(amount: string): bigint {
  const trimmed = amount.trim();
  // Reject negative explicitly: collateral amounts are always positive, direction lives in input.direction.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'invalid_request',
      `usdcToLamports: invalid amount '${amount}' (expected positive decimal string)`,
    );
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole!) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded);
}

// ---- Normalizers ----------------------------------------------------------------------------------------------------

interface RiseMarketLike {
  symbol?: string;
  marketStatus?: string;
  tickSize?: number;
  baseLotsDecimals?: number;
  takerFee?: number;
  makerFee?: number;
  leverageTiers?: Array<{ maxLeverage?: number }>;
}

export function normalizeMarket(raw: unknown): PhoenixMarketSnapshot {
  const m = (raw ?? {}) as RiseMarketLike;
  const maxLeverage =
    m.leverageTiers && m.leverageTiers.length > 0
      ? Math.max(...m.leverageTiers.map((t) => t.maxLeverage ?? 0))
      : undefined;
  return {
    symbol: m.symbol ?? 'unknown',
    ...(maxLeverage !== undefined ? { maxLeverage } : {}),
    ...(m.takerFee !== undefined ? { takerFeeBps: feeToBps(m.takerFee) } : {}),
    ...(m.makerFee !== undefined ? { makerFeeBps: feeToBps(m.makerFee) } : {}),
    asOf: new Date().toISOString(),
  };
}

/**
 * Convert Rise's fee representation to integer bps.
 *
 * Rise's `ExchangeMarketConfig.takerFee` / `makerFee` are expressed as decimal fractions (e.g. `0.0005` = 5 bps).
 * This was verified by inspecting the v0.4.9 d.ts (`number` field with no units documented) and confirmed against
 * Phoenix's documented fee tier (5 bps taker, 1 bps maker). If the API changes units in a future Rise release,
 * this conversion will silently produce wrong values — covered by a regression test that pins a known input.
 */
export function feeToBps(fee: number): number {
  return Math.round(fee * 10_000);
}

interface RiseTraderViewLike {
  collateralBalance?: { amount?: string };
  effectiveCollateral?: { amount?: string };
  positions?: Array<{
    symbol?: string;
    side?: string;
    baseLots?: string;
    entryPrice?: { amount?: string };
    markPrice?: { amount?: string };
    leverage?: string;
    liquidationPrice?: { amount?: string };
    unrealizedPnl?: { amount?: string };
  }>;
  limitOrders?: Record<string, Array<{ orderSequenceNumber?: string; side?: string; baseLots?: string; price?: string }>>;
}

interface RiseTraderStateResponseLike {
  authority?: string;
  pdaIndex?: number;
  traders?: RiseTraderViewLike[];
}

export function normalizeTraderState(
  raw: unknown,
  authority: string,
  traderPdaIndex?: number,
): PhoenixTraderStateSnapshot {
  const response = (raw ?? {}) as RiseTraderStateResponseLike;
  const trader = response.traders?.[0];
  const positions: PhoenixPosition[] = (trader?.positions ?? [])
    .filter((p) => p.symbol && p.baseLots)
    .map((p) => ({
      symbol: p.symbol!,
      side: (p.side === 'short' ? 'short' : 'long') as 'long' | 'short',
      baseSize: p.baseLots ?? '0',
      ...(p.entryPrice?.amount !== undefined ? { entryPriceUsd: p.entryPrice.amount } : {}),
      ...(p.markPrice?.amount !== undefined ? { markPriceUsd: p.markPrice.amount } : {}),
      ...(p.leverage !== undefined ? { leverage: p.leverage } : {}),
      ...(p.liquidationPrice?.amount !== undefined ? { liquidationPriceUsd: p.liquidationPrice.amount } : {}),
      ...(p.unrealizedPnl?.amount !== undefined ? { unrealizedPnlUsd: p.unrealizedPnl.amount } : {}),
    }));

  const openOrders: PhoenixOpenOrder[] = [];
  if (trader?.limitOrders) {
    for (const [symbol, orders] of Object.entries(trader.limitOrders)) {
      for (const o of orders) {
        if (!o.orderSequenceNumber) continue;
        openOrders.push({
          orderId: o.orderSequenceNumber,
          symbol,
          side: (o.side === 'ask' || o.side === 'short' ? 'short' : 'long') as 'long' | 'short',
          type: 'limit',
          baseSize: o.baseLots ?? '0',
        });
      }
    }
  }

  return {
    authority: response.authority ?? authority,
    traderPdaIndex: response.pdaIndex ?? traderPdaIndex ?? 0,
    ...(trader?.effectiveCollateral?.amount !== undefined
      ? { freeCollateralUsd: trader.effectiveCollateral.amount }
      : {}),
    ...(trader?.collateralBalance?.amount !== undefined
      ? { totalCollateralUsd: trader.collateralBalance.amount }
      : {}),
    positions,
    openOrders,
    triggers: [],
    asOf: new Date().toISOString(),
  };
}

interface RiseFundingHistoryLike {
  rates?: Array<{ timestamp?: number; fundingRatePercentage?: string }>;
}

/**
 * Normalize Rise's `FundingRateHistoryResponse.rates[]` to our `PhoenixFundingHistoryEntry`.
 *
 * Rise's `FundingRatePoint.timestamp: number` is in **seconds** (Unix epoch). Confirmed by inspecting Phoenix's HTTP
 * API responses where funding rate timestamps align with hourly funding intervals expressed in seconds (e.g.
 * 1731000000 = 2024-11-07T17:20:00Z). If Rise switches to ms in a future release, the multiplier below produces
 * timestamps in year 56000+ — covered by a regression test asserting reasonable years for a known input.
 */
export function normalizeFundingHistory(raw: unknown, symbol: string): PhoenixFundingHistoryEntry[] {
  const response = (raw ?? {}) as RiseFundingHistoryLike;
  return (response.rates ?? [])
    .filter((p) => p.timestamp !== undefined && p.fundingRatePercentage !== undefined)
    .map((p) => ({
      symbol,
      rateHourly: p.fundingRatePercentage ?? '0',
      observedAt: new Date(p.timestamp! * 1000).toISOString(),
    }));
}
