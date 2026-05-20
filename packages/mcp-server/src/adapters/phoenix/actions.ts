import {
  AdapterError,
  type AdapterAction,
  type AdapterExecuteResult,
  type AdapterPrepareResult,
  type DAppAdapterContext,
} from '../types.js';
import type { AgentWalletConfig } from '../../config.js';
import { getPhoenixPerpsPolicy } from '../../config.js';
import type { AddPreparedActionInput, PreparedAction } from '../../preparedActions.js';
import { PHOENIX_ADAPTER_ID } from './constants.js';
import { resolvePhoenixClient } from './client.js';
import {
  buildPhoenixTransactionBase64,
  type KitInstructionLike,
} from './instructionBridge.js';
import { hasRiseExtensions, type RisePhoenixClient } from './riseClient.js';
import { usdToTickPrice } from './sharedMath.js';

// ---- Input shapes ---------------------------------------------------------------------------------------------------

/**
 * Common audit/scheduling fields shared by all Phoenix prepare inputs. Mirrors the Tensor / MagicEden pattern so
 * the Spend UI can apply approval deadlines and audit memos uniformly.
 */
interface PhoenixCommonPrepareInput {
  walletAddress?: string;
  /** Execution mode. Must be 'paper' when policy.paperModeOnly is true. */
  mode?: 'live' | 'paper';
  /** Phoenix trader PDA index for multi-subaccount users. Defaults to 0. */
  traderPdaIndex?: number;
  /** Optional approval deadline (ISO 8601). Used by the prepared-action UI. */
  dueAt?: string;
  /** Optional free-form audit memo (≤500 chars). */
  note?: string;
}

export interface PhoenixOpenInput extends PhoenixCommonPrepareInput {
  symbol: string;
  side: 'long' | 'short';
  baseSize: string;
  leverage: number;
  /**
   * Optional USD price ceiling (long) or floor (short) for slippage protection. When omitted, the order is a pure
   * market order with no slippage cap — risky for leveraged opens. Strongly recommended for live mode.
   */
  priceLimitUsd?: string;
}

export interface PhoenixCloseInput extends PhoenixCommonPrepareInput {
  symbol: string;
  reduceOnly?: boolean;
  /** Optional partial-close size. If omitted, closes the full position discovered at prepare time. */
  baseSize?: string;
}

export interface PhoenixModifyCollateralInput extends PhoenixCommonPrepareInput {
  direction: 'deposit' | 'withdraw';
  amountUsd: string;
}

export interface PhoenixPlaceTriggerInput extends PhoenixCommonPrepareInput {
  symbol: string;
  side: 'long' | 'short';
  baseSize: string;
  triggerPriceUsd: string;
  triggerDirection: 'less_than' | 'greater_than';
}

export interface PhoenixCancelOrderInput extends PhoenixCommonPrepareInput {
  /** Phoenix order sequence number (from `wallet_positions` → openOrders[i].orderId). */
  orderId: string;
  /** Symbol the order lives on — required to address the right market. */
  symbol: string;
  /** Order's price in Phoenix ticks (see `usdToTickPrice` from `sharedMath`). */
  priceTicks: string;
}

const RISE_SDK_NOT_AVAILABLE_REASON =
  'Phoenix action building requires the Rise SDK. Resolved client did not expose Rise extensions; ensure a Phoenix access code is configured and PHOENIX_USE_LEGACY_HTTP is not set.';

export interface PhoenixPolicyCheckInput {
  symbol?: string;
  leverage?: number;
  notionalUsd?: number;
  liquidationBufferPct?: number;
  /** Per-request execution mode. Enforced against policy.paperModeOnly. */
  mode?: 'live' | 'paper';
}

/**
 * Reject a prepare action that violates the active Phoenix policy. Pulls thresholds via `getPhoenixPerpsPolicy`;
 * called from every Phoenix action prepare() before any SDK or RPC interaction. Also re-invoked at execute() so
 * a paper-mode action prepared before a policy flip cannot leak through as live.
 */
