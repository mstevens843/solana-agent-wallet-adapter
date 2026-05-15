import { SOLANA_ADDRESS_REGEX } from './constants.js';

// Regex-only validation: catches malformed input cheaply. Final curve-point
// check is the wallet's job (no signing succeeds against a bad recipient).
export function isValidSolanaAddress(value: unknown): value is string {
  return typeof value === 'string' && SOLANA_ADDRESS_REGEX.test(value);
}
