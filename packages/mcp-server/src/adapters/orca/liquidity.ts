import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { CONNECTOR_APPROVAL_BOUNDARY } from '../../connectorRegistry.js';
import type { PreparedAction } from '../../preparedActions.js';
import type {
  AdapterAction,
  AdapterExecuteResult,
  AdapterPrepareResult,
} from '../types.js';
import { AdapterError } from '../types.js';
import { getOrcaClient, type OrcaIncreaseLiquidityInput, type OrcaDecreaseLiquidityInput } from './client.js';
import { ORCA_ADAPTER_ID, ORCA_PROGRAM_IDS, shortAddress } from './constants.js';
import { getPositionDetail } from './positions.js';
import { getWhirlpoolSnapshot } from './whirlpools.js';
import {
  ensurePositionMatchesWhirlpool,
  optionalNumberParam,
  optionalPublicKey,
  optionalStringParam,
  parsePublicKey,
  requireStringParam,
  validateExactDecreaseAmountChoice,
  validateLiquidityPercent,
  validateSlippageBps,
  validateTickRange,
} from './validation.js';

export interface OrcaIncreaseLiquidityPrepareInput {
  whirlpoolAddress: string;
  positionMint?: string;
  tokenAAmount?: string;
  tokenBAmount?: string;
  maxTokenAAmount?: string;
  maxTokenBAmount?: string;
  lowerTick?: number;
  upperTick?: number;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export interface OrcaDecreaseLiquidityPrepareInput {
  whirlpoolAddress: string;
  positionMint: string;
  liquidityPercent?: number;
  liquidityAmount?: string;
  minTokenAAmount?: string;
  minTokenBAmount?: string;
  slippageBps?: number;
  dueAt?: string;
  note?: string;
}

export const orcaIncreaseLiquidityAction: AdapterAction<OrcaIncreaseLiquidityPrepareInput> = {
  id: 'increase_liquidity',
  kind: 'orca_increase_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const whirlpoolAddress = parsePublicKey(input.whirlpoolAddress, 'whirlpoolAddress');
    const positionMint = optionalPublicKey(input.positionMint, 'positionMint');
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    validateIncreaseAmount(input);

    let lowerTick = input.lowerTick;
    let upperTick = input.upperTick;
    let baseWarnings: string[] = [];
    if (positionMint) {
      const position = await getPositionDetail(ctx, { positionMint, whirlpoolAddress });
      ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
      lowerTick = position.tickLowerIndex;
      upperTick = position.tickUpperIndex;
      baseWarnings = [...rangeWarnings(position.currentTickIndex, lowerTick, upperTick), ...(position.warnings ?? [])];
    } else {
      const snapshot = await getWhirlpoolSnapshot(ctx, whirlpoolAddress);
      validateTickRange(lowerTick, upperTick, snapshot.tickSpacing);
      baseWarnings = rangeWarnings(snapshot.currentTickIndex, lowerTick!, upperTick!);
    }

    const preparedInput: OrcaIncreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress,
      ...(positionMint !== undefined && { positionMint }),
      ...(input.tokenAAmount !== undefined && { tokenAAmount: input.tokenAAmount }),
      ...(input.tokenBAmount !== undefined && { tokenBAmount: input.tokenBAmount }),
      ...(input.maxTokenAAmount !== undefined && { maxTokenAAmount: input.maxTokenAAmount }),
      ...(input.maxTokenBAmount !== undefined && { maxTokenBAmount: input.maxTokenBAmount }),
      ...(lowerTick !== undefined && { lowerTick }),
      ...(upperTick !== undefined && { upperTick }),
      slippageBps,
    };
    const preview = await getOrcaClient().previewIncreaseLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: ORCA_ADAPTER_ID,
      connectorId: ORCA_ADAPTER_ID,
      action: 'increase_liquidity',
      operation: 'increase_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      whirlpoolAddress,
      ...(positionMint !== undefined && { positionMint }),
      ...(input.tokenAAmount !== undefined && { tokenAAmount: input.tokenAAmount }),
      ...(input.tokenBAmount !== undefined && { tokenBAmount: input.tokenBAmount }),
      ...(input.maxTokenAAmount !== undefined && { maxTokenAAmount: input.maxTokenAAmount }),
      ...(input.maxTokenBAmount !== undefined && { maxTokenBAmount: input.maxTokenBAmount }),
      ...(lowerTick !== undefined && { lowerTick }),
      ...(upperTick !== undefined && { upperTick }),
      tickRange: lowerTick !== undefined && upperTick !== undefined ? { lowerTick, upperTick } : undefined,
      slippageBps,
      programIds: ORCA_PROGRAM_IDS,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      priceRange: preview.priceRange,
      quote: preview.quote,
      warnings: uniqueStrings([...(preview.warnings ?? []), ...baseWarnings]),
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'orca_increase_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Increase Orca liquidity on ${shortAddress(whirlpoolAddress)}`,
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
        `Orca increase-liquidity action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const input: OrcaIncreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress: requireStringParam(action, 'whirlpoolAddress'),
      ...(optionalStringParam(action, 'positionMint') !== undefined && { positionMint: optionalStringParam(action, 'positionMint') }),
      ...(optionalStringParam(action, 'tokenAAmount') !== undefined && { tokenAAmount: optionalStringParam(action, 'tokenAAmount') }),
      ...(optionalStringParam(action, 'tokenBAmount') !== undefined && { tokenBAmount: optionalStringParam(action, 'tokenBAmount') }),
      ...(optionalStringParam(action, 'maxTokenAAmount') !== undefined && { maxTokenAAmount: optionalStringParam(action, 'maxTokenAAmount') }),
      ...(optionalStringParam(action, 'maxTokenBAmount') !== undefined && { maxTokenBAmount: optionalStringParam(action, 'maxTokenBAmount') }),
      ...(optionalNumberParam(action, 'lowerTick') !== undefined && { lowerTick: optionalNumberParam(action, 'lowerTick') }),
      ...(optionalNumberParam(action, 'upperTick') !== undefined && { upperTick: optionalNumberParam(action, 'upperTick') }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getOrcaClient().buildIncreaseLiquidityTransaction(ctx.connection, input);
    const summary = `Increase Orca liquidity on ${shortAddress(input.whirlpoolAddress)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

export const orcaDecreaseLiquidityAction: AdapterAction<OrcaDecreaseLiquidityPrepareInput> = {
  id: 'decrease_liquidity',
  kind: 'orca_decrease_liquidity',

  async prepare(input, ctx): Promise<AdapterPrepareResult> {
    const walletAddress = await ctx.backend.getAddress();
    const whirlpoolAddress = parsePublicKey(input.whirlpoolAddress, 'whirlpoolAddress');
    const positionMint = parsePublicKey(input.positionMint, 'positionMint');
    const slippageBps = validateSlippageBps(input.slippageBps, ctx.config.mainnet.maxSlippageBps);
    const liquidityPercent = validateLiquidityPercent(input.liquidityPercent);
    validateExactDecreaseAmountChoice({ liquidityPercent, liquidityAmount: input.liquidityAmount });
    if (input.liquidityAmount !== undefined) validatePositiveDecimalString(input.liquidityAmount, 'liquidityAmount');
    if (input.minTokenAAmount !== undefined) validatePositiveDecimalString(input.minTokenAAmount, 'minTokenAAmount');
    if (input.minTokenBAmount !== undefined) validatePositiveDecimalString(input.minTokenBAmount, 'minTokenBAmount');

    const position = await getPositionDetail(ctx, { positionMint, whirlpoolAddress });
    ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
    const preparedInput: OrcaDecreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress,
      positionMint,
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(input.liquidityAmount !== undefined && { liquidityAmount: input.liquidityAmount }),
      ...(input.minTokenAAmount !== undefined && { minTokenAAmount: input.minTokenAAmount }),
      ...(input.minTokenBAmount !== undefined && { minTokenBAmount: input.minTokenBAmount }),
      slippageBps,
    };
    const preview = await getOrcaClient().previewDecreaseLiquidity(ctx.connection, preparedInput);
    const params = {
      adapter: ORCA_ADAPTER_ID,
      connectorId: ORCA_ADAPTER_ID,
      action: 'decrease_liquidity',
      operation: 'decrease_liquidity',
      approvalBoundary: CONNECTOR_APPROVAL_BOUNDARY,
      refreshAtExecution: true,
      whirlpoolAddress,
      positionMint,
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(input.liquidityAmount !== undefined && { liquidityAmount: input.liquidityAmount }),
      ...(input.minTokenAAmount !== undefined && { minTokenAAmount: input.minTokenAAmount }),
      ...(input.minTokenBAmount !== undefined && { minTokenBAmount: input.minTokenBAmount }),
      lowerTick: position.tickLowerIndex,
      upperTick: position.tickUpperIndex,
      tickRange: { lowerTick: position.tickLowerIndex, upperTick: position.tickUpperIndex },
      slippageBps,
      programIds: ORCA_PROGRAM_IDS,
      tokenMints: preview.tokenMints,
      tokenAmounts: preview.tokenAmounts,
      priceRange: preview.priceRange,
      quote: preview.quote,
      warnings: uniqueStrings([...(preview.warnings ?? []), ...rangeWarnings(position.currentTickIndex, position.tickLowerIndex, position.tickUpperIndex), ...(position.warnings ?? [])]),
      preparedSnapshotAt: new Date().toISOString(),
    };
    return {
      addInput: {
        kind: 'orca_decrease_liquidity',
        walletAddress,
        cluster: ctx.config.cluster,
        summary: `Decrease Orca liquidity on ${shortAddress(positionMint)}`,
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
        `Orca decrease-liquidity action belongs to ${action.walletAddress}, but connected wallet is ${walletAddress}.`,
      );
    }
    const input: OrcaDecreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress: requireStringParam(action, 'whirlpoolAddress'),
      positionMint: requireStringParam(action, 'positionMint'),
      ...(optionalNumberParam(action, 'liquidityPercent') !== undefined && { liquidityPercent: optionalNumberParam(action, 'liquidityPercent') }),
      ...(optionalStringParam(action, 'liquidityAmount') !== undefined && { liquidityAmount: optionalStringParam(action, 'liquidityAmount') }),
      ...(optionalStringParam(action, 'minTokenAAmount') !== undefined && { minTokenAAmount: optionalStringParam(action, 'minTokenAAmount') }),
      ...(optionalStringParam(action, 'minTokenBAmount') !== undefined && { minTokenBAmount: optionalStringParam(action, 'minTokenBAmount') }),
      slippageBps: optionalNumberParam(action, 'slippageBps') ?? ctx.config.mainnet.maxSlippageBps,
    };
    const built = await getOrcaClient().buildDecreaseLiquidityTransaction(ctx.connection, input);
    const summary = `Decrease Orca liquidity on ${shortAddress(input.positionMint)}`;
    const txid = await ctx.signAndBroadcast(built.transactionBase64, summary);
    return {
      txid,
      signedAt: new Date().toISOString(),
      ...(built.preview ? { preview: built.preview as unknown as Record<string, unknown> } : {}),
    };
  },
};