export function assertPhoenixPolicyAllowed(config: AgentWalletConfig, input: PhoenixPolicyCheckInput): void {
  const policy = getPhoenixPerpsPolicy(config);
  if (!policy.enabled) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'connector_disabled',
      'Phoenix Perpetuals is disabled by policy. Enable it via config.connectors.phoenix.perps.enabled.',
    );
  }
  if (policy.readOnly) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'read_only_policy',
      'Phoenix Perpetuals policy is read-only. Disable readOnly to prepare write actions.',
    );
  }
  if (input.symbol && policy.allowedSymbols.length > 0 && !policy.allowedSymbols.includes(input.symbol)) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'disallowed_symbol',
      `Symbol ${input.symbol} is not in the Phoenix policy allowlist (${policy.allowedSymbols.join(', ')}).`,
    );
  }
  if (input.leverage !== undefined && input.leverage > policy.maxLeverage) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'leverage_exceeded',
      `Requested leverage ${input.leverage}x exceeds Phoenix policy max ${policy.maxLeverage}x.`,
    );
  }
  if (input.notionalUsd !== undefined && input.notionalUsd > policy.maxNotionalUsd) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'notional_exceeded',
      `Requested notional $${input.notionalUsd} exceeds Phoenix policy max $${policy.maxNotionalUsd}.`,
    );
  }
  if (
    input.liquidationBufferPct !== undefined &&
    Number.isFinite(input.liquidationBufferPct) &&
    input.liquidationBufferPct < policy.minLiquidationBufferPct
  ) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'liquidation_buffer_insufficient',
      `Liquidation buffer ${input.liquidationBufferPct.toFixed(2)}% is below policy minimum ${policy.minLiquidationBufferPct}%.`,
    );
  }
  if (policy.paperModeOnly && input.mode !== 'paper') {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'paper_mode_required',
      'Phoenix policy is paper-mode-only. Pass mode: "paper" in the prepare action, or flip config.connectors.phoenix.perps.paperModeOnly to false after a paper-mode soak completes.',
    );
  }
}

// ---- Shared helpers --------------------------------------------------------------------------------------------------

/** Resolve a Rise-backed client or throw a clear `unsupported_method` error. */
function requireRiseClient(ctx: DAppAdapterContext): RisePhoenixClient {
  const client = resolvePhoenixClient(ctx);
  if (!hasRiseExtensions(client)) {
    throw new AdapterError(PHOENIX_ADAPTER_ID, 'unsupported_method', RISE_SDK_NOT_AVAILABLE_REASON);
  }
  return client;
}

/** Assemble + base64-encode a Phoenix tx from a kit instruction list. */
async function buildTxFromIxs(
  ixs: KitInstructionLike[],
  authority: string,
  ctx: DAppAdapterContext,
): Promise<string> {
  return buildPhoenixTransactionBase64(ixs, authority, ctx.connection);
}

/** Uppercase symbol normalization. Phoenix symbols are conventionally uppercase ("SOL-PERP"). */
function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Best-effort mark-price lookup used to enrich summary text with USD notional. Returns `undefined` on any failure
 * (network glitch, missing market, etc.) — summaries should degrade gracefully rather than fail prepare.
 */
async function tryFetchMarkUsd(client: RisePhoenixClient, symbol: string): Promise<number | undefined> {
  try {
    const market = await client.fetchMarketSnapshot({ symbol });
    const mark = market.markPriceUsd !== undefined ? Number(market.markPriceUsd) : undefined;
    return Number.isFinite(mark) && mark! > 0 ? mark : undefined;
  } catch {
    return undefined;
  }
}

/** Format USD amount with thousands separators and 2-decimal precision: 1234.56 → "$1,234.56". */
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Execute-time guards run for every Phoenix execute(). Catches:
 *  1. Wallet mismatch: the connected wallet differs from the prepared-action's wallet → reject as `unauthorized`.
 *  2. Stale policy: a paper-mode action sitting in queue when policy.paperModeOnly flipped → reject as `paper_mode_required`.
 *  3. Symbol/policy drift: the symbol was removed from policy.allowedSymbols since prepare → reject as `disallowed_symbol`.
 *
 * Returns the resolved wallet address so callers don't re-derive it.
 */
async function assertExecuteWalletAndPolicy(
  action: PreparedAction,
  ctx: DAppAdapterContext,
  policyInput: PhoenixPolicyCheckInput = {},
): Promise<string> {
  const currentWallet = await ctx.backend.getAddress();
  const expectedWallet = (action.params.walletAddress as string | undefined) ?? action.walletAddress;
  if (currentWallet !== expectedWallet) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'unauthorized',
      `Phoenix ${action.kind} was prepared for ${expectedWallet}, but the connected wallet is ${currentWallet}.`,
    );
  }
  // Re-validate policy using mode stored at prepare time. If the operator flipped paperModeOnly after prepare,
  // a stored 'live' action stays live (which the policy may now allow or reject); a stored 'paper' action stays paper.
  const storedMode = action.params.mode as 'live' | 'paper' | undefined;
  assertPhoenixPolicyAllowed(ctx.config, {
    ...policyInput,
    ...(storedMode !== undefined && { mode: storedMode }),
  });
  return currentWallet;
}

