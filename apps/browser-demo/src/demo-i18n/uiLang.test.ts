import { describe, expect, it, beforeEach } from 'vitest';

import { setUiLanguage, uiLanguage, t, tf } from './uiLang.js';

describe('demo-i18n uiLang (shared helpers for devTabs)', () => {
  beforeEach(() => setUiLanguage('en'));

  it('defaults to English and renders the identity', () => {
    expect(uiLanguage()).toBe('en');
    expect(t('Approve swap')).toBe('Approve swap');
  });

  it('setUiLanguage switches the active language for t()', () => {
    setUiLanguage('es');
    expect(uiLanguage()).toBe('es');
    const out = t('Approve swap');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('Approve swap');
  });

  it('tf interpolates placeholders after translating and stringifies number vars', () => {
    // English short-circuits to identity, so interpolation is testable without catalog coverage.
    expect(tf('Sign Jupiter swap {id} in your wallet.', { id: '019e2c78...030f95cc' })).toContain(
      '019e2c78...030f95cc',
    );
    expect(tf('{n} pending', { n: 3 })).toBe('3 pending');
  });

  it('falls back to English for uncatalogued strings in any language', () => {
    setUiLanguage('de');
    expect(t('this-string-is-not-in-the-catalog-xyz')).toBe('this-string-is-not-in-the-catalog-xyz');
  });

  it('preserves protected tokens (amounts + token symbols) when translating', () => {
    setUiLanguage('es');
    const out = t('Amount is capped at 0.2 SOL.');
    expect(out).toContain('0.2');
    expect(out).toContain('SOL');
  });
});
