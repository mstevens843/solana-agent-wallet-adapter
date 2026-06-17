import { describe, expect, it } from 'vitest';

import { tDemo, tDemoFormat, isDemoLanguage, DEMO_LANGUAGE_OPTIONS, DEMO_EN_ENTRIES } from './tDemo.js';

describe('demo i18n tDemo', () => {
  it('exposes 11 languages, English first', () => {
    expect(DEMO_LANGUAGE_OPTIONS).toHaveLength(11);
    expect(DEMO_LANGUAGE_OPTIONS[0]?.code).toBe('en');
    expect(DEMO_LANGUAGE_OPTIONS.map((o) => o.code)).toEqual([
      'en', 'zh-Hans', 'zh-Hant', 'es', 'ja', 'de', 'it', 'fr', 'pt', 'ko', 'ru',
    ]);
  });

  it('English is the identity', () => {
    expect(tDemo('Guided demo', 'en')).toBe('Guided demo');
    expect(tDemo('Approve swap', 'en')).toBe('Approve swap');
  });

  it('translates known strings into other languages', () => {
    for (const lang of ['zh-Hans', 'es', 'ja', 'de', 'fr', 'ru', 'ko'] as const) {
      const out = tDemo('Approve swap', lang);
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toBe('Approve swap');
    }
  });

  it('preserves protected tokens (token symbols + amounts) in translations', () => {
    for (const lang of ['es', 'ja', 'de', 'fr', 'ru'] as const) {
      const out = tDemo('Amount is capped at 0.2 SOL.', lang);
      expect(out).toContain('0.2');
      expect(out).toContain('SOL');
    }
    const helium = tDemo('Helium Mobile cheapest plan is $15/month, under the $20 rule.', 'es');
    expect(helium).toContain('$15');
    expect(helium).toContain('$20');
  });

  it('falls back to English for uncatalogued strings', () => {
    expect(tDemo('this-string-is-not-in-the-catalog', 'es')).toBe('this-string-is-not-in-the-catalog');
  });

  it('keeps {id}/{tx} placeholders verbatim and substitutes them', () => {
    const signing = tDemoFormat('Sign Jupiter swap {id} in your wallet.', 'fr', { id: '019e2c78...030f95cc' });
    expect(signing).toContain('019e2c78...030f95cc');
    expect(signing).not.toContain('{id}');
    const done = tDemoFormat('{tx} - Solscan link saved in Done.', 'ja', { tx: 'ABCDEF' });
    expect(done).toContain('ABCDEF');
    expect(done).not.toContain('{tx}');
  });

  it('isDemoLanguage guards correctly', () => {
    expect(isDemoLanguage('es')).toBe(true);
    expect(isDemoLanguage('en')).toBe(true);
    expect(isDemoLanguage('unknown')).toBe(false);
    expect(isDemoLanguage('xx')).toBe(false);
    expect(isDemoLanguage(undefined)).toBe(false);
  });

  it('catalog covers the full English source set', () => {
    expect(Object.keys(DEMO_EN_ENTRIES).length).toBe(338);
  });
});
