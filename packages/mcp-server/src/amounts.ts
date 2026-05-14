import { ProtocolError } from '@solana-agent-wallet-adapter/core';

export function parseDecimalAmount(value: string, decimals: number, label: string): bigint {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolError('invalid_request', `${label} is required.`);
  }
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ProtocolError('invalid_request', `${label} must be a positive decimal string.`);
  }
  const parts = trimmed.split('.');
  const wholeRaw = parts[0] ?? '0';
  const fractionRaw = parts[1] ?? '';
  if (fractionRaw.length > decimals) {
    throw new ProtocolError(
      'invalid_request',
      `${label} has too many decimal places for a ${decimals}-decimal token.`,
    );
  }
  const whole = BigInt(wholeRaw);
  const fractionPadded = fractionRaw.padEnd(decimals, '0');
  const fraction = fractionPadded ? BigInt(fractionPadded) : 0n;
  const scale = 10n ** BigInt(decimals);
  const amount = whole * scale + fraction;
  if (amount <= 0n) {
    throw new ProtocolError('invalid_request', `${label} must be greater than zero.`);
  }
  return amount;
}

export function assertMaxAmount(
  amount: bigint,
  maxDecimal: string,
  decimals: number,
  label: string,
): void {
  const max = parseDecimalAmount(maxDecimal, decimals, `Maximum ${label}`);
  if (amount > max) {
    throw new ProtocolError(
      'unauthorized',
      `${label} exceeds configured cap of ${maxDecimal}. Lower the amount or update agent-wallet.config.json.`,
    );
  }
}

export function formatRawAmount(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) {
    return whole.toString();
  }
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionText}`;
}
