import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';
import { ORCA_ADAPTER_ID, WHIRLPOOL_PROGRAM_ID } from './constants.js';
import type { OrcaPosition, OrcaWhirlpoolSnapshot } from './client.js';

export function parsePublicKey(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'missing_input', `${field} is required.`);
  }
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_public_key', `${field} must be a valid Solana public key.`);
  }
}

export function optionalPublicKey(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return parsePublicKey(value, field);
}

export function assertKnownWhirlpoolProgram(snapshot: OrcaWhirlpoolSnapshot): void {
  if (snapshot.programId !== WHIRLPOOL_PROGRAM_ID.toBase58()) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'unknown_program_id',
      `Unknown Orca Whirlpool program id ${snapshot.programId}.`,
    );
  }
}

export function validateTickRange(lowerTick: number | undefined, upperTick: number | undefined, tickSpacing?: number): {
  lowerTick: number;
  upperTick: number;
} {
  if (
    typeof lowerTick !== 'number' ||
    typeof upperTick !== 'number' ||
    !Number.isInteger(lowerTick) ||
    !Number.isInteger(upperTick)
  ) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'missing_tick_range',
      'lowerTick and upperTick are required when opening a new Orca position.',
    );
  }
  const lower = lowerTick;
  const upper = upperTick;
  if (lower >= upper) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_tick_range', 'lowerTick must be less than upperTick.');
  }
  if (tickSpacing && tickSpacing > 0 && (lower % tickSpacing !== 0 || upper % tickSpacing !== 0)) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'invalid_tick_spacing',
      `Tick range must align to Whirlpool tick spacing ${tickSpacing}.`,
    );
  }
  return { lowerTick: lower, upperTick: upper };
}

// Omitted slippage = the connector's safe default (1%), NOT the cap — so an empty LP slippage never
// inherits a large maxSlippageBps (e.g. 5000 bps / 50%). A provided value is still capped below.
const DEFAULT_DEX_SLIPPAGE_BPS = 100;

export function validateSlippageBps(value: number | undefined, maxSlippageBps: number): number {
  const slippageBps = value ?? Math.min(maxSlippageBps, DEFAULT_DEX_SLIPPAGE_BPS);
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_slippage', 'slippageBps must be a non-negative integer.');
  }
  if (slippageBps > maxSlippageBps) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'invalid_slippage',
      `slippageBps ${slippageBps} exceeds configured max ${maxSlippageBps}.`,
    );
  }
  return slippageBps;
}

export function validateLiquidityPercent(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new AdapterError(ORCA_ADAPTER_ID, 'invalid_liquidity_percent', 'liquidityPercent must be greater than 0 and at most 100.');
  }
  return value;
}

export function validateExactDecreaseAmountChoice(input: {
  liquidityPercent?: number;
  liquidityAmount?: string;
}): void {
  const hasPercent = input.liquidityPercent !== undefined;
  const hasAmount = typeof input.liquidityAmount === 'string' && input.liquidityAmount.trim() !== '';
  if (hasPercent === hasAmount) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'invalid_liquidity_amount',
      'Provide exactly one of liquidityPercent or liquidityAmount for an Orca decrease-liquidity action.',
    );
  }
}

export function ensurePositionMatchesWhirlpool(position: OrcaPosition, whirlpoolAddress: string | undefined): void {
  if (!whirlpoolAddress) return;
  if (position.whirlpoolAddress !== whirlpoolAddress) {
    throw new AdapterError(
      ORCA_ADAPTER_ID,
      'position_pool_mismatch',
      `Position belongs to Whirlpool ${position.whirlpoolAddress}, not ${whirlpoolAddress}.`,
    );
  }
}

export function requireStringParam(action: { id: string; params: Record<string, unknown> }, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Orca action ${action.id} is missing ${key}.`);
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
