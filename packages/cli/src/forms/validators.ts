// Validators shared across new-* and repeat-* forms. Keep the rules forgiving
// — the bridge will re-validate before signing, so the CLI's job is just to
// reject obviously bad input early.

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POSITIVE_DECIMAL_RE = /^(\d+(\.\d+)?|\.\d+)$/;
const SLIPPAGE_RE = /^\d+$/;

export function validateBase58(value: string): boolean | string {
  return BASE58_RE.test(value.trim()) || 'Must be a base58 Solana address (32–44 chars).';
}

export function validatePositiveDecimal(value: string): boolean | string {
  const trimmed = value.trim();
  if (!POSITIVE_DECIMAL_RE.test(trimmed)) return 'Must be a positive decimal (e.g. 0.01).';
  if (Number(trimmed) <= 0) return 'Must be greater than zero.';
  return true;
}

export function validatePositiveInteger(value: string): boolean | string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 'Must be a non-negative integer.';
  return true;
}

export function validateSlippageBps(value: string): boolean | string {
  if (!value.trim()) return true;
  if (!SLIPPAGE_RE.test(value.trim())) return 'Slippage must be an integer in basis points (e.g. 50 = 0.5%).';
  const n = Number(value);
  if (n < 0 || n > 10_000) return 'Slippage must be between 0 and 10000 bps.';
  return true;
}

export function validateNonEmpty(value: string): boolean | string {
  return value.trim().length > 0 || 'Required field.';
}

// HH:MM, 24-hour. Accepts H:MM and HH:MM so users don't have to zero-pad.
const CLOCK_RE = /^(\d{1,2}):([0-5]\d)$/;
export function validateClockTime(value: string): boolean | string {
  const trimmed = value.trim();
  if (!trimmed) return true; // optional everywhere we use it
  const m = CLOCK_RE.exec(trimmed);
  if (!m) return 'Use HH:MM (24-hour), e.g. 09:00 or 14:30.';
  const hour = Number(m[1]);
  if (hour < 0 || hour > 23) return 'Hour must be 0–23.';
  return true;
}
