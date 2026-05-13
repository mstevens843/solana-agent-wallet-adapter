import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import { parseDecimalAmount } from '../../amounts.js';
import type { PreparedAction } from '../../preparedActions.js';
import { AdapterError } from '../types.js';
import { SAVE_ADAPTER_ID } from './constants.js';

export function requireString(action: PreparedAction, key: string): string {
  const value = action.params[key];
  if (typeof value !== 'string' || !value) {
    throw new ProtocolError('invalid_request', `Save action ${action.id} is missing ${key}.`);
  }
  return value;
}

export function requireOptionalString(action: PreparedAction, key: string): string | undefined {
  const value = action.params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ProtocolError('invalid_request', `Save action ${action.id} has non-string ${key}.`);
  }
  return value;
}

export function requireNumber(action: PreparedAction, key: string): number {
  const value = action.params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('invalid_request', `Save action ${action.id} is missing numeric ${key}.`);
  }
  return value;
}

export function optionalNumber(action: PreparedAction, key: string): number | undefined {
  const value = action.params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('invalid_request', `Save action ${action.id} has non-numeric ${key}.`);
  }
  return value;
}

export function requireBoolean(action: PreparedAction, key: string, fallback = false): boolean {
  const value = action.params[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new ProtocolError('invalid_request', `Save action ${action.id} has non-boolean ${key}.`);
  }
  return value;
}

/**
 * Throws `exceeds_cap` if `amountRaw` is greater than the SDK-reported cap.
 * The cap arrives as a UI-decimal string. Missing/blank/`-1` is treated as
 * "no cap reported"; `"0"` means "no capacity remaining" and refuses the
 * action.
 */
export function assertWithinCap(args: {
  amountRaw: bigint;
  capUi: string | undefined;
  decimals: number;
  reserveSymbol: string;
  operation: 'deposit' | 'borrow';
}): void {
  const capUi = args.capUi?.trim();
  if (!capUi || capUi === '-1') return;
  if (capUi === '0' || /^0+(\.0+)?$/.test(capUi)) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'exceeds_cap',
      `Save ${args.operation} blocked: ${args.reserveSymbol} reports no remaining ${args.operation} capacity.`,
    );
  }
  let capRaw: bigint;
  try {
    capRaw = parseDecimalAmount(capUi, args.decimals, `${args.reserveSymbol} ${args.operation} cap`);
  } catch {
    return; // unparseable cap → don't block; downstream SDK will refuse.
  }
  if (args.amountRaw > capRaw) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'exceeds_cap',
      `Save ${args.operation} blocked: requested amount exceeds ${args.reserveSymbol} ${args.operation} capacity (${capUi}).`,
    );
  }
}
