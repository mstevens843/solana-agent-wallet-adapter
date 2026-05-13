import { describe, expect, it } from 'vitest';

import {
  BLINK_CLASSIFICATION_PROFILES,
  BLINK_CLASSIFIER_REVIEW_PROMPT,
  applyBlinkVerdictFloor,
  blinkClassificationProfile,
  isBlinkClassificationCategory,
  normalizeBlinkClassification,
  type BlinkClassificationCategory,
  type BlinkDefaultVerdict,
} from '../blinkClassification.js';

describe('blink classification taxonomy', () => {
  const allCategories: BlinkClassificationCategory[] = [
    'safe_claim',
    'safe_governance_vote',
    'safe_donation_or_tip',
    'lp_position_management',
    'nft_marketplace',
    'mint_or_buy',
    'disguised_transfer',
    'token_account_drain',
    'unknown_program_interaction',
    'unparseable',
  ];

  it('exposes a profile for every category', () => {
    for (const category of allCategories) {
      expect(BLINK_CLASSIFICATION_PROFILES[category]).toBeDefined();
      expect(BLINK_CLASSIFICATION_PROFILES[category].label.length).toBeGreaterThan(0);
    }
  });

  it('marks dangerous categories as deny by default', () => {
    expect(BLINK_CLASSIFICATION_PROFILES.disguised_transfer.defaultVerdict).toBe('deny');
    expect(BLINK_CLASSIFICATION_PROFILES.token_account_drain.defaultVerdict).toBe('deny');
  });

  it('marks ambiguous categories as needs_input', () => {
    expect(BLINK_CLASSIFICATION_PROFILES.unknown_program_interaction.defaultVerdict).toBe('needs_input');
    expect(BLINK_CLASSIFICATION_PROFILES.unparseable.defaultVerdict).toBe('needs_input');
  });

  it('marks safe categories as approve', () => {
    expect(BLINK_CLASSIFICATION_PROFILES.safe_claim.defaultVerdict).toBe('approve');
    expect(BLINK_CLASSIFICATION_PROFILES.safe_governance_vote.defaultVerdict).toBe('approve');
    expect(BLINK_CLASSIFICATION_PROFILES.safe_donation_or_tip.defaultVerdict).toBe('approve');
  });

  it('treats unknown strings as unparseable', () => {
    expect(isBlinkClassificationCategory('garbage')).toBe(false);
    expect(normalizeBlinkClassification('garbage')).toBe('unparseable');
    expect(blinkClassificationProfile(null).category).toBe('unparseable');
  });

  it('accepts valid categories without normalization', () => {
    for (const category of allCategories) {
      expect(isBlinkClassificationCategory(category)).toBe(true);
      expect(normalizeBlinkClassification(category)).toBe(category);
    }
  });

  it('applies the verdict floor for dangerous categories', () => {
    const cases: Array<[BlinkClassificationCategory, BlinkDefaultVerdict, BlinkDefaultVerdict]> = [
      ['disguised_transfer', 'approve', 'deny'],
      ['token_account_drain', 'needs_input', 'deny'],
      ['unknown_program_interaction', 'approve', 'needs_input'],
      ['unparseable', 'approve', 'needs_input'],
      ['safe_claim', 'approve', 'approve'],
      ['safe_claim', 'needs_input', 'needs_input'],
      ['safe_claim', 'deny', 'deny'],
    ];
    for (const [category, topLevel, expected] of cases) {
      expect(applyBlinkVerdictFloor(category, topLevel)).toBe(expected);
    }
  });
});

describe('blink classifier review prompt', () => {
  it('mentions every category in the prompt text', () => {
    const categories: BlinkClassificationCategory[] = [
      'safe_claim',
      'safe_governance_vote',
      'safe_donation_or_tip',
      'lp_position_management',
      'nft_marketplace',
      'mint_or_buy',
      'disguised_transfer',
      'token_account_drain',
      'unknown_program_interaction',
      'unparseable',
    ];
    for (const category of categories) {
      expect(BLINK_CLASSIFIER_REVIEW_PROMPT).toContain(category);
    }
  });

  it('instructs the risk reviewer to deny on dangerous categories', () => {
    expect(BLINK_CLASSIFIER_REVIEW_PROMPT).toMatch(/deny on disguised_transfer or token_account_drain/);
  });

  it('instructs to record evidence.blinkClassification', () => {
    expect(BLINK_CLASSIFIER_REVIEW_PROMPT).toContain('evidence.blinkClassification');
  });
});
