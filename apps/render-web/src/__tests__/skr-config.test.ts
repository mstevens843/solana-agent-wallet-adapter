import { describe, expect, it } from 'vitest';

import {
  isSkrSessionDefaultActive,
  isSkrSkillBountyActive,
  readSkrDecimals,
  readSkrMint,
} from '../cloud/skrConfig.js';

// Real Solana base58 pubkey (USDC mainnet mint). We use a known-good base58
// value as the test fixture rather than hard-coding $SKR's mainnet mint —
// the validator under test is base58-correctness, not token identity.
const VALID_BASE58 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('skrConfig helpers', () => {
  describe('readSkrMint', () => {
    it('returns empty string when SKR_TOKEN_MINT is unset', () => {
      expect(readSkrMint({})).toBe('');
    });

    it('returns empty string when SKR_TOKEN_MINT is empty/whitespace', () => {
      expect(readSkrMint({ SKR_TOKEN_MINT: '' })).toBe('');
      expect(readSkrMint({ SKR_TOKEN_MINT: '   ' })).toBe('');
    });

    it('returns empty string when SKR_TOKEN_MINT contains base58-illegal characters', () => {
      // '!' and '0' (zero) are outside the Solana base58 alphabet; '0' is a
      // particularly common operator typo (looks like the letter O).
      expect(readSkrMint({ SKR_TOKEN_MINT: 'not-a-real-base58!!!' })).toBe('');
      expect(readSkrMint({ SKR_TOKEN_MINT: '0'.repeat(32) })).toBe('');
    });

    it('returns empty string when SKR_TOKEN_MINT is too short for a Solana pubkey', () => {
      expect(readSkrMint({ SKR_TOKEN_MINT: 'abc' })).toBe('');
      expect(readSkrMint({ SKR_TOKEN_MINT: 'a'.repeat(31) })).toBe('');
    });

    it('returns the trimmed mint when SKR_TOKEN_MINT is a valid base58 pubkey', () => {
      expect(readSkrMint({ SKR_TOKEN_MINT: VALID_BASE58 })).toBe(VALID_BASE58);
      // Whitespace around the env value (common when copy-pasting from a
      // dashboard) shouldn't disable $SKR.
      expect(readSkrMint({ SKR_TOKEN_MINT: `  ${VALID_BASE58}  ` })).toBe(VALID_BASE58);
    });
  });

  describe('readSkrDecimals', () => {
    it('returns undefined when SKR_TOKEN_DECIMALS is unset', () => {
      expect(readSkrDecimals({})).toBeUndefined();
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '' })).toBeUndefined();
    });

    it('returns undefined on non-integer / out-of-range values', () => {
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: 'abc' })).toBeUndefined();
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '6.5' })).toBeUndefined();
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '-1' })).toBeUndefined();
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '19' })).toBeUndefined();
    });

    it('returns the integer for valid 0..18 values', () => {
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '0' })).toBe(0);
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '6' })).toBe(6);
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '9' })).toBe(9);
      expect(readSkrDecimals({ SKR_TOKEN_DECIMALS: '18' })).toBe(18);
    });
  });

  describe('isSkrSkillBountyActive', () => {
    it('returns false when SKR_SKILL_BOUNTY_ACTIVE is unset', () => {
      expect(isSkrSkillBountyActive({})).toBe(false);
    });

    it('coerces only the literal string "true" (case-insensitive)', () => {
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'true' })).toBe(true);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'TRUE' })).toBe(true);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'True' })).toBe(true);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: '  true  ' })).toBe(true);
    });

    it('rejects truthy-looking but non-"true" values (defense against operator typos)', () => {
      // Common mis-spellings of "true" that should NOT enable the bounty —
      // operator should see the bounty stay off rather than ship 100% to
      // authors based on an ambiguous value.
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: '1' })).toBe(false);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'yes' })).toBe(false);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'on' })).toBe(false);
      expect(isSkrSkillBountyActive({ SKR_SKILL_BOUNTY_ACTIVE: 'enabled' })).toBe(false);
    });
  });

  describe('isSkrSessionDefaultActive', () => {
    it('returns false when SKR_SESSION_DEFAULT is unset', () => {
      expect(isSkrSessionDefaultActive({})).toBe(false);
    });

    it('coerces only the literal string "true" (case-insensitive)', () => {
      expect(isSkrSessionDefaultActive({ SKR_SESSION_DEFAULT: 'true' })).toBe(true);
      expect(isSkrSessionDefaultActive({ SKR_SESSION_DEFAULT: 'TRUE' })).toBe(true);
    });

    it('rejects ambiguous truthy values', () => {
      expect(isSkrSessionDefaultActive({ SKR_SESSION_DEFAULT: '1' })).toBe(false);
      expect(isSkrSessionDefaultActive({ SKR_SESSION_DEFAULT: 'yes' })).toBe(false);
    });
  });
});
