import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';
import { METEORA_ADAPTER_ID, METEORA_DLMM_PROGRAM_ID } from './constants.js';
import type { MeteoraPoolSnapshot, MeteoraPosition } from './client.js';

export function parsePublicKey(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'missing_input', `${field} is required.`);
  }
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_public_key', `${field} must be a valid Solana public key.`);
  }
}

export function optionalPublicKey(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return parsePublicKey(value, field);
}

export function assertKnownDlmmProgram(snapshot: MeteoraPoolSnapshot): void {
  if (snapshot.programId !== METEORA_DLMM_PROGRAM_ID.toBase58()) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'unknown_program_id',
      `Unknown Meteora DLMM program id ${snapshot.programId}.`,
    );
  }
}

export function validateBinRange(minBinId: number | undefined, maxBinId: number | undefined): {
  minBinId: number;
  maxBinId: number;
} {
  if (
    typeof minBinId !== 'number' ||
    typeof maxBinId !== 'number' ||
    !Number.isInteger(minBinId) ||
    !Number.isInteger(maxBinId)
  ) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'missing_bin_range', 'minBinId and maxBinId are required.');
  }
  const min = minBinId;
  const max = maxBinId;
  if (min > max) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_bin_range', 'minBinId must be less than or equal to maxBinId.');
  }
  return { minBinId: min, maxBinId: max };
}

// Omitted slippage = the connector's safe default (1%), NOT the cap — so an empty LP slippage never
// inherits a large maxSlippageBps (e.g. 5000 bps / 50%). A provided value is still capped below.
const DEFAULT_DEX_SLIPPAGE_BPS = 100;

export function validateSlippageBps(value: number | undefined, maxSlippageBps: number): number {
  const slippageBps = value ?? Math.min(maxSlippageBps, DEFAULT_DEX_SLIPPAGE_BPS);
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_slippage', 'slippageBps must be a non-negative integer.');
  }
  if (slippageBps > maxSlippageBps) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'invalid_slippage',
      `slippageBps ${slippageBps} exceeds configured max ${maxSlippageBps}.`,
    );
  }
  return slippageBps;
}

export function validateLiquidityBps(input: { liquidityBps?: number; liquidityPercent?: number }): number {
  const hasBps = input.liquidityBps !== undefined;
  const hasPercent = input.liquidityPercent !== undefined;
  if (hasBps === hasPercent) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'invalid_liquidity_amount',
      'Provide exactly one of liquidityBps or liquidityPercent for a Meteora remove-liquidity action.',
    );
  }
  const liquidityBps = hasBps ? input.liquidityBps! : Math.round(input.liquidityPercent! * 100);
  if (!Number.isInteger(liquidityBps) || liquidityBps <= 0 || liquidityBps > 10_000) {
    throw new AdapterError(METEORA_ADAPTER_ID, 'invalid_liquidity_bps', 'liquidity must be greater than 0 and at most 100 percent.');
  }
  return liquidityBps;
}

export function ensurePositionMatchesPool(position: MeteoraPosition, poolAddress: string | undefined): void {
  if (!poolAddress) return;
  if (position.poolAddress !== poolAddress) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'position_pool_mismatch',
      `Position belongs to Meteora pool ${position.poolAddress}, not ${poolAddress}.`,
    );
  }
}

export function ensurePositionOwnedByWallet(position: MeteoraPosition, walletAddress: string): void {
  if (!position.owner) return;
  if (position.owner !== walletAddress) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'position_owner_mismatch',
      `Position belongs to wallet ${position.owner}, not ${walletAddress}.`,
    );
  }
}

export function ensureBinRangeWithinPosition(
  position: MeteoraPosition,
  minBinId: number,
  maxBinId: number,
): void {
  if (minBinId < position.lowerBinId || maxBinId > position.upperBinId) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'bin_range_outside_position',
      `Requested bin range ${minBinId}-${maxBinId} is outside position range ${position.lowerBinId}-${position.upperBinId}.`,
    );
  }
}

export function ensureEmptyPosition(position: MeteoraPosition): void {
  if (!isZeroish(position.liquidity)) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'position_not_empty',
      'Meteora close position is only supported for empty positions. Remove liquidity first, then prepare close.',
    );
  }
}

export function ensureNoClaimableAmounts(position: MeteoraPosition): void {
  const hasFees = (position.feesOwed ?? []).some((amount) => !isZeroish(amount.rawAmount ?? amount.amount));
  const hasRewards = (position.rewardsOwed ?? []).some((amount) => !isZeroish(amount.rawAmount ?? amount.amount));
  if (hasFees || hasRewards) {
    throw new AdapterError(
      METEORA_ADAPTER_ID,
      'position_has_claimable_amounts',
      'Meteora close position requires no claimable fees or rewards. Claim fees and rewards first, then prepare close.',
    );
  }
}

export function requireStringParam(action: { id: string; params: Record<string, unknown> }, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Meteora action ${action.id} is missing ${key}.`);
  }
  return value.trim();
}

export function optionalStringParam(action: { params: Record<string, unknown> }, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalNumberParam(action: { params: Record<string, unknown> }, key: string): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isZeroish(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'bigint') return value === 0n;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed) === 0n;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed === 0 : false;
  }
  return false;
}
