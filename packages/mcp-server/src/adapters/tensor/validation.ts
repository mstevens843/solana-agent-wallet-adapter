import { PublicKey } from '@solana/web3.js';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { AdapterError } from '../types.js';
import { LAMPORTS_PER_SOL, MAX_SWEEP_ITEMS, TENSOR_ADAPTER_ID } from './constants.js';

export function parsePublicKey(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(TENSOR_ADAPTER_ID, 'missing_input', `${field} is required.`);
  }
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_public_key',
      `${field} must be a valid Solana public key.`,
    );
  }
}

export function optionalPublicKey(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return parsePublicKey(value, field);
}

export interface MintOrAssetIdInput {
  mintAddress?: string;
  assetId?: string;
}

export interface MintOrAssetIdResolved {
  mintAddress?: string;
  assetId?: string;
}

export function requireMintOrAssetId(
  input: MintOrAssetIdInput,
  field = 'mintAddress or assetId',
): MintOrAssetIdResolved {
  const mint = optionalPublicKey(input.mintAddress, 'mintAddress');
  const asset = optionalPublicKey(input.assetId, 'assetId');
  if (!mint && !asset) {
    throw new AdapterError(TENSOR_ADAPTER_ID, 'missing_input', `${field} is required.`);
  }
  if (mint && asset) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_input',
      'Provide exactly one of mintAddress or assetId, not both.',
    );
  }
  return {
    ...(mint !== undefined && { mintAddress: mint }),
    ...(asset !== undefined && { assetId: asset }),
  };
}

export function parseSolDecimal(
  value: string | undefined,
  field: string,
): { priceLamports: bigint; priceSol: string } {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new AdapterError(TENSOR_ADAPTER_ID, 'missing_input', `${field} is required.`);
  }
  if (!/^(?:\d+|\d*\.\d+|\d+\.)$/.test(trimmed)) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_amount',
      `${field} must be a non-negative decimal string in SOL.`,
    );
  }
  const parts = trimmed.split('.');
  const wholeRaw = parts[0] ?? '0';
  const fractionRaw = parts[1] ?? '';
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const fraction = (fractionRaw + '000000000').slice(0, 9);
  let lamports: bigint;
  try {
    lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction);
  } catch {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_amount',
      `${field} must be a non-negative decimal string in SOL.`,
    );
  }
  if (lamports <= 0n) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_amount',
      `${field} must be greater than 0 SOL.`,
    );
  }
  return { priceLamports: lamports, priceSol: trimmed };
}

export function assertNotMoreThanMaxSweep(itemCount: number): void {
  if (itemCount <= 0) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_input',
      'sweep requires at least one item.',
    );
  }
  if (itemCount > MAX_SWEEP_ITEMS) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'too_many_items',
      `Tensor sweep supports at most ${MAX_SWEEP_ITEMS} items in v1; received ${itemCount}.`,
    );
  }
}

export function assertCompressedHomogeneous(items: Array<{ compressed: boolean }>): boolean {
  if (items.length === 0) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_input',
      'sweep requires at least one item.',
    );
  }
  const first = items[0]!.compressed;
  if (items.some((item) => item.compressed !== first)) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'mixed_compressed',
      'Tensor sweep does not support mixing legacy and compressed NFTs in v1. Submit two separate sweeps.',
    );
  }
  return first;
}

export function parseExpiresAt(value: string | undefined, field = 'expiresAt'): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_date',
      `${field} must be a valid ISO timestamp.`,
    );
  }
  if (date.getTime() <= Date.now()) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_date',
      `${field} must be in the future.`,
    );
  }
  return date.toISOString();
}

export function parsePositiveQuantity(value: number | undefined, field = 'quantity'): number {
  const n = value ?? 1;
  if (!Number.isInteger(n) || n <= 0) {
    throw new AdapterError(
      TENSOR_ADAPTER_ID,
      'invalid_quantity',
      `${field} must be a positive integer.`,
    );
  }
  return n;
}

export function requireStringParam(
  action: { id: string; params: Record<string, unknown> },
  key: string,
): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `Tensor action ${action.id} is missing ${key}.`);
  }
  return value.trim();
}

export function optionalStringParam(
  action: { params: Record<string, unknown> },
  key: string,
): string | undefined {
  const value = action.params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalNumberParam(
  action: { params: Record<string, unknown> },
  key: string,
): number | undefined {
  const value = action.params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function optionalBooleanParam(
  action: { params: Record<string, unknown> },
  key: string,
): boolean | undefined {
  const value = action.params[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function requireArrayParam<T>(
  action: { id: string; params: Record<string, unknown> },
  key: string,
): T[] {
  const value = action.params[key];
  if (!Array.isArray(value)) {
    throw new ProtocolError('invalid_request', `Tensor action ${action.id} is missing ${key}.`);
  }
  return value as T[];
}

export function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function sumLamports(values: Iterable<string | bigint>): bigint {
  let total = 0n;
  for (const value of values) {
    total += typeof value === 'bigint' ? value : BigInt(value);
  }
  return total;
}
