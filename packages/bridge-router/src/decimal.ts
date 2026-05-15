const UNSIGNED_INTEGER_RE = /^\d+$/;
const POSITIVE_DECIMAL_RE = /^(?!0+(\.0+)?$)\d+(\.\d+)?$/;
const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function decimalStringIsPositive(value: string): boolean {
  return POSITIVE_DECIMAL_RE.test(value);
}

export function decimalUsdToRaw(usd: string, decimals: number): string {
  if (!DECIMAL_RE.test(usd)) {
    throw new Error(`Invalid decimal string: ${usd}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const [whole, frac = ''] = usd.split('.');
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
  const combined = `${whole}${paddedFrac}`.replace(/^0+/, '') || '0';
  return combined;
}

export function rawToDecimal(amountRaw: string, decimals: number): string {
  if (!UNSIGNED_INTEGER_RE.test(amountRaw)) {
    throw new Error(`Invalid raw amount: ${amountRaw}`);
  }
  if (decimals === 0) return amountRaw;
  const padded = amountRaw.padStart(decimals + 1, '0');
  const cut = padded.length - decimals;
  const whole = padded.slice(0, cut).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(cut).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function compareUnsignedBigStrings(a: string, b: string): number {
  if (!UNSIGNED_INTEGER_RE.test(a) || !UNSIGNED_INTEGER_RE.test(b)) {
    throw new Error('compareUnsignedBigStrings requires unsigned integer strings.');
  }
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDecimalStrings(a: string, b: string): string {
  if (!DECIMAL_RE.test(a) || !DECIMAL_RE.test(b)) {
    throw new Error('addDecimalStrings requires non-negative decimal strings.');
  }
  const [aWhole, aFrac = ''] = a.split('.');
  const [bWhole, bFrac = ''] = b.split('.');
  const fracLen = Math.max(aFrac.length, bFrac.length);
  const aPaddedFrac = aFrac.padEnd(fracLen, '0');
  const bPaddedFrac = bFrac.padEnd(fracLen, '0');
  const aRaw = `${aWhole}${aPaddedFrac}`;
  const bRaw = `${bWhole}${bPaddedFrac}`;
  const sumRaw = addUnsignedIntegerStrings(aRaw, bRaw);
  if (fracLen === 0) return sumRaw.replace(/^0+(?=\d)/, '') || '0';
  const padded = sumRaw.padStart(fracLen + 1, '0');
  const cut = padded.length - fracLen;
  const whole = padded.slice(0, cut).replace(/^0+(?=\d)/, '') || '0';
  const frac = padded.slice(cut).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function applySlippageBps(
  amountRaw: string,
  slippageBps: number,
  mode: 'reduce' | 'inflate',
): string {
  if (!UNSIGNED_INTEGER_RE.test(amountRaw)) {
    throw new Error(`Invalid raw amount: ${amountRaw}`);
  }
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`Invalid slippageBps: ${slippageBps}`);
  }
  if (slippageBps === 0) return amountRaw;
  const factor = mode === 'reduce' ? 10_000 - slippageBps : 10_000 + slippageBps;
  const scaled = multiplyUnsignedIntegerStrings(amountRaw, String(factor));
  return divideUnsignedIntegerString(scaled, '10000');
}

function addUnsignedIntegerStrings(a: string, b: string): string {
  let i = a.length - 1;
  let j = b.length - 1;
  let carry = 0;
  let result = '';
  while (i >= 0 || j >= 0 || carry > 0) {
    const ai = i >= 0 ? a.charCodeAt(i) - 48 : 0;
    const bi = j >= 0 ? b.charCodeAt(j) - 48 : 0;
    const sum = ai + bi + carry;
    carry = Math.floor(sum / 10);
    result = `${sum % 10}${result}`;
    i--;
    j--;
  }
  return result.replace(/^0+(?=\d)/, '') || '0';
}

function multiplyUnsignedIntegerStrings(a: string, b: string): string {
  if (a === '0' || b === '0') return '0';
  const digits = new Array<number>(a.length + b.length).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    const ai = a.charCodeAt(i) - 48;
    for (let j = b.length - 1; j >= 0; j--) {
      const bj = b.charCodeAt(j) - 48;
      const pos = i + j + 1;
      const sum = digits[pos]! + ai * bj;
      digits[pos] = sum % 10;
      digits[i + j] = digits[i + j]! + Math.floor(sum / 10);
    }
  }
  return digits.join('').replace(/^0+(?=\d)/, '') || '0';
}

function divideUnsignedIntegerString(dividend: string, divisor: string): string {
  if (divisor === '0') throw new Error('division by zero');
  if (compareUnsignedBigStrings(dividend, divisor) < 0) return '0';
  let result = '';
  let remainder = '';
  for (const digit of dividend) {
    remainder = `${remainder}${digit}`.replace(/^0+(?=\d)/, '') || '0';
    let count = 0;
    while (compareUnsignedBigStrings(remainder, divisor) >= 0) {
      remainder = subtractUnsignedIntegerStrings(remainder, divisor);
      count++;
    }
    result += String(count);
  }
  return result.replace(/^0+(?=\d)/, '') || '0';
}

export function subtractUnsignedIntegerStrings(a: string, b: string): string {
  let i = a.length - 1;
  let j = b.length - 1;
  let borrow = 0;
  let result = '';
  while (i >= 0) {
    const ai = a.charCodeAt(i) - 48;
    const bi = j >= 0 ? b.charCodeAt(j) - 48 : 0;
    let diff = ai - bi - borrow;
    if (diff < 0) {
      diff += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    result = `${diff}${result}`;
    i--;
    j--;
  }
  return result.replace(/^0+(?=\d)/, '') || '0';
}
