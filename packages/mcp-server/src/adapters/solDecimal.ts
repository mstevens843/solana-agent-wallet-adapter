const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface PositiveSolDecimal {
  lamports: bigint;
  sol: string;
}

export function parsePositiveSolDecimal(value: string | undefined, label: string): PositiveSolDecimal {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a positive decimal SOL value.`);
  }
  if (!/^(?:\d+|\d*\.\d+|\d+\.)$/.test(trimmed)) {
    throw new Error(`${label} must be a positive decimal SOL value.`);
  }
  const [wholeRaw = '0', fractionRaw = ''] = trimmed.split('.');
  if (fractionRaw.length > 9) {
    throw new Error(`${label} cannot have more than 9 fractional digits (SOL precision).`);
  }
  const whole = wholeRaw === '' ? '0' : wholeRaw;
  const fraction = fractionRaw.padEnd(9, '0');
  const lamports = BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fraction || '0');
  if (lamports <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return { lamports, sol: solFromLamports(lamports) };
}

export function solFromLamports(lamports: bigint | number | string): string {
  const value =
    typeof lamports === 'bigint'
      ? lamports
      : typeof lamports === 'number'
        ? BigInt(Math.trunc(lamports))
        : BigInt(lamports);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = abs % LAMPORTS_PER_SOL;
  if (fraction === 0n) return `${negative ? '-' : ''}${whole.toString()}`;
  const fractionText = fraction.toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}.${fractionText}`;
}