/**
 * Construct the AddPreparedActionInput envelope shared by every prepare(). Centralizes `dueAt` / `note` propagation
 * so all 5 actions stay consistent with the Tensor / MagicEden contract.
 */
function buildPreparedActionInput(
  kind: PreparedAction['kind'],
  walletAddress: string,
  cluster: AgentWalletConfig['cluster'],
  summary: string,
  params: Record<string, unknown>,
  input: PhoenixCommonPrepareInput,
): AddPreparedActionInput {
  return {
    kind,
    walletAddress,
    cluster,
    summary,
    params,
    ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
    ...(input.note !== undefined && { note: input.note }),
  };
}

// ---- phoenix_open --------------------------------------------------------------------------------------------------

export const phoenixOpenAction: AdapterAction<PhoenixOpenInput> = {
  id: 'phoenix_open',
  kind: 'phoenix_open',
  async prepare(input: PhoenixOpenInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult> {
    const symbol = normalizeSymbol(input.symbol);
    const baseSizeNum = Number(input.baseSize);
    assertPhoenixPolicyAllowed(ctx.config, {
      symbol,
      leverage: input.leverage,
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(Number.isFinite(baseSizeNum) && baseSizeNum > 0 ? { notionalUsd: baseSizeNum * input.leverage } : {}),
    });
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const client = requireRiseClient(ctx);
    // Best-effort mark fetch to enrich the summary with USD notional. Always non-blocking.
    const markUsd = await tryFetchMarkUsd(client, symbol);
    const ixs = await client.buildOpenIxs({
      authority: walletAddress,
      symbol,
      side: input.side,
      baseUnits: input.baseSize,
      ...(input.priceLimitUsd !== undefined && { priceLimitUsd: input.priceLimitUsd }),
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
    });
    const transactionBase64 = await buildTxFromIxs(ixs, walletAddress, ctx);
    const summary = formatOpenSummary(input, symbol, markUsd);
    const params: Record<string, unknown> = {
      adapter: PHOENIX_ADAPTER_ID,
      connectorId: PHOENIX_ADAPTER_ID,
      action: 'open',
      walletAddress,
      symbol,
      side: input.side,
      baseSize: input.baseSize,
      leverage: input.leverage,
      mode: input.mode ?? 'live',
      ...(input.priceLimitUsd !== undefined && { priceLimitUsd: input.priceLimitUsd }),
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
      transactionBase64,
      refreshAtExecution: true,
      preparedAt: new Date().toISOString(),
    };
    return {
      addInput: buildPreparedActionInput('phoenix_open', walletAddress, ctx.config.cluster, summary, params, input),
      preview: params,
    };
  },
  async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
    const params = action.params as {
      symbol?: string;
      side?: 'long' | 'short';
      baseSize?: string;
      priceLimitUsd?: string;
      traderPdaIndex?: number;
    };
    if (!params.symbol || !params.side || !params.baseSize) {
      throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'phoenix_open: missing symbol/side/baseSize in params.');
    }
    const walletAddress = await assertExecuteWalletAndPolicy(action, ctx, { symbol: params.symbol });
    const client = requireRiseClient(ctx);
    // Rebuild for a fresh blockhash — stored txBase64 may have expired between prepare and execute.
    const ixs = await client.buildOpenIxs({
      authority: walletAddress,
      symbol: params.symbol,
      side: params.side,
      baseUnits: params.baseSize,
      ...(params.priceLimitUsd !== undefined && { priceLimitUsd: params.priceLimitUsd }),
      ...(params.traderPdaIndex !== undefined && { traderPdaIndex: params.traderPdaIndex }),
    });
    const tx = await buildTxFromIxs(ixs, walletAddress, ctx);
    const txid = await ctx.signAndBroadcast(tx, action.summary);
    return { txid, signedAt: new Date().toISOString() };
  },
};

// ---- phoenix_close -------------------------------------------------------------------------------------------------

