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
  try {
    return normalizeWormholeChain(value, 'destinationChain');
  } catch (err) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_request', err instanceof Error ? err.message : String(err));
  }
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
    amount: input.amount.trim(),
    amountRaw: raw.toString(),
    decimals,
  };
}

export async function resolveMintDecimals(
  connection: { getParsedAccountInfo?: (...args: any[]) => Promise<any> },
  mintAddress: string,
): Promise<number> {
  if (mintAddress === 'native') return 9;
  if (typeof connection.getParsedAccountInfo !== 'function') {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'mint_decimals_unavailable',
      `Wormhole could not resolve decimals for ${mintAddress}; provide an RPC connection with parsed mint account support.`,
    );
  }
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const decimals = info?.value?.data?.parsed?.info?.decimals;
    if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0) return decimals;
  } catch (err) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      'mint_decimals_unavailable',
      `Wormhole could not read decimals for ${mintAddress}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new AdapterError(
    WORMHOLE_ADAPTER_ID,
    'mint_decimals_unavailable',
    `Wormhole could not resolve decimals for ${mintAddress}; the mint account was missing or not parsed.`,
  );
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
  const cap = parseOptionalNonNegativeDecimal(input.cap, `${input.label} cap`);
  if (!cap) return;
  const actual = parseRequiredNonNegativeDecimal(input.actual, input.label, 'missing_quote_fact');
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
  const floor = parseOptionalNonNegativeDecimal(input.floor, `${input.label} minimum`);
  if (!floor) return;
  const actual = parseRequiredNonNegativeDecimal(input.actual, input.label, 'missing_quote_fact');
  if (actual.lt(floor)) {
    throw new AdapterError(
      WORMHOLE_ADAPTER_ID,
      input.code,
      `Wormhole ${input.label} ${actual.toString()} is below minimum ${floor.toString()}.`,
    );
  }
}

export function assertFreshIso(asOfIso: string | undefined, maxAgeMs: number): void {
  const asOf = parseRequiredIso(asOfIso, 'quote asOfIso');
  if (Date.now() - asOf > maxAgeMs) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'stale_quote', 'Wormhole quote is stale; refresh before approval.');
  }
  if (asOf - Date.now() > 30_000) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_quote', 'Wormhole quote timestamp is in the future; refresh before approval.');
  }
}

export function assertNotExpiredIso(expiresAtIso: string | undefined): void {
  if (!expiresAtIso) return;
  const expiresAt = parseRequiredIso(expiresAtIso, 'quote expiresAtIso');
  if (Date.now() > expiresAt) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'stale_quote', 'Wormhole quote is expired; refresh before approval.');
  }
}

export function optionalNonNegativeDecimal(value: string | undefined, field: string): string | undefined {
  const trimmed = optionalNonEmptyString(value);
  if (trimmed === undefined) return undefined;
  parseOptionalNonNegativeDecimal(trimmed, field);
  return trimmed;
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

function parseOptionalNonNegativeDecimal(value: string | undefined, label: string): Decimal | undefined {
  if (!value?.trim()) return undefined;
  return parseRequiredNonNegativeDecimal(value, label, 'invalid_request');
}

function parseRequiredNonNegativeDecimal(
  value: string | undefined,
  label: string,
  code: 'invalid_request' | 'missing_quote_fact',
): Decimal {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, code, `Wormhole ${label} is required for this guard.`);
  }
  try {
    const decimal = new Decimal(trimmed);
    if (!decimal.isFinite() || decimal.isNegative()) {
      throw new Error('not a finite non-negative decimal');
    }
    return decimal;
  } catch {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_request', `Wormhole ${label} must be a non-negative decimal string.`);
  }
}

function parseRequiredIso(value: string | undefined, label: string): number {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_quote', `Wormhole ${label} is missing.`);
  }
  const timestamp = new Date(trimmed).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new AdapterError(WORMHOLE_ADAPTER_ID, 'invalid_quote', `Wormhole ${label} is invalid.`);
  }
  return timestamp;
}
