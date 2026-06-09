import { describe, expect, it } from 'vitest';

import { resolveJupiterReferral } from '../referral.js';

const ACCOUNT = '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd';

describe('resolveJupiterReferral', () => {
  it('returns null when no referral account is configured', () => {
    expect(resolveJupiterReferral({})).toBeNull();
    expect(resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: '   ' })).toBeNull();
  });

  it('returns null for an invalid base58 referral account', () => {
    expect(resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: 'not-a-real-pubkey!' })).toBeNull();
  });

  it('defaults the fee to the 50 bps Ultra floor when only the account is set', () => {
    expect(resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: ACCOUNT })).toEqual({
      referralAccount: ACCOUNT,
      referralFee: 50,
    });
  });

  it('uses the configured fee when within the Ultra window', () => {
    expect(
      resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: ACCOUNT, JUPITER_REFERRAL_FEE_BPS: '75' }),
    ).toEqual({ referralAccount: ACCOUNT, referralFee: 75 });
  });

  it('returns null when the fee is below the 50 bps floor (Ultra would ignore it)', () => {
    expect(
      resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: ACCOUNT, JUPITER_REFERRAL_FEE_BPS: '25' }),
    ).toBeNull();
  });

  it('clamps a fee above 255 bps down to the Ultra ceiling', () => {
    expect(
      resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: ACCOUNT, JUPITER_REFERRAL_FEE_BPS: '900' }),
    ).toEqual({ referralAccount: ACCOUNT, referralFee: 255 });
  });

  it('returns null for a non-numeric fee value', () => {
    expect(
      resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: ACCOUNT, JUPITER_REFERRAL_FEE_BPS: '50abc' }),
    ).toBeNull();
  });

  it('normalizes the referral account to canonical base58', () => {
    const resolved = resolveJupiterReferral({ JUPITER_REFERRAL_ACCOUNT: `  ${ACCOUNT}  ` });
    expect(resolved?.referralAccount).toBe(ACCOUNT);
  });
});