function validateIncreaseAmount(input: OrcaIncreaseLiquidityPrepareInput): void {
  const values = [
    ['tokenAAmount', input.tokenAAmount],
    ['tokenBAmount', input.tokenBAmount],
    ['maxTokenAAmount', input.maxTokenAAmount],
    ['maxTokenBAmount', input.maxTokenBAmount],
  ] as const;
  let found = false;
  for (const [field, value] of values) {
    if (value !== undefined && value.trim() !== '') {
      found = true;
      validatePositiveDecimalString(value, field);
    }
  }
  if (!found) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'missing_amount',
      'Provide tokenAAmount, tokenBAmount, maxTokenAAmount, or maxTokenBAmount for an Orca increase-liquidity action.',
    );
  }
}

function validatePositiveDecimalString(value: string, field: string): void {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', `${field} must be a positive decimal string.`);
  }
}

function rangeWarnings(currentTick: number | undefined, lowerTick: number | undefined, upperTick: number | undefined): string[] {
  if (
    typeof currentTick !== 'number' ||
    typeof lowerTick !== 'number' ||
    typeof upperTick !== 'number' ||
    !Number.isInteger(currentTick) ||
    !Number.isInteger(lowerTick) ||
    !Number.isInteger(upperTick)
  ) return [];
  const current = currentTick;
  const lower = lowerTick;
  const upper = upperTick;
  const warnings: string[] = [];
  if (current < lower || current >= upper) {
    warnings.push('Current Whirlpool tick is outside the selected position range.');
  }
  if (Math.abs(upper - lower) <= 16) {
    warnings.push('Selected range is narrow and may require active management.');
  }
  return warnings;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
