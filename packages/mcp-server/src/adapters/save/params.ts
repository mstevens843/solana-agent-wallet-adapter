import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import type { PreparedAction } from '../../preparedActions.js';

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
