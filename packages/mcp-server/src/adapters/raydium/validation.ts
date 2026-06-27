import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';
import { RAYDIUM_ADAPTER_ID } from './constants.js';
import type { RaydiumLiquidityPoolType, RaydiumPoolSnapshot, RaydiumPoolType } from './client.js';

export function parsePublicKey(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new AdapterError(RAYDIUM_ADAPTER_ID, 'missing_input', `${field} is required.`);
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_public_key', `${field} must be a valid Solana public key.`);
  }
}

export function optionalPublicKey(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return parsePublicKey(value, field);
}

export function parsePoolType(value: string | undefined, defaultType: RaydiumLiquidityPoolType = 'cpmm'): RaydiumLiquidityPoolType {
  const normalized = (value ?? defaultType).trim().toLowerCase();
  if (normalized === 'cpmm' || normalized === 'clmm') return normalized;
  throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_pool_type', 'Raydium poolType must be cpmm or clmm.');
}

export function parseReadPoolType(value: string | undefined): RaydiumPoolType | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cpmm' || normalized === 'clmm' || normalized === 'amm_v4') return normalized;
  throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_pool_type', 'Raydium read poolType must be cpmm, clmm, or amm_v4.');
}

export function parsePositionPoolType(value: string | undefined): RaydiumLiquidityPoolType | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cpmm' || normalized === 'clmm') return normalized;
  throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_pool_type', 'Raydium wallet position poolType must be cpmm or clmm.');
}

// Omitted slippage = the connector's safe default (1%), NOT the cap — so an empty LP slippage never
// inherits a large maxSlippageBps (e.g. 5000 bps / 50%). A provided value is still capped below.
const DEFAULT_DEX_SLIPPAGE_BPS = 100;

export function validateSlippageBps(value: number | undefined, maxSlippageBps: number): number {
  const slippageBps = value ?? Math.min(maxSlippageBps, DEFAULT_DEX_SLIPPAGE_BPS);
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_slippage', 'slippageBps must be a non-negative integer.');
  }
  if (slippageBps > maxSlippageBps) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'invalid_slippage',
      `slippageBps ${slippageBps} exceeds configured max ${maxSlippageBps}.`,
    );
  }
  return slippageBps;
}

export function validatePositiveDecimalString(value: string, field: string): void {
  const trimmed = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(trimmed) || Number(trimmed) <= 0) {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_amount', `${field} must be a positive decimal string.`);
  }
}

export function validateOptionalPositiveDecimalString(value: string | undefined, field: string): void {
  if (value !== undefined && value.trim() !== '') validatePositiveDecimalString(value, field);
}

export function validatePositiveIntegerString(value: string, field: string): void {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_amount', `${field} must be a positive unsigned integer string.`);
  }
}

export function validateOptionalPositiveIntegerString(value: string | undefined, field: string): void {
  if (value !== undefined && value.trim() !== '') validatePositiveIntegerString(value, field);
}

export function validateLiquidityPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'invalid_liquidity_percent',
      'liquidityPercent must be greater than 0 and at most 100.',
    );
  }
  return value;
}

export function validateDecreaseAmountChoice(input: {
  liquidityPercent?: number;
  liquidityAmount?: string;
}): void {
  const hasPercent = input.liquidityPercent !== undefined;
  const hasAmount = typeof input.liquidityAmount === 'string' && input.liquidityAmount.trim() !== '';
  if (hasPercent === hasAmount) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'invalid_liquidity_amount',
      'Provide exactly one of liquidityPercent or liquidityAmount for Raydium remove-liquidity.',
    );
  }
}

export function validateRemoveLiquidityAmount(input: {
  poolType: RaydiumLiquidityPoolType;
  liquidityAmount?: string;
}): void {
  if (input.poolType === 'clmm') {
    validateOptionalPositiveIntegerString(input.liquidityAmount, 'liquidityAmount');
  } else {
    validateOptionalPositiveDecimalString(input.liquidityAmount, 'liquidityAmount');
  }
}

export function validateAddAmounts(
  input: {
    poolType: RaydiumLiquidityPoolType;
    tokenAAmount?: string;
    tokenBAmount?: string;
    maxTokenAAmount?: string;
    maxTokenBAmount?: string;
    positionMint?: string;
    lowerTick?: number;
    upperTick?: number;
    lowerPrice?: string;
    upperPrice?: string;
  },
  options: { requireClmmMax?: boolean } = {},
): void {
  const requireClmmMax = options.requireClmmMax !== false;
  validateOptionalPositiveDecimalString(input.tokenAAmount, 'tokenAAmount');
  validateOptionalPositiveDecimalString(input.tokenBAmount, 'tokenBAmount');
  validateOptionalPositiveDecimalString(input.maxTokenAAmount, 'maxTokenAAmount');
  validateOptionalPositiveDecimalString(input.maxTokenBAmount, 'maxTokenBAmount');
  const hasTokenA = Boolean(input.tokenAAmount?.trim());
  const hasTokenB = Boolean(input.tokenBAmount?.trim());
  if (hasTokenA === hasTokenB) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'invalid_amount',
      'Provide exactly one of tokenAAmount or tokenBAmount for Raydium add-liquidity.',
    );
  }
  if (input.poolType === 'clmm') {
    if (requireClmmMax) {
      if (hasTokenA && !input.maxTokenBAmount?.trim()) {
        throw new AdapterError(RAYDIUM_ADAPTER_ID, 'missing_amount', 'maxTokenBAmount is required when tokenAAmount is the CLMM base amount.');
      }
      if (hasTokenB && !input.maxTokenAAmount?.trim()) {
        throw new AdapterError(RAYDIUM_ADAPTER_ID, 'missing_amount', 'maxTokenAAmount is required when tokenBAmount is the CLMM base amount.');
      }
    }
    if (!input.positionMint) {
      validateClmmRange(input);
    }
  }
}

export function validateClmmRange(input: {
  lowerTick?: number;
  upperTick?: number;
  lowerPrice?: string;
  upperPrice?: string;
}): void {
  const hasTicks = Number.isInteger(input.lowerTick) && Number.isInteger(input.upperTick);
  const hasPrices = Boolean(input.lowerPrice?.trim()) && Boolean(input.upperPrice?.trim());
  if (!hasTicks && !hasPrices) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'missing_range',
      'lowerTick/upperTick or lowerPrice/upperPrice are required when opening a new Raydium CLMM position.',
    );
  }
  if (hasTicks && (input.lowerTick as number) >= (input.upperTick as number)) {
    throw new AdapterError(RAYDIUM_ADAPTER_ID, 'invalid_range', 'lowerTick must be less than upperTick.');
  }
  validateOptionalPositiveDecimalString(input.lowerPrice, 'lowerPrice');
  validateOptionalPositiveDecimalString(input.upperPrice, 'upperPrice');
}

export function assertPoolType(snapshot: RaydiumPoolSnapshot, expected: RaydiumLiquidityPoolType): void {
  if (snapshot.poolType !== expected) {
    throw new AdapterError(
      RAYDIUM_ADAPTER_ID,
      'pool_type_mismatch',
      `Raydium pool ${snapshot.poolId} is ${snapshot.poolType}, not ${expected}.`,
    );
  }
}

export function requireStringParam(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Raydium action ${action.id} is missing ${key}.`);
  }
  return value.trim();
}

export function optionalStringParam(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalNumberParam(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function optionalBooleanParam(action: PreparedAction, key: string): boolean | undefined {
  const value = action.params[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
