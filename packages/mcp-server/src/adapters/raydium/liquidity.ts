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
  validateRemoveLiquidityAmount,
  validateSlippageBps,
} from './validation.js';

export interface RaydiumAddLiquidityPrepareInput {
  poolId: string;
  poolType?: RaydiumLiquidityPoolType;
  positionMint?: string;
  amount?: string;
  amountSide?: 'tokenA' | 'tokenB';
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
    const amounts = normalizeAddLiquidityAmounts(input);
    const normalized = {
      ...input,
      poolType,
      positionMint,
      ...amounts,
    };
    validateAddAmounts(normalized);
    const snapshot = await getRaydiumPoolSnapshot(ctx, { poolId, poolType });
    assertPoolType(snapshot, poolType);

    const preparedInput: RaydiumAddLiquidityInput = {
      walletAddress,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(amounts.tokenAAmount !== undefined && { tokenAAmount: amounts.tokenAAmount }),
      ...(amounts.tokenBAmount !== undefined && { tokenBAmount: amounts.tokenBAmount }),
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
      amountSide: amounts.amountSide,
      ...(amounts.tokenAAmount !== undefined && { tokenAAmount: amounts.tokenAAmount }),
      ...(amounts.tokenBAmount !== undefined && { tokenBAmount: amounts.tokenBAmount }),
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
    const poolId = parsePublicKey(requireStringParam(action, 'poolId'), 'poolId');
    const poolType = parsePoolType(requireStringParam(action, 'poolType'));
    const positionMint = optionalPublicKey(optionalStringParam(action, 'positionMint'), 'positionMint');
    const tokenAAmount = optionalStringParam(action, 'tokenAAmount');
    const tokenBAmount = optionalStringParam(action, 'tokenBAmount');
    const maxTokenAAmount = optionalStringParam(action, 'maxTokenAAmount');
    const maxTokenBAmount = optionalStringParam(action, 'maxTokenBAmount');
    const lowerTick = optionalNumberParam(action, 'lowerTick');
    const upperTick = optionalNumberParam(action, 'upperTick');
    const lowerPrice = optionalStringParam(action, 'lowerPrice');
    const upperPrice = optionalStringParam(action, 'upperPrice');
    const slippageBps = validateSlippageBps(optionalNumberParam(action, 'slippageBps'), ctx.config.mainnet.maxSlippageBps);
    const input: RaydiumAddLiquidityInput = {
      walletAddress,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(tokenAAmount !== undefined && { tokenAAmount }),
      ...(tokenBAmount !== undefined && { tokenBAmount }),
      ...(maxTokenAAmount !== undefined && { maxTokenAAmount }),
      ...(maxTokenBAmount !== undefined && { maxTokenBAmount }),
      ...(lowerTick !== undefined && { lowerTick }),
      ...(upperTick !== undefined && { upperTick }),
      ...(lowerPrice !== undefined && { lowerPrice }),
      ...(upperPrice !== undefined && { upperPrice }),
      slippageBps,
    };
    validateAddAmounts(input);
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
    validateRemoveLiquidityAmount({ poolType, liquidityAmount: input.liquidityAmount });
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
    const poolId = parsePublicKey(requireStringParam(action, 'poolId'), 'poolId');
    const poolType = parsePoolType(requireStringParam(action, 'poolType'));
    const positionMint = optionalPublicKey(optionalStringParam(action, 'positionMint'), 'positionMint');
    if (poolType === 'clmm' && !positionMint) {
      throw new ProtocolError('invalid_request', 'positionMint is required for Raydium CLMM remove-liquidity.');
    }
    const liquidityPercent = validateLiquidityPercent(optionalNumberParam(action, 'liquidityPercent'));
    const liquidityAmount = optionalStringParam(action, 'liquidityAmount');
    const minTokenAAmount = optionalStringParam(action, 'minTokenAAmount');
    const minTokenBAmount = optionalStringParam(action, 'minTokenBAmount');
    const closePosition = optionalBooleanParam(action, 'closePosition');
    const slippageBps = validateSlippageBps(optionalNumberParam(action, 'slippageBps'), ctx.config.mainnet.maxSlippageBps);
    validateDecreaseAmountChoice({ liquidityPercent, liquidityAmount });
    validateRemoveLiquidityAmount({ poolType, liquidityAmount });
    validateOptionalPositiveDecimalString(minTokenAAmount, 'minTokenAAmount');
    validateOptionalPositiveDecimalString(minTokenBAmount, 'minTokenBAmount');
    const input: RaydiumRemoveLiquidityInput = {
      walletAddress,
      poolId,
      poolType,
      ...(positionMint !== undefined && { positionMint }),
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(liquidityAmount !== undefined && { liquidityAmount }),
      ...(minTokenAAmount !== undefined && { minTokenAAmount }),
      ...(minTokenBAmount !== undefined && { minTokenBAmount }),
      ...(closePosition !== undefined && { closePosition }),
      slippageBps,
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
    const poolId = optionalPublicKey(optionalStringParam(action, 'poolId'), 'poolId');
    const input: RaydiumCollectFeesInput = {
      walletAddress,
      positionMint: parsePublicKey(requireStringParam(action, 'positionMint'), 'positionMint'),
      ...(poolId !== undefined && { poolId }),
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

function normalizeAddLiquidityAmounts(input: RaydiumAddLiquidityPrepareInput): {
  amountSide: 'tokenA' | 'tokenB';
  tokenAAmount?: string;
  tokenBAmount?: string;
} {
  const amountSide = input.amountSide === 'tokenB' ? 'tokenB' : 'tokenA';
  const tokenAAmount = input.tokenAAmount?.trim() ||
    (amountSide === 'tokenA' ? input.amount?.trim() : undefined);
  const tokenBAmount = input.tokenBAmount?.trim() ||
    (amountSide === 'tokenB' ? input.amount?.trim() : undefined);
  return {
    amountSide,
    ...(tokenAAmount ? { tokenAAmount } : {}),
    ...(tokenBAmount ? { tokenBAmount } : {}),
  };
}
