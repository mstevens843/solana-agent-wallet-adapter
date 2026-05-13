import { PublicKey } from '@solana/web3.js';
import { ProtocolError } from '@solana-agent-wallet-adapter/core';
import { Decimal } from 'decimal.js';

import { parseDecimalAmount } from '../../amounts.js';
import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';
import {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_SOURCE_CHAIN,
  normalizeWormholeChain,
  normalizeWormholeRouteType,
  type WormholeRouteType,
} from './constants.js';

export interface NormalizedWormholeAmount {
  amount: string;
  amountRaw: string;
  decimals: number;
}

export function requireNonEmptyString(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_request', `Wormhole ${field} is required.`);
  }
  return trimmed;
}

export function optionalNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeSourceChain(value: string | undefined): string {
  const chain = value?.trim() || WORMHOLE_SOURCE_CHAIN;
  if (chain.toLowerCase() !== WORMHOLE_SOURCE_CHAIN.toLowerCase()) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'unsupported_source_chain',
      'Wormhole v1 only prepares Solana-source bridge actions.',
    );
  }
  return WORMHOLE_SOURCE_CHAIN;
}

export function normalizeDestinationChain(value: string | undefined): string {
  return normalizeWormholeChain(value, 'destinationChain');
}

export function normalizeRouteType(value: string | undefined): WormholeRouteType {
  try {
    return normalizeWormholeRouteType(value);
  } catch (err) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'unsupported_route', err instanceof Error ? err.message : String(err));
  }
}

export function normalizeMint(value: string | undefined, field = 'sourceMint'): string {
  const mint = requireNonEmptyString(value, field);
  if (mint.toLowerCase() === 'native' || mint.toUpperCase() === 'SOL') return 'native';
  try {
    return new PublicKey(mint).toBase58();
  } catch {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_mint', `Wormhole ${field} must be a Solana mint address or native.`);
  }
}

export async function normalizeWormholeAmount(input: {
  connection: { getParsedAccountInfo?: (...args: any[]) => Promise<any> };
  sourceMint: string;
  amount: string;
}): Promise<NormalizedWormholeAmount> {
  const decimals = await resolveMintDecimals(input.connection, input.sourceMint);
  const raw = parseDecimalAmount(input.amount, decimals, 'Wormhole transfer amount');
  return {
    amount: input.amount,
    amountRaw: raw.toString(),
    decimals,
  };
}

export async function resolveMintDecimals(
  connection: { getParsedAccountInfo?: (...args: any[]) => Promise<any> },
  mintAddress: string,
): Promise<number> {
  if (mintAddress === 'native') return 9;
  try {
    const info = await connection.getParsedAccountInfo?.(new PublicKey(mintAddress));
    const decimals = info?.value?.data?.parsed?.info?.decimals;
    if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0) return decimals;
  } catch {
    // Fall through to the conservative default used by the token registry for USDC-like assets.
  }
  return 6;
}

export function validateDestinationAddress(chain: string, address: string): string {
  const value = requireNonEmptyString(address, 'destinationAddress');
  const normalized = chain.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'solana') {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_destination_address', 'Destination Solana address is invalid.');
    }
  }
  if (isEvmChain(normalized)) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
      throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_destination_address', `${chain} destination address must be a 20-byte hex address.`);
    }
    return value;
  }
  if (normalized === 'sui') {
    if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
      throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_destination_address', 'Sui destination address must be a 32-byte hex address.');
    }
    return value;
  }
  if (normalized === 'aptos') {
    if (!/^0x[a-fA-F0-9]{1,64}$/.test(value)) {
      throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_destination_address', 'Aptos destination address must be a hex account address.');
    }
    return value;
  }
  return value;
}

export function assertDecimalAtMost(input: {
  actual?: string;
  cap?: string;
  code: string;
  label: string;
}): void {
  const actual = decimalOrUndefined(input.actual);
  const cap = decimalOrUndefined(input.cap);
  if (!actual || !cap) return;
  if (actual.gt(cap)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      input.code,
      `Wormhole ${input.label} ${actual.toString()} exceeds cap ${cap.toString()}.`,
    );
  }
}

export function assertDecimalAtLeast(input: {
  actual?: string;
  floor?: string;
  code: string;
  label: string;
}): void {
  const actual = decimalOrUndefined(input.actual);
  const floor = decimalOrUndefined(input.floor);
  if (!actual || !floor) return;
  if (actual.lt(floor)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      input.code,
      `Wormhole ${input.label} ${actual.toString()} is below minimum ${floor.toString()}.`,
    );
  }
}

export function assertFreshIso(asOfIso: string | undefined, maxAgeMs: number): void {
  if (!asOfIso) return;
  const asOf = new Date(asOfIso).getTime();
  if (!Number.isFinite(asOf)) return;
  if (Date.now() - asOf > maxAgeMs) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'stale_quote', 'Wormhole quote is stale; refresh before approval.');
  }
}

export function requireActionString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Wormhole action ${action.id} is missing ${key}.`);
  }
  return value.trim();
}

export function optionalActionString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function actionRecord(action: PreparedAction, key: string): Record<string, unknown> | undefined {
  const value = action.params[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isEvmChain(normalized: string): boolean {
  return normalized === 'ethereum' ||
    normalized === 'base' ||
    normalized === 'arbitrum' ||
    normalized === 'optimism' ||
    normalized === 'polygon' ||
    normalized === 'avalanche' ||
    normalized === 'bsc' ||
    normalized === 'bnb' ||
    normalized === 'binance';
}

function decimalOrUndefined(value: string | undefined): Decimal | undefined {
  if (!value?.trim()) return undefined;
  try {
    return new Decimal(value.trim());
  } catch {
    return undefined;
  }
}
