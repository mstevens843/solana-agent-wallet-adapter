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
  amount?: string;
  amountSide?: 'tokenA' | 'tokenB';
  tokenAAmount?: string;
  tokenBAmount?: string;
  maxTokenAAmount?: string;
  maxTokenBAmount?: string;
  lowerTick?: number | string;
  upperTick?: number | string;
  rangePreset?: string;
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
    const amounts = normalizeIncreaseAmounts(input);
    validateIncreaseAmount(amounts);
    const snapshot = await getWhirlpoolSnapshot(ctx, whirlpoolAddress);

    let lowerTick: number | undefined;
    let upperTick: number | undefined;
    let baseWarnings: string[] = [];
    if (positionMint) {
      const position = await getPositionDetail(ctx, { positionMint, whirlpoolAddress });
      ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
      lowerTick = position.tickLowerIndex;
      upperTick = position.tickUpperIndex;
      baseWarnings = [...rangeWarnings(snapshot.currentTickIndex, lowerTick, upperTick), ...(position.warnings ?? [])];
    } else {
      const range = resolveOrcaTickRange(input, snapshot);
      lowerTick = range.lowerTick;
      upperTick = range.upperTick;
      baseWarnings = rangeWarnings(snapshot.currentTickIndex, lowerTick, upperTick);
    }

    const preparedInput: OrcaIncreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress,
      ...(positionMint !== undefined && { positionMint }),
      ...amounts,
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
      ...amounts,
      ...(lowerTick !== undefined && { lowerTick }),
      ...(upperTick !== undefined && { upperTick }),
      tickRange: lowerTick !== undefined && upperTick !== undefined ? { lowerTick, upperTick } : undefined,
      ...(input.rangePreset !== undefined && { rangePreset: input.rangePreset }),
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
    const whirlpoolAddress = parsePublicKey(requireStringParam(action, 'whirlpoolAddress'), 'whirlpoolAddress');
    const positionMint = optionalPublicKey(optionalStringParam(action, 'positionMint'), 'positionMint');
    const tokenAAmount = optionalStringParam(action, 'tokenAAmount');
    const tokenBAmount = optionalStringParam(action, 'tokenBAmount');
    const maxTokenAAmount = optionalStringParam(action, 'maxTokenAAmount');
    const maxTokenBAmount = optionalStringParam(action, 'maxTokenBAmount');
    const slippageBps = validateSlippageBps(optionalNumberParam(action, 'slippageBps'), ctx.config.mainnet.maxSlippageBps);
    validateIncreaseAmount({ tokenAAmount, tokenBAmount, maxTokenAAmount, maxTokenBAmount });
    const snapshot = await getWhirlpoolSnapshot(ctx, whirlpoolAddress);
    let lowerTick = optionalNumberParam(action, 'lowerTick');
    let upperTick = optionalNumberParam(action, 'upperTick');
    if (positionMint) {
      const position = await getPositionDetail(ctx, { positionMint, whirlpoolAddress });
      ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
      lowerTick = position.tickLowerIndex;
      upperTick = position.tickUpperIndex;
    } else {
      const range = validateTickRange(lowerTick, upperTick, snapshot.tickSpacing);
      lowerTick = range.lowerTick;
      upperTick = range.upperTick;
    }
    const input: OrcaIncreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress,
      ...(positionMint !== undefined && { positionMint }),
      ...(tokenAAmount !== undefined && { tokenAAmount }),
      ...(tokenBAmount !== undefined && { tokenBAmount }),
      ...(maxTokenAAmount !== undefined && { maxTokenAAmount }),
      ...(maxTokenBAmount !== undefined && { maxTokenBAmount }),
      ...(lowerTick !== undefined && { lowerTick }),
      ...(upperTick !== undefined && { upperTick }),
      slippageBps,
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
    if (input.liquidityAmount !== undefined) validatePositiveIntegerString(input.liquidityAmount, 'liquidityAmount');
    if (input.minTokenAAmount !== undefined) validatePositiveDecimalString(input.minTokenAAmount, 'minTokenAAmount');
    if (input.minTokenBAmount !== undefined) validatePositiveDecimalString(input.minTokenBAmount, 'minTokenBAmount');

    const snapshot = await getWhirlpoolSnapshot(ctx, whirlpoolAddress);
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
      warnings: uniqueStrings([...(preview.warnings ?? []), ...rangeWarnings(snapshot.currentTickIndex, position.tickLowerIndex, position.tickUpperIndex), ...(position.warnings ?? [])]),
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
    const whirlpoolAddress = parsePublicKey(requireStringParam(action, 'whirlpoolAddress'), 'whirlpoolAddress');
    const positionMint = parsePublicKey(requireStringParam(action, 'positionMint'), 'positionMint');
    const liquidityPercent = validateLiquidityPercent(optionalNumberParam(action, 'liquidityPercent'));
    const liquidityAmount = optionalStringParam(action, 'liquidityAmount');
    const minTokenAAmount = optionalStringParam(action, 'minTokenAAmount');
    const minTokenBAmount = optionalStringParam(action, 'minTokenBAmount');
    const slippageBps = validateSlippageBps(optionalNumberParam(action, 'slippageBps'), ctx.config.mainnet.maxSlippageBps);
    validateExactDecreaseAmountChoice({ liquidityPercent, liquidityAmount });
    if (liquidityAmount !== undefined) validatePositiveIntegerString(liquidityAmount, 'liquidityAmount');
    if (minTokenAAmount !== undefined) validatePositiveDecimalString(minTokenAAmount, 'minTokenAAmount');
    if (minTokenBAmount !== undefined) validatePositiveDecimalString(minTokenBAmount, 'minTokenBAmount');
    await getWhirlpoolSnapshot(ctx, whirlpoolAddress);
    const position = await getPositionDetail(ctx, { positionMint, whirlpoolAddress });
    ensurePositionMatchesWhirlpool(position, whirlpoolAddress);
    const input: OrcaDecreaseLiquidityInput = {
      walletAddress,
      whirlpoolAddress,
      positionMint,
      ...(liquidityPercent !== undefined && { liquidityPercent }),
      ...(liquidityAmount !== undefined && { liquidityAmount }),
      ...(minTokenAAmount !== undefined && { minTokenAAmount }),
      ...(minTokenBAmount !== undefined && { minTokenBAmount }),
      slippageBps,
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

function validateIncreaseAmount(input: Pick<
  OrcaIncreaseLiquidityPrepareInput,
  'tokenAAmount' | 'tokenBAmount' | 'maxTokenAAmount' | 'maxTokenBAmount'
>): void {
  const values = [
    ['tokenAAmount', input.tokenAAmount],
    ['tokenBAmount', input.tokenBAmount],
    ['maxTokenAAmount', input.maxTokenAAmount],
    ['maxTokenBAmount', input.maxTokenBAmount],
  ] as const;
  let found = 0;
  for (const [field, value] of values) {
    if (value !== undefined && value.trim() !== '') {
      found += 1;
      validatePositiveDecimalString(value, field);
    }
  }
  if (found === 0) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'missing_amount',
      'Provide tokenAAmount, tokenBAmount, maxTokenAAmount, or maxTokenBAmount for an Orca increase-liquidity action.',
    );
  }
  if (found > 1) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'invalid_amount',
      'Provide exactly one Orca increase-liquidity amount field.',
    );
  }
}

