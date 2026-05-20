import { PublicKey } from '@solana/web3.js';

export interface TreasuryConfig {
  wallet: string | null;
  feeBps: number;
}

export const DEFAULT_PLATFORM_FEE_BPS = 1500;
const MAX_FEE_BPS = 10_000;

export class TreasuryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreasuryConfigError';
  }
}

export function loadTreasuryConfig(env: NodeJS.ProcessEnv = process.env): TreasuryConfig {
  const rawWallet = env.TREASURY_WALLET?.trim();
  const wallet = rawWallet ? normalizeTreasuryWallet(rawWallet) : null;
  const feeBps = parseFeeBps(env.PLATFORM_FEE_BPS);
  return { wallet, feeBps };
}

function normalizeTreasuryWallet(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new TreasuryConfigError(
      `TREASURY_WALLET="${value}" is not a valid base58 Solana public key.`,
    );
  }
}

function parseFeeBps(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PLATFORM_FEE_BPS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new TreasuryConfigError(
      `PLATFORM_FEE_BPS="${raw}" must be a non-negative integer (basis points; 1500 = 15%).`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > MAX_FEE_BPS) {
    throw new TreasuryConfigError(
      `PLATFORM_FEE_BPS="${raw}" must be between 0 and ${MAX_FEE_BPS} basis points.`,
    );
  }
  return value;
}

export interface PlatformSplit {
  authorAmountRaw: bigint;
  treasuryAmountRaw: bigint;
}

export function computePlatformSplit(amountRaw: bigint, feeBps: number): PlatformSplit {
  if (amountRaw < 0n) {
    throw new TreasuryConfigError('computePlatformSplit requires a non-negative amountRaw.');
  }
  if (feeBps < 0 || feeBps > MAX_FEE_BPS || !Number.isInteger(feeBps)) {
    throw new TreasuryConfigError(
      `computePlatformSplit requires an integer feeBps in [0, ${MAX_FEE_BPS}] (got ${feeBps}).`,
    );
  }
  if (feeBps === 0 || amountRaw === 0n) {
    return { authorAmountRaw: amountRaw, treasuryAmountRaw: 0n };
  }
  const denom = BigInt(MAX_FEE_BPS);
  const treasuryAmountRaw = (amountRaw * BigInt(feeBps)) / denom;
  const authorAmountRaw = amountRaw - treasuryAmountRaw;
  return { authorAmountRaw, treasuryAmountRaw };
}

export interface DecimalSplit {
  authorAmount: string;
  treasuryAmount: string;
  totalAmount: string;
}

export function computeDecimalSplit(
  totalAmount: string,
  feeBps: number,
  decimals: number,
): DecimalSplit {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TreasuryConfigError(`decimals must be an integer in [0, 18] (got ${decimals}).`);
  }
  const raw = decimalToRaw(totalAmount, decimals);
  const { authorAmountRaw, treasuryAmountRaw } = computePlatformSplit(raw, feeBps);
  return {
    totalAmount,
    authorAmount: rawToDecimal(authorAmountRaw, decimals),
    treasuryAmount: rawToDecimal(treasuryAmountRaw, decimals),
  };
}

export function decimalToRaw(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new TreasuryConfigError(`Amount "${value}" must be a non-negative decimal string.`);
  }
  const [intPart, fracPart = ''] = value.trim().split('.');
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigInt((intPart ?? '0') + padded);
}

export function rawToDecimal(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const raw = value.toString().padStart(decimals + 1, '0');
  const intPart = raw.slice(0, -decimals);
  const fracPart = raw.slice(-decimals).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

export interface SkillFeeSplitContext {
  treasuryWallet: string;
  feeBps: number;
  authorWallet: string;
}

export function isPlatformFeeApplicable(
  config: TreasuryConfig,
  authorWallet: string,
): SkillFeeSplitContext | null {
  if (!config.wallet) return null;
  if (config.feeBps <= 0) return null;
  if (config.wallet === authorWallet) return null;
  return {
    treasuryWallet: config.wallet,
    feeBps: config.feeBps,
    authorWallet,
  };
}

interface ScheduleWithAmount {
  amount: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Returns what the user is actually charged per occurrence for a recurring
 * schedule. For skill-monetization schedules with a platform split,
 * `schedule.amount` stores only the author portion (e.g., $8.50). The user's
 * total charge ($10) lives in `metadata.totalAmount`. Every UI/notification/
 * policy consumer should read through this helper rather than `schedule.amount`
 * directly so the split stays invisible to user-facing dollar amounts.
 */
export function effectiveScheduleTotalAmount(schedule: ScheduleWithAmount): string {
  const total = schedule.metadata?.totalAmount;
  if (typeof total === 'string' && /^\d+(\.\d+)?$/.test(total)) return total;
  return schedule.amount;
}

/**
 * True if a schedule's metadata describes a skill-monetization platform split.
 * Tightly coupled to the install handler's metadata shape; consumers can use
 * this to decide whether to surface a "(author + Agentic)" disclosure.
 */
export function isSkillMonetizationSplit(metadata: unknown): metadata is {
  source: 'skill_install_monetization';
  platformWallet: string;
  platformAmount: string;
  totalAmount: string;
  platformFeeBps: number;
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const m = metadata as Record<string, unknown>;
  if (m.source !== 'skill_install_monetization') return false;
  if (typeof m.platformWallet !== 'string' || !m.platformWallet) return false;
  if (typeof m.platformAmount !== 'string' || !m.platformAmount) return false;
  if (typeof m.totalAmount !== 'string' || !m.totalAmount) return false;
  if (typeof m.platformFeeBps !== 'number' || !Number.isFinite(m.platformFeeBps)) return false;
  return true;
}
