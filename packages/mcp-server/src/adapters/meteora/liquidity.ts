import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
  DAppAdapterContext,
} from '../types.js';
import { AdapterError } from '../types.js';
import {
  getMeteoraClient,
  type MeteoraAddLiquidityInput,
  type MeteoraClosePositionInput,
  type MeteoraRemoveLiquidityInput,
} from './client.js';
import {
  METEORA_ADAPTER_ID,
  METEORA_PROGRAM_IDS,
  normalizeMeteoraStrategyType,
  shortAddress,
  type MeteoraStrategyType,
} from './constants.js';
import { getPositionDetail } from './positions.js';
import {
  ensureEmptyPosition,
  ensurePositionMatchesPool,
  optionalNumberParam,
  optionalStringParam,
  parsePublicKey,
  requireStringParam,
  validateBinRange,
  validateLiquidityBps,
  validateSlippageBps,
} from './validation.js';

export interface MeteoraAddLiquidityPrepareInput {
  poolAddress: string;
  positionAddress?: string;
  tokenXAmount?: string;
  tokenYAmount?: string;
  minBinId?: number;
  maxBinId?: number;
  strategyType?: MeteoraStrategyType;
  singleSidedX?: boolean;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface MeteoraRemoveLiquidityPrepareInput {
  poolAddress: string;
  positionAddress: string;
  liquidityBps?: number;
  liquidityPercent?: number;
  minBinId?: number;
  maxBinId?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface MeteoraClosePositionPrepareInput {
  poolAddress: string;
  positionAddress: string;
  dueAt?: string;
  note?: string;
}

export const meteoraAddLiquidityAction: AdapterAction<MeteoraAddLiquidityPrepareInput> = {
  id: 'add_liquidity',
  kind: 'meteora_add_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const poolAddress = parsePublicKey(input.poolAddress, 'poolAddress');
    const positionAddress = parsePublicKey(input.positionAddress, 'positionAddress');
    const { minBinId, maxBinId } = validateBinRange(input.minBinId, input.maxBinId);
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    validateAddLiquidityAmounts(input);
    const strategyType = normalizeMeteoraStrategyType(input.strategyType);
    const preparedInput: MeteoraAddLiquidityInput = {
      walletAddress,
      poolAddress,
      positionAddress,
      ...(input.tokenXAmount !== undefined && { tokenXAmount: input.tokenXAmount }),
      ...(input.tokenYAmount !== undefined && { tokenYAmount: input.tokenYAmount }),
      minBinId,
      maxBinId,
      strategyType,
      ...(input.singleSidedX !== undefined && { singleSidedX: input.singleSidedX }),
      slippageBps,
    };
    const preview = await getMeteoraClient().previewAddLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: METEORA_ADAPTER_ID,
      connectorId: METEORA_ADAPTER_ID,
      action: 'add_liquidity',
      operation: 'add_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      poolAddress,
      positionAddress,
      ...(input.tokenXAmount !== undefined && { tokenXAmount: input.tokenXAmount }),
      ...(input.tokenYAmount !== undefined && { tokenYAmount: input.tokenYAmount }),
      minBinId,
      maxBinId,
      binRange: { minBinId, maxBinId },
      strategyType,
      ...(input.singleSidedX !== undefined && { singleSidedX: input.singleSidedX }),
      slippageBps,
      programIds: METEORA_PROGRAM_IDS,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      activeBinId: preview.activeBinId,
      quote: preview.quote,
      warnings: uniqueStrings([...(preview.warnings ?? []), ...rangeWarnings(preview.activeBinId, minBinId, maxBinId)]),
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'meteora_add_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Add Meteora liquidity on ${shortAddress(poolAddress)} bins ${minBinId}-${maxBinId}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await requireWallet(action, ctx, 'add-liquidity');
    const input: MeteoraAddLiquidityInput = {
      walletAddress,
      poolAddress: requireStringParam(action, 'poolAddress'),
      positionAddress: requireStringParam(action, 'positionAddress'),
      ...(optionalStringParam(action, 'tokenXAmount') !== undefined && { tokenXAmount: optionalStringParam(action, 'tokenXAmount') }),
      ...(optionalStringParam(action, 'tokenYAmount') !== undefined && { tokenYAmount: optionalStringParam(action, 'tokenYAmount') }),
      minBinId: optionalNumberParam(action, 'minBinId') ?? requireBinRange(action).minBinId,
      maxBinId: optionalNumberParam(action, 'maxBinId') ?? requireBinRange(action).maxBinId,
      strategyType: normalizeMeteoraStrategyType(optionalStringParam(action, 'strategyType')),
      ...(action.params.singleSidedX === true && { singleSidedX: true }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getMeteoraClient().buildAddLiquidityTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, `Add Meteora liquidity on ${shortAddress(input.poolAddress)}`);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

export const meteoraRemoveLiquidityAction: AdapterAction<MeteoraRemoveLiquidityPrepareInput> = {
  id: 'remove_liquidity',
  kind: 'meteora_remove_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const poolAddress = parsePublicKey(input.poolAddress, 'poolAddress');
    const positionAddress = parsePublicKey(input.positionAddress, 'positionAddress');
    const position = await getPositionDetail(ctx, { poolAddress, positionAddress });
    ensurePositionMatchesPool(position, poolAddress);
    const { minBinId, maxBinId } = validateBinRange(input.minBinId ?? position.lowerBinId, input.maxBinId ?? position.upperBinId);
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const liquidityBps = validateLiquidityBps(input);
    const preparedInput: MeteoraRemoveLiquidityInput = {
      walletAddress,
      poolAddress,
      positionAddress,
      liquidityBps,
      minBinId,
      maxBinId,
      slippageBps,
    };
    const preview = await getMeteoraClient().previewRemoveLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: METEORA_ADAPTER_ID,
      connectorId: METEORA_ADAPTER_ID,
      action: 'remove_liquidity',
      operation: 'remove_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      poolAddress,
      positionAddress,
      liquidityBps,
      minBinId,
      maxBinId,
      binRange: { minBinId, maxBinId },
      slippageBps,
      programIds: METEORA_PROGRAM_IDS,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      activeBinId: preview.activeBinId ?? position.activeBinId,
      quote: preview.quote,
      warnings: uniqueStrings([...(preview.warnings ?? []), ...rangeWarnings(position.activeBinId, minBinId, maxBinId), ...(position.warnings ?? [])]),
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'meteora_remove_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Remove ${liquidityBps / 100}% Meteora liquidity from ${shortAddress(positionAddress)}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await requireWallet(action, ctx, 'remove-liquidity');
    const range = requireBinRange(action);
    const input: MeteoraRemoveLiquidityInput = {
      walletAddress,
      poolAddress: requireStringParam(action, 'poolAddress'),
      positionAddress: requireStringParam(action, 'positionAddress'),
      liquidityBps: optionalNumberParam(action, 'liquidityBps') ?? 10_000,
      minBinId: range.minBinId,
      maxBinId: range.maxBinId,
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getMeteoraClient().buildRemoveLiquidityTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, `Remove Meteora liquidity from ${shortAddress(input.positionAddress)}`);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

export const meteoraClosePositionAction: AdapterAction<MeteoraClosePositionPrepareInput> = {
  id: 'close_position',
  kind: 'meteora_close_position',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const poolAddress = parsePublicKey(input.poolAddress, 'poolAddress');
    const positionAddress = parsePublicKey(input.positionAddress, 'positionAddress');
    const position = await getPositionDetail(ctx, { poolAddress, positionAddress });
    ensureEmptyPosition(position);
    const preparedInput: MeteoraClosePositionInput = { walletAddress, poolAddress, positionAddress };
    const preview = await getMeteoraClient().previewClosePosition(ctx.connection, preparedInput);
    const params = {
      adapter: METEORA_ADAPTER_ID,
      connectorId: METEORA_ADAPTER_ID,
      action: 'close_position',
      operation: 'close_position',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      poolAddress,
      positionAddress,
      programIds: METEORA_PROGRAM_IDS,
      warnings: preview.warnings,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'meteora_close_position',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Close empty Meteora position ${shortAddress(positionAddress)}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await requireWallet(action, ctx, 'close-position');
    const input: MeteoraClosePositionInput = {
      walletAddress,
      poolAddress: requireStringParam(action, 'poolAddress'),
      positionAddress: requireStringParam(action, 'positionAddress'),
    };
    const position = await getPositionDetail(ctx, input);
    ensureEmptyPosition(position);
    const built = await getMeteoraClient().buildClosePositionTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, `Close Meteora position ${shortAddress(input.positionAddress)}`);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

async function requireWallet(action: PreparedAction, ctx: DAppAdapterContext, label: string): Promise<string> {
  const walletAddress = await ctx.backend.getAddress();
  if (walletAddress !== action.walletAddress) {
    throw new ProtocolError(
      'unauthorized',
      `Meteora ${label} action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
    );
  }
  return walletAddress;
}

function validateAddLiquidityAmounts(input: MeteoraAddLiquidityPrepareInput): void {
  const hasX = typeof input.tokenXAmount === 'string' && input.tokenXAmount.trim() !== '';
  const hasY = typeof input.tokenYAmount === 'string' && input.tokenYAmount.trim() !== '';
  if (!hasX && !hasY) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'missing_amount', 'Provide tokenXAmount, tokenYAmount, or both.');
  }
  if (input.singleSidedX === true && hasY) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_single_sided', 'singleSidedX cannot include tokenYAmount.');
  }
}

function requireBinRange(action: PreparedAction): { minBinId: number; maxBinId: number } {
  const fromParams = {
    minBinId: optionalNumberParam(action, 'minBinId'),
    maxBinId: optionalNumberParam(action, 'maxBinId'),
  };
  if (fromParams.minBinId !== undefined && fromParams.maxBinId !== undefined) return fromParams as { minBinId: number; maxBinId: number };
  const raw = action.params.binRange;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProtocolError('invalid_request', `Meteora action ${action.id} is missing binRange.`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.minBinId !== 'number' || typeof record.maxBinId !== 'number') {
    throw new ProtocolError('invalid_request', `Meteora action ${action.id} has an invalid binRange.`);
  }
  return { minBinId: record.minBinId, maxBinId: record.maxBinId };
}

function rangeWarnings(activeBinId: number | undefined, minBinId: number, maxBinId: number): string[] {
  if (activeBinId === undefined) return [];
  if (activeBinId < minBinId || activeBinId > maxBinId) {
    return [`Active bin ${activeBinId} is outside requested range ${minBinId}-${maxBinId}.`];
  }
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