type OrcaIncreaseAmounts = Pick<
  OrcaIncreaseLiquidityPrepareInput,
  'tokenAAmount' | 'tokenBAmount' | 'maxTokenAAmount' | 'maxTokenBAmount'
>;

function normalizeIncreaseAmounts(input: OrcaIncreaseLiquidityPrepareInput): OrcaIncreaseAmounts {
  const hasNativeAmount = [input.tokenAAmount, input.tokenBAmount, input.maxTokenAAmount, input.maxTokenBAmount]
    .some((value) => typeof value === 'string' && value.trim() !== '');
  if (hasNativeAmount) {
    return {
      ...(input.tokenAAmount !== undefined && { tokenAAmount: input.tokenAAmount }),
      ...(input.tokenBAmount !== undefined && { tokenBAmount: input.tokenBAmount }),
      ...(input.maxTokenAAmount !== undefined && { maxTokenAAmount: input.maxTokenAAmount }),
      ...(input.maxTokenBAmount !== undefined && { maxTokenBAmount: input.maxTokenBAmount }),
    };
  }
  const amount = input.amount?.trim();
  if (!amount) return {};
  return input.amountSide === 'tokenB'
    ? { tokenBAmount: amount }
    : { tokenAAmount: amount };
}

const ORCA_MIN_TICK_INDEX = -443_636;
const ORCA_MAX_TICK_INDEX = 443_636;

function resolveOrcaTickRange(
  input: OrcaIncreaseLiquidityPrepareInput,
  snapshot: { currentTickIndex: number; tickSpacing: number },
): { lowerTick: number; upperTick: number } {
  const manualLower = numberLike(input.lowerTick);
  const manualUpper = numberLike(input.upperTick);
  if (manualLower !== undefined || manualUpper !== undefined) {
    return validateTickRange(manualLower, manualUpper, snapshot.tickSpacing);
  }

  const tickSpacing = Number.isInteger(snapshot.tickSpacing) && snapshot.tickSpacing > 0
    ? snapshot.tickSpacing
    : 1;
  const halfSteps = orcaRangePresetHalfSteps(input.rangePreset);
  const center = alignTickDown(snapshot.currentTickIndex, tickSpacing);
  const minTick = alignTickUp(ORCA_MIN_TICK_INDEX, tickSpacing);
  const maxTick = alignTickDown(ORCA_MAX_TICK_INDEX, tickSpacing);
  let lowerTick = alignTickDown(center - halfSteps * tickSpacing, tickSpacing);
  let upperTick = alignTickUp(center + halfSteps * tickSpacing, tickSpacing);
  lowerTick = Math.max(lowerTick, minTick);
  upperTick = Math.min(upperTick, maxTick);
  if (upperTick <= snapshot.currentTickIndex) upperTick = Math.min(maxTick, upperTick + tickSpacing);
  if (lowerTick >= snapshot.currentTickIndex) lowerTick = Math.max(minTick, lowerTick - tickSpacing);
  return validateTickRange(lowerTick, upperTick, tickSpacing);
}

function orcaRangePresetHalfSteps(value: string | undefined): number {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'narrow') return 8;
  if (normalized === 'wide') return 128;
  return 32;
}

function numberLike(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function alignTickDown(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

function alignTickUp(tick: number, tickSpacing: number): number {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

function validatePositiveDecimalString(value: string, field: string): void {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', `${field} must be a positive decimal string.`);
  }
}

function validatePositiveIntegerString(value: string, field: string): void {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_amount', `${field} must be a positive integer string.`);
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