export const phoenixCloseAction: AdapterAction<PhoenixCloseInput> = {
  id: 'phoenix_close',
  kind: 'phoenix_close',
  async prepare(input: PhoenixCloseInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult> {
    const symbol = normalizeSymbol(input.symbol);
    assertPhoenixPolicyAllowed(ctx.config, {
      symbol,
      ...(input.mode !== undefined && { mode: input.mode }),
    });
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const client = requireRiseClient(ctx);
    const position = await findPositionOrThrow(client, walletAddress, symbol, input.traderPdaIndex);
    const baseSize = input.baseSize?.trim() || position.baseSize;
    const markUsd = await tryFetchMarkUsd(client, symbol);
    const ixs = await client.buildCloseIxs({
      authority: walletAddress,
      symbol,
      currentSide: position.side,
      baseUnits: baseSize,
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
    });
    const transactionBase64 = await buildTxFromIxs(ixs, walletAddress, ctx);
    const notional =
      markUsd !== undefined ? ` (~${formatUsd(Number(baseSize) * markUsd)} notional)` : '';
    const summary = `Close ${position.side} ${baseSize} ${symbol}${notional}`;
    const params: Record<string, unknown> = {
      adapter: PHOENIX_ADAPTER_ID,
      connectorId: PHOENIX_ADAPTER_ID,
      action: 'close',
      walletAddress,
      symbol,
      currentSide: position.side,
      baseSize,
      reduceOnly: input.reduceOnly ?? true,
      mode: input.mode ?? 'live',
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
      transactionBase64,
      refreshAtExecution: true,
      preparedAt: new Date().toISOString(),
    };
    return {
      addInput: buildPreparedActionInput('phoenix_close', walletAddress, ctx.config.cluster, summary, params, input),
      preview: params,
    };
  },
  async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
    const params = action.params as {
      symbol?: string;
      baseSize?: string;
      traderPdaIndex?: number;
    };
    if (!params.symbol) {
      throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'phoenix_close: missing symbol in params.');
    }
    const walletAddress = await assertExecuteWalletAndPolicy(action, ctx, { symbol: params.symbol });
    const client = requireRiseClient(ctx);
    // Re-fetch position — it may have partially filled or liquidated between prepare and execute.
    const position = await findPositionOrThrow(client, walletAddress, params.symbol, params.traderPdaIndex);
    // Use stored baseSize as a CAP, not as the truth. If the live position is smaller, close only what exists.
    const storedSize = params.baseSize ? Number(params.baseSize) : Number.POSITIVE_INFINITY;
    const liveSize = Number(position.baseSize);
    const baseSize = Number.isFinite(storedSize) && storedSize < liveSize
      ? params.baseSize!
      : position.baseSize;
    const ixs = await client.buildCloseIxs({
      authority: walletAddress,
      symbol: params.symbol,
      currentSide: position.side,
      baseUnits: baseSize,
      ...(params.traderPdaIndex !== undefined && { traderPdaIndex: params.traderPdaIndex }),
    });
    const tx = await buildTxFromIxs(ixs, walletAddress, ctx);
    const txid = await ctx.signAndBroadcast(tx, action.summary);
    return { txid, signedAt: new Date().toISOString() };
  },
};

async function findPositionOrThrow(
  client: RisePhoenixClient,
  walletAddress: string,
  symbol: string,
  traderPdaIndex?: number,
): Promise<{ side: 'long' | 'short'; baseSize: string }> {
  const traderState = await client.fetchTraderState({
    authority: walletAddress,
    ...(traderPdaIndex !== undefined && { traderPdaIndex }),
  });
  const position = traderState.positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
  if (!position) {
    throw new AdapterError(
      PHOENIX_ADAPTER_ID,
      'no_open_position',
      `phoenix_close: no open ${symbol} position for ${walletAddress}.`,
    );
  }
  return { side: position.side, baseSize: position.baseSize };
}

// ---- phoenix_modify_collateral -------------------------------------------------------------------------------------

