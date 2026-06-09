import { PublicKey } from '@solana/web3.js';

/**
 * Jupiter Ultra integrator-fee parameters for the `swap/v2` `/order` endpoint.
 *
 * Ultra collects an integrator fee via a Jupiter Referral Program account
 * (`referralAccount`, a PDA created at referral.jup.ag) plus a `referralFee` in
 * basis points. Jupiter hard-enforces 50 <= referralFee <= 255 and keeps 20% of
 * the fee, so the lowest collectable fee is 50 bps (≈40 bps net). The per-mint
 * referral token accounts (WSOL/USDC/USDT) must exist on-chain but are resolved
 * by Jupiter from the PDA and are NOT passed as request params.
 */
export interface JupiterReferralParams {
  referralAccount: string;
  referralFee: number;
}

/** Ultra's documented integrator-fee bounds (basis points). */
export const JUPITER_REFERRAL_MIN_FEE_BPS = 50;
export const JUPITER_REFERRAL_MAX_FEE_BPS = 255;

/**
 * Resolve the operator's Jupiter referral fee config from the environment.
 *
 * Returns `null` (no fee applied) when:
 * - `JUPITER_REFERRAL_ACCOUNT` is unset/blank or not a valid base58 pubkey, or
 * - the resolved fee is below Ultra's 50 bps floor (Jupiter would reject it).
 *
 * `JUPITER_REFERRAL_FEE_BPS` defaults to 50 and is clamped to the [50, 255]
 * window. Note: `PLATFORM_FEE_BPS` is intentionally NOT used here — that env is
 * already owned by skill-monetization treasury splits (see treasuryConfig.ts).
 */
export function resolveJupiterReferral(
  env: NodeJS.ProcessEnv = process.env,
): JupiterReferralParams | null {
  const rawAccount = env.JUPITER_REFERRAL_ACCOUNT?.trim();
  if (!rawAccount) return null;

  let referralAccount: string;
  try {
    referralAccount = new PublicKey(rawAccount).toBase58();
  } catch {
    // Kept pure (no logging) — this is called per swap request. Startup callers
    // surface an invalid-but-set account as a one-time warning instead.
    return null;
  }

  const rawBps = env.JUPITER_REFERRAL_FEE_BPS?.trim();
  let feeBps = JUPITER_REFERRAL_MIN_FEE_BPS;
  if (rawBps) {
    if (!/^\d+$/.test(rawBps)) return null;
    feeBps = Number(rawBps);
  }
  if (!Number.isInteger(feeBps) || feeBps < JUPITER_REFERRAL_MIN_FEE_BPS) {
    // Ultra ignores/rejects sub-50-bps fees; treat as "no fee" rather than
    // silently shipping an invalid request.
    return null;
  }
  if (feeBps > JUPITER_REFERRAL_MAX_FEE_BPS) {
    feeBps = JUPITER_REFERRAL_MAX_FEE_BPS;
  }

  return { referralAccount, referralFee: feeBps };
}
