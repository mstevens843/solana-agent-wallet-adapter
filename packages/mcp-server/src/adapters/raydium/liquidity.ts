import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import {
  getRaydiumClient,
  type RaydiumAddLiquidityInput,
  type RaydiumCollectFeesInput,
  type RaydiumLiquidityPoolType,
  type RaydiumRemoveLiquidityInput,
} from './client.js';
import { RAYDIUM_ADAPTER_ID, RAYDIUM_PROGRAM_IDS, shortAddress } from './constants.js';
import { getRaydiumPoolSnapshot } from './pools.js';
import {
  assertPoolType,
  optionalBooleanParam,
  optionalNumberParam,
  optionalPublicKey,
  optionalStringParam,
  parsePoolType,
  parsePublicKey,
  requireStringParam,
  stripUndefined,
  validateAddAmounts,
  validateDecreaseAmountChoice,
  validateLiquidityPercent,
  validateOptionalPositiveDecimalString,
  validateSlippageBps,
} from './validation.js';

export interface RaydiumAddLiquidityPrepareInput {
  poolId: string;
  poolType?: RaydiumLiquidityPoolType;
  positionMint?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
  maxTokenAAmount?: string;
  maxTokenBAmount?: string;
  lowerTick?: number;
  upperTick?: number;
  lowerPrice?: string;
  upperPrice?: string;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface RaydiumRemoveLiquidityPrepareInput {
  poolId: string;
  poolType?: RaydiumLiquidityPoolType;
  positionMint?: string;
  liquidityPercent?: number;
  liquidityAmount?: string;
  minTokenAAmount?: string;
  minTokenBAmount?: string;
  closePosition?: boolean;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface RaydiumCollectFeesPrepareInput {
  positionMint: string;
  poolId?: string;
  dueAt?: string;
  note?: string;
}

export const raydiumAddLiquidityAction: AdapterAction<RaydiumAddLiquidityPrepareInput> = {
  id: 'add_liquidity',
  kind: 'raydium_add_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const poolId = parsePublicKey(input.poolId, 'poolId');
    const poolType = parsePoolType(input.poolType);
    const positionMint = optionalPublicKey(input.positionMint, 'positionMint');
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const normalized = {
      ...input,
      poolType,
      positionMint,
    };
    validateAddAmounts(normalized);
    const snapshot = await getRaydiumPoolSnapshot(ctx, { poolId, poolType });
    assertPoolType(snapshot, poolType);

    const preparedInput: RaydiumAddLiquidityInput = {
      walletAddress,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(input.tokenAAmount !== undefined && { tokenAAmount: input.tokenAAmount }),
      ...(input.tokenBAmount !== undefined && { tokenBAmount: input.tokenBAmount }),
      ...(input.maxTokenAAmount !== undefined && { maxTokenAAmount: input.maxTokenAAmount }),
      ...(input.maxTokenBAmount !== undefined && { maxTokenBAmount: input.maxTokenBAmount }),
      ...(input.lowerTick !== undefined && { lowerTick: input.lowerTick }),
      ...(input.upperTick !== undefined && { upperTick: input.upperTick }),
      ...(input.lowerPrice !== undefined && { lowerPrice: input.lowerPrice }),
      ...(input.upperPrice !== undefined && { upperPrice: input.upperPrice }),
      slippageBps,
    };
    const preview = await getRaydiumClient().previewAddLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: RAYDIUM_ADAPTER_ID,
      connectorId: RAYDIUM_ADAPTER_ID,
      action: 'add_liquidity',
      operation: 'add_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(input.tokenAAmount !== undefined && { tokenAAmount: input.tokenAAmount }),
      ...(input.tokenBAmount !== undefined && { tokenBAmount: input.tokenBAmount }),
      ...(input.maxTokenAAmount !== undefined && { maxTokenAAmount: input.maxTokenAAmount }),
      ...(input.maxTokenBAmount !== undefined && { maxTokenBAmount: input.maxTokenBAmount }),
      ...(input.lowerTick !== undefined && { lowerTick: input.lowerTick }),
      ...(input.upperTick !== undefined && { upperTick: input.upperTick }),
      ...(input.lowerPrice !== undefined && { lowerPrice: input.lowerPrice }),
      ...(input.upperPrice !== undefined && { upperPrice: input.upperPrice }),
      slippageBps,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      tickRange: preview.tickRange,
      priceRange: preview.priceRange,
      lpMint: preview.lpMint,
      programIds: RAYDIUM_PROGRAM_IDS,
      warnings: preview.warnings,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'raydium_add_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Add Raydium ${poolType.toUpperCase()} liquidity to ${shortAddress(poolId)}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Raydium add-liquidity action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const input: RaydiumAddLiquidityInput = {
      walletAddress,
      poolId: requireStringParam(action, 'poolId'),
      poolType: parsePoolType(requireStringParam(action, 'poolType')),
      ...(optionalStringParam(action, 'positionMint') !== undefined && { positionMint: optionalStringParam(action, 'positionMint') }),
      ...(optionalStringParam(action, 'tokenAAmount') !== undefined && { tokenAAmount: optionalStringParam(action, 'tokenAAmount') }),
      ...(optionalStringParam(action, 'tokenBAmount') !== undefined && { tokenBAmount: optionalStringParam(action, 'tokenBAmount') }),
      ...(optionalStringParam(action, 'maxTokenAAmount') !== undefined && { maxTokenAAmount: optionalStringParam(action, 'maxTokenAAmount') }),
      ...(optionalStringParam(action, 'maxTokenBAmount') !== undefined && { maxTokenBAmount: optionalStringParam(action, 'maxTokenBAmount') }),
      ...(optionalNumberParam(action, 'lowerTick') !== undefined && { lowerTick: optionalNumberParam(action, 'lowerTick') }),
      ...(optionalNumberParam(action, 'upperTick') !== undefined && { upperTick: optionalNumberParam(action, 'upperTick') }),
      ...(optionalStringParam(action, 'lowerPrice') !== undefined && { lowerPrice: optionalStringParam(action, 'lowerPrice') }),
      ...(optionalStringParam(action, 'upperPrice') !== undefined && { upperPrice: optionalStringParam(action, 'upperPrice') }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getRaydiumClient().buildAddLiquidityTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

export const raydiumRemoveLiquidityAction: AdapterAction<RaydiumRemoveLiquidityPrepareInput> = {
  id: 'remove_liquidity',
  kind: 'raydium_remove_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const poolId = parsePublicKey(input.poolId, 'poolId');
    const poolType = parsePoolType(input.poolType);
    const positionMint = optionalPublicKey(input.positionMint, 'positionMint');
    if (poolType === 'clmm' && !positionMint) {
      throw new ProtocolError('invalid_request', 'positionMint is required for Raydium CLMM remove-liquidity.');
    }
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const liquidityPercent = validateLiquidityPercent(input.liquidityPercent);
    validateDecreaseAmountChoice({ liquidityPercent, liquidityAmount: input.liquidityAmount });
    validateOptionalPositiveDecimalString(input.liquidityAmount, 'liquidityAmount');
    validateOptionalPositiveDecimalString(input.minTokenAAmount, 'minTokenAAmount');
    validateOptionalPositiveDecimalString(input.minTokenBAmount, 'minTokenBAmount');

    const snapshot = await getRaydiumPoolSnapshot(ctx, { poolId, poolType });
    assertPoolType(snapshot, poolType);
    const preparedInput: RaydiumRemoveLiquidityInput = {
      walletAddress,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(input.liquidityAmount !== undefined && { liquidityAmount: input.liquidityAmount }),
      ...(input.minTokenAAmount !== undefined && { minTokenAAmount: input.minTokenAAmount }),
      ...(input.minTokenBAmount !== undefined && { minTokenBAmount: input.minTokenBAmount }),
      ...(input.closePosition !== undefined && { closePosition: input.closePosition }),
      slippageBps,
    };
    const preview = await getRaydiumClient().previewRemoveLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: RAYDIUM_ADAPTER_ID,
      connectorId: RAYDIUM_ADAPTER_ID,
      action: 'remove_liquidity',
      operation: 'remove_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(input.liquidityAmount !== undefined && { liquidityAmount: input.liquidityAmount }),
      ...(input.minTokenAAmount !== undefined && { minTokenAAmount: input.minTokenAAmount }),
      ...(input.minTokenBAmount !== undefined && { minTokenBAmount: input.minTokenBAmount }),
      ...(input.closePosition !== undefined && { closePosition: input.closePosition }),
      slippageBps,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      tickRange: preview.tickRange,
      priceRange: preview.priceRange,
      lpMint: preview.lpMint,
      programIds: RAYDIUM_PROGRAM_IDS,
      warnings: preview.warnings,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'raydium_remove_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Remove Raydium ${poolType.toUpperCase()} liquidity from ${shortAddress(poolId)}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Raydium remove-liquidity action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const input: RaydiumRemoveLiquidityInput = {
      walletAddress,
      poolId: requireStringParam(action, 'poolId'),
      poolType: parsePoolType(requireStringParam(action, 'poolType')),
      ...(optionalStringParam(action, 'positionMint') !== undefined && { positionMint: optionalStringParam(action, 'positionMint') }),
      ...(optionalNumberParam(action, 'liquidityPercent') !== undefined && { liquidityPercent: optionalNumberParam(action, 'liquidityPercent') }),
      ...(optionalStringParam(action, 'liquidityAmount') !== undefined && { liquidityAmount: optionalStringParam(action, 'liquidityAmount') }),
      ...(optionalStringParam(action, 'minTokenAAmount') !== undefined && { minTokenAAmount: optionalStringParam(action, 'minTokenAAmount') }),
      ...(optionalStringParam(action, 'minTokenBAmount') !== undefined && { minTokenBAmount: optionalStringParam(action, 'minTokenBAmount') }),
      ...(optionalBooleanParam(action, 'closePosition') !== undefined && { closePosition: optionalBooleanParam(action, 'closePosition') }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getRaydiumClient().buildRemoveLiquidityTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

export const raydiumCollectFeesAction: AdapterAction<RaydiumCollectFeesPrepareInput> = {
  id: 'collect_fees',
  kind: 'raydium_collect_fees',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const positionMint = parsePublicKey(input.positionMint, 'positionMint');
    const poolId = optionalPublicKey(input.poolId, 'poolId');
    const collectInput: RaydiumCollectFeesInput = {
      walletAddress,
      positionMint,
      ...(poolId !== undefined && { poolId }),
    };
    const preview = await getRaydiumClient().previewCollectFees(ctx.connection, collectInput);
    const params = {
      adapter: RAYDIUM_ADAPTER_ID,
      connectorId: RAYDIUM_ADAPTER_ID,
      action: 'collect_fees',
      operation: 'collect_fees',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      positionMint,
      ...(poolId !== undefined && { poolId }),
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      tickRange: preview.tickRange,
      priceRange: preview.priceRange,
      programIds: RAYDIUM_PROGRAM_IDS,
      warnings: preview.warnings,
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'raydium_collect_fees',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Collect Raydium fees for ${shortAddress(positionMint)}`,
        params: stripUndefined(params),
        ...(input.dueAt !== undefined && { dueAt: input.dueAt }),
        ...(input.note !== undefined && { note: input.note }),
      },
      preview: stripUndefined(params),
    };
  },

  async execute(action: PreparedAction, ctx): Promise<AdapterExecuteResult> {
    const walletAddress = await ctx.backend.getAddress();
    if (walletAddress !== action.walletAddress) {
      throw new ProtocolError(
        'unauthorized',
        `Raydium collect-fees action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const input: RaydiumCollectFeesInput = {
      walletAddress,
      positionMint: requireStringParam(action, 'positionMint'),
      ...(optionalStringParam(action, 'poolId') !== undefined && { poolId: optionalStringParam(action, 'poolId') }),
    };
    const built = await getRaydiumClient().buildCollectFeesTransaction(ctx.connection, input);
    const txid = await ctx.signAndBroadcast(built.transactionBase64, action.summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};