export const phoenixModifyCollateralAction: AdapterAction<PhoenixModifyCollateralInput> = {
  id: 'phoenix_modify_collateral',
  kind: 'phoenix_modify_collateral',
  async prepare(input: PhoenixModifyCollateralInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult> {
    assertPhoenixPolicyAllowed(ctx.config, {
      ...(input.mode !== undefined && { mode: input.mode }),
    });
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const client = requireRiseClient(ctx);
    const ixs = await client.buildModifyCollateralIxs({
      authority: walletAddress,
      direction: input.direction,
      amountUsdc: input.amountUsd,
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
    });
    const transactionBase64 = await buildTxFromIxs(ixs, walletAddress, ctx);
    const summary = `${input.direction === 'deposit' ? 'Deposit' : 'Withdraw'} ${input.amountUsd} USDC`;
    const params: Record<string, unknown> = {
      adapter: PHOENIX_ADAPTER_ID,
      connectorId: PHOENIX_ADAPTER_ID,
      action: 'modify_collateral',
      walletAddress,
      direction: input.direction,
      amountUsd: input.amountUsd,
      mode: input.mode ?? 'live',
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
      transactionBase64,
      refreshAtExecution: true,
      preparedAt: new Date().toISOString(),
    };
    return {
      addInput: buildPreparedActionInput('phoenix_modify_collateral', walletAddress, ctx.config.cluster, summary, params, input),
      preview: params,
    };
  },
  async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
    const params = action.params as {
      direction?: 'deposit' | 'withdraw';
      amountUsd?: string;
      traderPdaIndex?: number;
    };
    if (!params.direction || !params.amountUsd) {
      throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'phoenix_modify_collateral: missing direction/amountUsd in params.');
    }
    const walletAddress = await assertExecuteWalletAndPolicy(action, ctx);
    const client = requireRiseClient(ctx);
    const ixs = await client.buildModifyCollateralIxs({
      authority: walletAddress,
      direction: params.direction,
      amountUsdc: params.amountUsd,
      ...(params.traderPdaIndex !== undefined && { traderPdaIndex: params.traderPdaIndex }),
    });
    const tx = await buildTxFromIxs(ixs, walletAddress, ctx);
    const txid = await ctx.signAndBroadcast(tx, action.summary);
    return { txid, signedAt: new Date().toISOString() };
  },
};

// ---- phoenix_place_trigger -----------------------------------------------------------------------------------------

export const phoenixPlaceTriggerAction: AdapterAction<PhoenixPlaceTriggerInput> = {
  id: 'phoenix_place_trigger',
  kind: 'phoenix_place_trigger',
  async prepare(input: PhoenixPlaceTriggerInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult> {
    const symbol = normalizeSymbol(input.symbol);
    assertPhoenixPolicyAllowed(ctx.config, {
      symbol,
      ...(input.mode !== undefined && { mode: input.mode }),
    });
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const client = requireRiseClient(ctx);
    const triggerPriceTicks = usdToTickPrice(input.triggerPriceUsd);
    const ixs = await client.buildPlaceTriggerIxs({
      authority: walletAddress,
      symbol,
      triggerPriceTicks,
      tradeSide: input.side,
      triggerDirection: input.triggerDirection,
      orderKind: 'ioc',
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
    });
    const transactionBase64 = await buildTxFromIxs(ixs, walletAddress, ctx);
    const directionWord = input.triggerDirection === 'less_than' ? 'drops below' : 'rises above';
    const summary = `Stop-loss ${input.side} ${input.baseSize} ${symbol} if price ${directionWord} $${input.triggerPriceUsd}`;
    const params: Record<string, unknown> = {
      adapter: PHOENIX_ADAPTER_ID,
      connectorId: PHOENIX_ADAPTER_ID,
      action: 'place_trigger',
      walletAddress,
      symbol,
      side: input.side,
      baseSize: input.baseSize,
      triggerPriceUsd: input.triggerPriceUsd,
      triggerPriceTicks: triggerPriceTicks.toString(),
      triggerDirection: input.triggerDirection,
      mode: input.mode ?? 'live',
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
      transactionBase64,
      refreshAtExecution: true,
      preparedAt: new Date().toISOString(),
    };
    return {
      addInput: buildPreparedActionInput('phoenix_place_trigger', walletAddress, ctx.config.cluster, summary, params, input),
      preview: params,
    };
  },
  async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
    const params = action.params as {
      symbol?: string;
      side?: 'long' | 'short';
      triggerPriceTicks?: string;
      triggerDirection?: 'less_than' | 'greater_than';
      traderPdaIndex?: number;
    };
    if (!params.symbol || !params.side || !params.triggerPriceTicks || !params.triggerDirection) {
      throw new AdapterError(
        PHOENIX_ADAPTER_ID,
        'invalid_request',
        'phoenix_place_trigger: missing symbol/side/triggerPriceTicks/triggerDirection in params.',
      );
    }
    const walletAddress = await assertExecuteWalletAndPolicy(action, ctx, { symbol: params.symbol });
    const client = requireRiseClient(ctx);
    const ixs = await client.buildPlaceTriggerIxs({
      authority: walletAddress,
      symbol: params.symbol,
      triggerPriceTicks: BigInt(params.triggerPriceTicks),
      tradeSide: params.side,
      triggerDirection: params.triggerDirection,
      orderKind: 'ioc',
      ...(params.traderPdaIndex !== undefined && { traderPdaIndex: params.traderPdaIndex }),
    });
    const tx = await buildTxFromIxs(ixs, walletAddress, ctx);
    const txid = await ctx.signAndBroadcast(tx, action.summary);
    return { txid, signedAt: new Date().toISOString() };
  },
};

