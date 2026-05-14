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
  type MeteoraBuildTransactionResult,
  type MeteoraClosePositionInput,
  type MeteoraPoolSnapshot,
  type MeteoraPosition,
  type MeteoraRemoveLiquidityInput,
} from './client.js';
import {
  METEORA_ADAPTER_ID,
  METEORA_PROGRAM_IDS,
  normalizeMeteoraStrategyType,
  shortAddress,
  type MeteoraStrategyType,
} from './constants.js';
import { getPoolSnapshot } from './pools.js';
import { getPositionDetail } from './positions.js';
import {
  ensureBinRangeWithinPosition,
  ensureEmptyPosition,
  ensureNoClaimableAmounts,
  ensurePositionMatchesPool,
  ensurePositionOwnedByWallet,
  optionalNumberParam,
  optionalPublicKey,
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
  amount?: string;
  amountSide?: 'tokenX' | 'tokenY';
  tokenXAmount?: string;
  tokenYAmount?: string;
  minBinId?: number | string;
  maxBinId?: number | string;
  rangePreset?: string;
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
    const positionAddress = optionalPublicKey(input.positionAddress, 'positionAddress');
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const amounts = normalizeAddLiquidityAmounts(input);
    validateAddLiquidityAmounts({ ...input, ...amounts });
    const strategyType = normalizeMeteoraStrategyType(input.strategyType);
    const snapshot = await getPoolSnapshot(ctx, poolAddress);
    const position = positionAddress
      ? await getPositionDetail(ctx, { poolAddress, positionAddress })
      : undefined;
    if (position) {
      ensurePositionMatchesPool(position, poolAddress);
      ensurePositionOwnedByWallet(position, walletAddress);
    }
    const { minBinId, maxBinId } = resolveMeteoraBinRange(input, position, snapshot);
    if (position) ensureBinRangeWithinPosition(position, minBinId, maxBinId);
    const preparedInput: MeteoraAddLiquidityInput = {
      walletAddress,
      poolAddress,
      ...(positionAddress !== undefined && { positionAddress }),
      ...amounts,
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
      poolName: snapshot.tokenXSymbol && snapshot.tokenYSymbol
        ? `${snapshot.tokenXSymbol}-${snapshot.tokenYSymbol}`
        : undefined,
      tokenXSymbol: snapshot.tokenXSymbol,
      tokenYSymbol: snapshot.tokenYSymbol,
      tokenMintX: snapshot.tokenMintX,
      tokenMintY: snapshot.tokenMintY,
      ...(positionAddress !== undefined && { positionAddress }),
      newPosition: positionAddress === undefined,
      ...amounts,
      minBinId,
      maxBinId,
      binRange: { minBinId, maxBinId },
      binStep: snapshot.binStep,
      ...(input.rangePreset !== undefined && { rangePreset: input.rangePreset }),
      strategyType,
      ...(input.singleSidedX !== undefined && { singleSidedX: input.singleSidedX }),
      slippageBps,
      programIds: METEORA_PROGRAM_IDS,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      activeBinId: preview.activeBinId,
      quote: preview.quote,
      warnings: uniqueStrings([...(preview.warnings ?? []), ...rangeWarnings(preview.activeBinId, minBinId, maxBinId), ...(position?.warnings ?? [])]),
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'meteora_add_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: positionAddress
          ? `Add Meteora liquidity on ${shortAddress(poolAddress)} bins ${minBinId}-${maxBinId}`
          : `Open Meteora position on ${shortAddress(poolAddress)} bins ${minBinId}-${maxBinId}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await requireWallet(action, ctx, 'add-liquidity');
    const tokenXAmount = optionalStringParam(action, 'tokenXAmount');
    const tokenYAmount = optionalStringParam(action, 'tokenYAmount');
    const range = requireBinRange(action);
    const positionAddress = optionalStringParam(action, 'positionAddress');
    const input: MeteoraAddLiquidityInput = {
      walletAddress,
      poolAddress: requireStringParam(action, 'poolAddress'),
      ...(positionAddress !== undefined && { positionAddress }),
      ...(tokenXAmount !== undefined && { tokenXAmount }),
      ...(tokenYAmount !== undefined && { tokenYAmount }),
      minBinId: optionalNumberParam(action, 'minBinId') ?? range.minBinId,
      maxBinId: optionalNumberParam(action, 'maxBinId') ?? range.maxBinId,
      strategyType: normalizeMeteoraStrategyType(optionalStringParam(action, 'strategyType')),
      ...(action.params.singleSidedX === true && { singleSidedX: true }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    if (positionAddress) {
      const position = await getPositionDetail(ctx, { ...input, positionAddress });
      ensurePositionOwnedByWallet(position, walletAddress);
      ensureBinRangeWithinPosition(position, input.minBinId, input.maxBinId);
    }
    const built = await getMeteoraClient().buildAddLiquidityTransaction(ctx.connection, input);
    const txids = await signMeteoraBuiltTransaction(
      ctx,
      built,
      positionAddress
        ? `Add Meteora liquidity on ${shortAddress(input.poolAddress)}`
        : `Open Meteora position on ${shortAddress(input.poolAddress)}`,
    );
    return {
      txid: txids[0]!,
      txids,
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
    ensurePositionOwnedByWallet(position, walletAddress);
    const { minBinId, maxBinId } = validateBinRange(input.minBinId ?? position.lowerBinId, input.maxBinId ?? position.upperBinId);
    ensureBinRangeWithinPosition(position, minBinId, maxBinId);
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
    const position = await getPositionDetail(ctx, input);
    ensurePositionOwnedByWallet(position, walletAddress);
    ensureBinRangeWithinPosition(position, input.minBinId, input.maxBinId);
    const built = await getMeteoraClient().buildRemoveLiquidityTransaction(ctx.connection, input);
    const txids = await signMeteoraBuiltTransaction(ctx, built, `Remove Meteora liquidity from ${shortAddress(input.positionAddress)}`);
    return {
      txid: txids[0]!,
      txids,
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
    ensurePositionOwnedByWallet(position, walletAddress);
    ensureEmptyPosition(position);
    ensureNoClaimableAmounts(position);
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
    ensurePositionOwnedByWallet(position, walletAddress);
    ensureEmptyPosition(position);
    ensureNoClaimableAmounts(position);
    const built = await getMeteoraClient().buildClosePositionTransaction(ctx.connection, input);
    const txids = await signMeteoraBuiltTransaction(ctx, built, `Close Meteora position ${shortAddress(input.positionAddress)}`);
    return {
      txid: txids[0]!,
      txids,
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

type MeteoraAddLiquidityAmounts = Pick<MeteoraAddLiquidityPrepareInput, 'tokenXAmount' | 'tokenYAmount'>;

function normalizeAddLiquidityAmounts(input: MeteoraAddLiquidityPrepareInput): MeteoraAddLiquidityAmounts {
  const hasNativeAmount = [input.tokenXAmount, input.tokenYAmount]
    .some((value) => typeof value === 'string' && value.trim() !== '');
  if (hasNativeAmount) {
    return {
      ...(input.tokenXAmount !== undefined && { tokenXAmount: input.tokenXAmount }),
      ...(input.tokenYAmount !== undefined && { tokenYAmount: input.tokenYAmount }),
    };
  }
  const amount = input.amount?.trim();
  if (!amount) return {};
  return input.amountSide === 'tokenY'
    ? { tokenYAmount: amount }
    : { tokenXAmount: amount };
}

function resolveMeteoraBinRange(
  input: MeteoraAddLiquidityPrepareInput,
  position: MeteoraPosition | undefined,
  snapshot: MeteoraPoolSnapshot,
): { minBinId: number; maxBinId: number } {
  const manualMin = numberLike(input.minBinId);
  const manualMax = numberLike(input.maxBinId);
  if (manualMin !== undefined || manualMax !== undefined) {
    return validateBinRange(manualMin, manualMax);
  }
  const preset = input.rangePreset?.trim().toLowerCase();
  if (position && (!preset || preset === 'position' || preset === 'existing')) {
    return validateBinRange(position.lowerBinId, position.upperBinId);
  }
  const halfBins = meteoraRangePresetHalfBins(preset);
  return validateBinRange(snapshot.activeBinId - halfBins, snapshot.activeBinId + halfBins);
}

function meteoraRangePresetHalfBins(preset: string | undefined): number {
  if (preset === 'narrow') return 2;
  if (preset === 'wide') return 34;
  return 10;
}

function numberLike(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
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

async function signMeteoraBuiltTransaction(
  ctx: DAppAdapterContext,
  built: MeteoraBuildTransactionResult,
  summary: string,
): Promise<string[]> {
  const transactions = transactionsForBuiltResult(built);
  if (ctx.signAndBroadcastMany) {
    return ctx.signAndBroadcastMany(transactions, summary);
  }
  const txids: string[] = [];
  for (let index = 0; index < transactions.length; index += 1) {
    const suffix = transactions.length > 1 ? ` (${index + 1}/${transactions.length})` : '';
    txids.push(await ctx.signAndBroadcast(transactions[index]!, `${summary}${suffix}`));
  }
  return txids;
}

function transactionsForBuiltResult(built: MeteoraBuildTransactionResult): string[] {
  const transactions = built.transactionsBase64?.length
    ? built.transactionsBase64
    : built.transactionBase64
      ? [built.transactionBase64]
      : [];
  if (transactions.length === 0) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'empty_transaction', 'Meteora SDK returned no transaction to sign.');
  }
  return transactions;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
