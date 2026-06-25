import { PublicKey } from '@solana/web3.js';

/**
 * Jupiter Ultra integrator-fee parameters for the Ultra (`/ultra/v1`) `/order`
 * endpoint. NOTE: these params are Ultra-specific — the Swap API v2 `/order`
 * endpoint uses `platformFeeBps` + `feeAccount` instead and IGNORES these, so
 * the swap base URL must resolve to `/ultra/v1` for the fee to land.
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
  // JUPITER_REFERRAL_ACCOUNT_ULTRA is the canonical name for the Ultra (swap) referral account;
  // JUPITER_REFERRAL_ACCOUNT is the legacy fallback (kept so existing deploys don't break).
  const rawAccount = env.JUPITER_REFERRAL_ACCOUNT_ULTRA?.trim() || env.JUPITER_REFERRAL_ACCOUNT?.trim();
  if (!rawAccount) return null;

  let referralAccount: string;
  try {
    referralAccount = new PublicKey(rawAccount).toBase58();
  } catch {
    // Kept pure (no logging) — this is called per swap request. Startup callers
    // surface an invalid-but-set account as a one-time warning instead.
    return null;
  }

  // Canonical name JUPITER_REFERRAL_FEE_BPS_ULTRA; JUPITER_REFERRAL_FEE_BPS is the legacy fallback.
  const rawBps = env.JUPITER_REFERRAL_FEE_BPS_ULTRA?.trim() || env.JUPITER_REFERRAL_FEE_BPS?.trim();
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

/**
 * Integrator fee for a Jupiter Trigger (limit) order. UNLIKE the Ultra swap fee, Trigger uses the
 * Swap+Trigger referral program where the integrator keeps 100% (Jupiter takes 0%). The fee is set
 * with `feeBps` + `feeAccount`, where `feeAccount` is the referral token account of the order's
 * OUTPUT mint.
 *
 * The operator stores only the PARENT referral account (JUPITER_REFERRAL_ACCOUNT_SWAP_PLUS_TRIGGER) —
 * exactly like Ultra stores only its parent. We DERIVE the per-mint referral token account here
 * (the Swap+Trigger / "V1" referral program PDA), so no per-mint token-account envs are needed.
 * Verified on-chain that this derivation matches the referral.jup.ag dashboard token accounts.
 *
 * Returns null (NO fee, request unchanged) unless JUPITER_TRIGGER_FEE_BPS > 0 AND the parent account
 * is set AND the output mint is one we have a referral token account for (WSOL/USDC/USDT — the mints
 * created on the Swap+Trigger dashboard). Naturally gated: no envs => zero behavior change.
 */
export interface JupiterTriggerFee {
  feeBps: number;
  feeAccount: string;
}

// Jupiter Referral Program (owns every referral account + token account).
const JUPITER_REFERRAL_PROGRAM_ID = new PublicKey('REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3');
// Output mints we can collect Trigger fees into (their referral token accounts exist on the
// Swap+Trigger dashboard). Other outputs → no fee, order unaffected.
const TRIGGER_FEE_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** Derive the Swap+Trigger ("V1") referral token account: PDA(["referral_ata", parent, mint]). */
function deriveSwapTriggerFeeAccount(parent: PublicKey, mint: PublicKey): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('referral_ata'), parent.toBuffer(), mint.toBuffer()],
    JUPITER_REFERRAL_PROGRAM_ID,
  );
  return pda.toBase58();
}

export function resolveTriggerFee(
  outputMint: string,
  env: NodeJS.ProcessEnv = process.env,
): JupiterTriggerFee | null {
  // Canonical name JUPITER_REFERRAL_FEE_BPS_SWAP_PLUS_TRIGGER; JUPITER_TRIGGER_FEE_BPS legacy fallback.
  const rawBps =
    env.JUPITER_REFERRAL_FEE_BPS_SWAP_PLUS_TRIGGER?.trim() || env.JUPITER_TRIGGER_FEE_BPS?.trim();
  if (!rawBps || !/^\d+$/.test(rawBps)) return null;
  const feeBps = Number(rawBps);
  if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps > 10_000) return null;

  const rawParent = env.JUPITER_REFERRAL_ACCOUNT_SWAP_PLUS_TRIGGER?.trim();
  if (!rawParent) return null;
  if (!TRIGGER_FEE_MINTS.has(outputMint)) return null;

  try {
    const parent = new PublicKey(rawParent);
    const feeAccount = deriveSwapTriggerFeeAccount(parent, new PublicKey(outputMint));
    return { feeBps, feeAccount };
  } catch {
    return null;
  }
}