// ---- phoenix_cancel_order ------------------------------------------------------------------------------------------

export const phoenixCancelOrderAction: AdapterAction<PhoenixCancelOrderInput> = {
  id: 'phoenix_cancel_order',
  kind: 'phoenix_cancel_order',
  async prepare(input: PhoenixCancelOrderInput, ctx: DAppAdapterContext): Promise<AdapterPrepareResult> {
    const symbol = normalizeSymbol(input.symbol);
    assertPhoenixPolicyAllowed(ctx.config, {
      symbol,
      ...(input.mode !== undefined && { mode: input.mode }),
    });
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const client = requireRiseClient(ctx);
    const ixs = await client.buildCancelOrderIxs({
      authority: walletAddress,
      symbol,
      priceTicks: BigInt(input.priceTicks),
      orderSequenceNumber: input.orderId,
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
    });
    const transactionBase64 = await buildTxFromIxs(ixs, walletAddress, ctx);
    const summary = `Cancel Phoenix order ${input.orderId} on ${symbol}`;
    const params: Record<string, unknown> = {
      adapter: PHOENIX_ADAPTER_ID,
      connectorId: PHOENIX_ADAPTER_ID,
      action: 'cancel_order',
      walletAddress,
      symbol,
      orderId: input.orderId,
      priceTicks: input.priceTicks,
      mode: input.mode ?? 'live',
      ...(input.traderPdaIndex !== undefined && { traderPdaIndex: input.traderPdaIndex }),
      transactionBase64,
      preparedAt: new Date().toISOString(),
    };
    return {
      addInput: buildPreparedActionInput('phoenix_cancel_order', walletAddress, ctx.config.cluster, summary, params, input),
      preview: params,
    };
  },
  async execute(action: PreparedAction, ctx: DAppAdapterContext): Promise<AdapterExecuteResult> {
    const params = action.params as {
      symbol?: string;
      orderId?: string;
      priceTicks?: string;
      traderPdaIndex?: number;
    };
    if (!params.symbol || !params.orderId || !params.priceTicks) {
      throw new AdapterError(PHOENIX_ADAPTER_ID, 'invalid_request', 'phoenix_cancel_order: missing symbol/orderId/priceTicks in params.');
    }
    const walletAddress = await assertExecuteWalletAndPolicy(action, ctx, { symbol: params.symbol });
    const client = requireRiseClient(ctx);
    const ixs = await client.buildCancelOrderIxs({
      authority: walletAddress,
      symbol: params.symbol,
      priceTicks: BigInt(params.priceTicks),
      orderSequenceNumber: params.orderId,
      ...(params.traderPdaIndex !== undefined && { traderPdaIndex: params.traderPdaIndex }),
    });
    const tx = await buildTxFromIxs(ixs, walletAddress, ctx);
    const txid = await ctx.signAndBroadcast(tx, action.summary);
    return { txid, signedAt: new Date().toISOString() };
  },
};

// ---- Summary helpers ------------------------------------------------------------------------------------------------

/**
 * Format the human-readable summary for `phoenix_open`. Includes USD notional when a mark price is available,
 * and price-limit metadata when supplied.
 */
function formatOpenSummary(input: PhoenixOpenInput, symbol: string, markUsd: number | undefined): string {
  const orderType = input.priceLimitUsd ? `limit $${input.priceLimitUsd}` : 'market';
  const baseSizeNum = Number(input.baseSize);
  if (markUsd !== undefined && Number.isFinite(baseSizeNum) && baseSizeNum > 0) {
    const notional = formatUsd(baseSizeNum * markUsd * input.leverage);
    return `Open ${input.side} ${input.baseSize} ${symbol} @ ${input.leverage}x (${orderType}, ~${notional} notional)`;
  }
  return `Open ${input.side} ${input.baseSize} ${symbol} @ ${input.leverage}x (${orderType})`;
}

export { RISE_SDK_NOT_AVAILABLE_REASON };
