import { describe, expect, it } from 'vitest';

import { extractAtoms } from '../agentAtoms.js';
import {
  compactPolicyLanguageForWire,
  detectPolicyLanguage,
  mergeModelPolicyTextNormalization,
  normalizePolicyText,
  policyLanguageRequiresInput,
  policyTextHasExtractableAtoms,
  POLICY_LANGUAGE_MISSING_FACT_ID,
  POLICY_LANGUAGE_NEEDS_INPUT_REASON,
} from '../policyLanguage.js';

function atomIdsFromCanonical(text: string): string[] {
  const normalized = normalizePolicyText({ text, knownTokenSymbols: ['SOL'] });
  return extractAtoms({ text: normalized.canonicalEnglish, knownTokenSymbols: ['SOL'] }).atoms.map((atom) => atom.id);
}

function canonicalAtomTypes(text: string): string[] {
  const normalized = normalizePolicyText({ text });
  return extractAtoms({ text: normalized.canonicalEnglish }).atoms.map((atom) => atom.type);
}

describe('policy language detection', () => {
  it('defaults to English without canonicalization', () => {
    const detection = detectPolicyLanguage('approve only if SOL is above $80');
    expect(detection.language).toBe('en');
    expect(detection.shouldCanonicalize).toBe(false);
  });

  it('detects the initial launch languages', () => {
    expect(detectPolicyLanguage('仅当 SOL 高于 80 美元时才批准').language).toBe('zh-Hans');
    expect(detectPolicyLanguage('僅當 SOL 高於 80 美元時才批准').language).toBe('zh-Hant');
    expect(detectPolicyLanguage('Solo aprueba si SOL está por encima de 80 dólares').language).toBe('es');
    expect(detectPolicyLanguage('SOL が 80ドルを超える場合のみ承認').language).toBe('ja');
    expect(detectPolicyLanguage('Nur genehmigen, wenn SOL über 80 Dollar liegt').language).toBe('de');
    expect(detectPolicyLanguage('Approva solo se SOL è superiore a 80 dollari').language).toBe('it');
    expect(detectPolicyLanguage('Approuve seulement si SOL est supérieur à 80 dollars').language).toBe('fr');
    expect(detectPolicyLanguage('Aprova apenas se SOL estiver acima de 80 dólares').language).toBe('pt');
    expect(detectPolicyLanguage('SOL이 80달러 초과인 경우에만 승인').language).toBe('ko');
    expect(detectPolicyLanguage('Одобрить только если SOL выше 80 долларов').language).toBe('ru');
  });

  it('detects mixed English + non-Latin script as the non-English language', () => {
    // A single CJK / Cyrillic token in otherwise-English text must still route to
    // canonicalization (script detection wins over the English fall-through).
    expect(detectPolicyLanguage('approve BTC swap only if 价格 > $50').language).toBe('zh-Hans');
    expect(detectPolicyLanguage('approve SOL if цена > $50').language).toBe('ru');
  });
});

describe('policy text normalization', () => {
  it.each([
    ['zh-Hans', '仅当 SOL 高于 80 美元时才批准。'],
    ['es', 'Solo aprueba si SOL está por encima de 80 dólares.'],
    ['ja', 'SOL が 80ドルを超える場合のみ承認。'],
    ['de', 'Nur genehmigen, wenn SOL über 80 Dollar liegt.'],
    ['it', 'Approva solo se SOL è superiore a 80 dollari.'],
  ])('canonicalizes %s price thresholds into the same atom as English', (_language, text) => {
    expect(atomIdsFromCanonical(text)).toContain('atom.price.sol.gt.80');
  });

  it.each([
    ['zh-Hans', '仅当 Helium 手机套餐低于 20 美元时才批准。'],
    ['es', 'Solo aprueba si el plan mensual de Helium es menos de 20 dólares.'],
    ['ja', 'Helium の月額プランが20ドル未満の場合のみ承認。'],
  ])('canonicalizes %s external monthly plan thresholds', (_language, text) => {
    const normalized = normalizePolicyText({ text });
    expect(normalized.status).toBe('success');
    expect(normalized.canonicalized).toBe(true);
    expect(policyTextHasExtractableAtoms(normalized.canonicalEnglish)).toBe(true);
    const atoms = extractAtoms({ text: normalized.canonicalEnglish }).atoms;
    expect(atoms.some((atom) => atom.type === 'external_price' && atom.id.includes('helium'))).toBe(true);
  });

  it('fails closed for non-English policy-like text the phrase pack cannot normalize', () => {
    const normalized = normalizePolicyText({ text: '仅当这个奇怪条件满足时才批准。' });
    expect(normalized.status).toBe('failed');
    expect(normalized.requiresInput).toBe(true);
  });

  // Remaining launch languages not covered by the price-threshold cases above. `$` is used
  // literally so the assertion doesn't depend on each locale's currency-word vocabulary.
  it.each([
    ['ko', 'SOL이 $80 초과인 경우에만 승인'],
    ['ru', 'Одобрить только если SOL выше $80'],
    ['pt', 'Aprovar apenas se SOL estiver acima de $80'],
    ['fr', 'Approuver seulement si SOL est au-dessus de $80'],
    ['zh-Hant', '僅當 SOL 高於 $80 時才批准'],
  ])('canonicalizes %s price thresholds into the same atom as English', (_language, text) => {
    expect(atomIdsFromCanonical(text)).toContain('atom.price.sol.gt.80');
  });

  it.each([
    ['es', 'Solo aprobar autoridad de acuñación deshabilitada'],
    ['de', 'Genehmigen nur wenn mint-berechtigung deaktiviert'],
    ['ru', 'Одобрить если право минтинга отключено'],
    ['ja', 'ミント権限を無効化'],
    ['pt', 'Aprovar somente se autoridade de cunhagem desativada'],
  ])('canonicalizes %s token-audit rules into a token_audit atom', (_language, text) => {
    expect(canonicalAtomTypes(text)).toContain('token_audit');
  });

  it.each([
    ['es', 'Solo aprobar sin transferencias extra'],
    ['de', 'Genehmigen nur wenn keine zusätzlichen Transfers'],
    ['ja', '承認は追加の送金なしの場合のみ'],
  ])('canonicalizes %s tx-gate rules into a tx_gate atom', (_language, text) => {
    expect(canonicalAtomTypes(text)).toContain('tx_gate');
  });

  it('keeps combined non-English price and external-plan clauses correctly associated', () => {
    const normalized = normalizePolicyText({
      text: '仅当 SOL 高于 $80 且 Helium 手机套餐低于 $20 时才批准。',
      knownTokenSymbols: ['SOL'],
    });
    expect(normalized.status).toBe('success');
    expect(normalized.canonicalEnglish).toContain('SOL is above $80.');
    expect(normalized.canonicalEnglish).toContain('Helium monthly plan is under $20.');
    const atoms = extractAtoms({ text: normalized.canonicalEnglish, knownTokenSymbols: ['SOL'] }).atoms;
    expect(atoms.map((atom) => atom.id)).toContain('atom.price.sol.gt.80');
    expect(atoms.map((atom) => atom.id)).toContain('atom.external_price.helium_monthly_plan.lt.20');
  });

  it('fails closed instead of dropping an unsupported non-English clause next to a supported one', () => {
    const normalized = normalizePolicyText({
      text: '仅当 SOL 高于 $80 且这个奇怪条件满足时才批准。',
      knownTokenSymbols: ['SOL'],
    });
    expect(normalized.status).toBe('failed');
    expect(normalized.requiresInput).toBe(true);
    expect(normalized.canonicalized).toBe(false);
    expect(normalized.warnings.join(' ')).toMatch(/unsupported non-english policy clause/i);
  });

  it.each([
    ['it', 'SOL minimo $100', 'atom.price.sol.gte.100'],
    ['it', 'SOL massimo $200', 'atom.price.sol.lte.200'],
    ['fr', 'Approuve si SOL minimum $100', 'atom.price.sol.gte.100'],
    ['fr', 'Approuve si SOL maximum $200', 'atom.price.sol.lte.200'],
    ['pt', 'SOL mínimo $100', 'atom.price.sol.gte.100'],
    ['es', 'SOL máximo $200', 'atom.price.sol.lte.200'],
  ])('canonicalizes %s min/max threshold phrasing', (_language, text, expectedAtomId) => {
    expect(atomIdsFromCanonical(text)).toContain(expectedAtomId);
  });

  it('fails closed for non-USD currency thresholds until currency-aware atoms exist', () => {
    const normalized = normalizePolicyText({
      text: 'Solo aprueba si SOL está por encima de €80.',
      knownTokenSymbols: ['SOL'],
    });
    expect(normalized.status).toBe('failed');
    expect(normalized.requiresInput).toBe(true);
  });
});

describe('non-English detection safety net (P0.3)', () => {
  it('routes operator-only Romance/German policies through canonicalization instead of English', () => {
    for (const text of ['SOL mínimo $100', 'SOL máximo $200', 'SOL mindestens $100', 'SOL höchstens $200']) {
      const detection = detectPolicyLanguage(text);
      expect(detection.isEnglish).toBe(false);
      expect(detection.shouldCanonicalize).toBe(true);
    }
  });

  it('classifies accented policy-like text with no marker as unknown non-English', () => {
    const detection = detectPolicyLanguage('aprobar solo si el límite está por debajo de $50 según la regla');
    expect(detection.isEnglish).toBe(false);
    expect(detection.shouldCanonicalize).toBe(true);
  });

  it('keeps pure-ASCII English policies as English', () => {
    const detection = detectPolicyLanguage('approve only if SOL is above $80');
    expect(detection.language).toBe('en');
    expect(detection.shouldCanonicalize).toBe(false);
  });
});

describe('model canonicalization merge', () => {
  function failedBase() {
    return normalizePolicyText({ text: '仅当这个奇怪条件满足时才批准。' });
  }

  it('fails closed when the model returns no canonical English', () => {
    const merged = mergeModelPolicyTextNormalization(failedBase(), '');
    expect(merged.status).toBe('failed');
    expect(merged.method).toBe('model');
    expect(merged.requiresInput).toBe(true);
    expect(merged.warnings.join(' ')).toMatch(/no canonical english/i);
  });

  it('fails closed when the model returns null', () => {
    const merged = mergeModelPolicyTextNormalization(failedBase(), null);
    expect(merged.requiresInput).toBe(true);
  });

  it('accepts a non-empty model canonicalization as success', () => {
    const merged = mergeModelPolicyTextNormalization(failedBase(), 'approve only if SOL is above $80');
    expect(merged.status).toBe('success');
    expect(merged.method).toBe('model');
    expect(merged.canonicalized).toBe(true);
    expect(merged.requiresInput).toBe(false);
    expect(merged.canonicalEnglish).toBe('approve only if SOL is above $80');
  });

  it('reads canonicalEnglish/normalizedText shapes and warnings', () => {
    const merged = mergeModelPolicyTextNormalization(failedBase(), {
      canonicalEnglish: 'approve only if SOL is above $80',
      warnings: ['translated from zh-Hans'],
    });
    expect(merged.status).toBe('success');
    expect(merged.warnings).toContain('translated from zh-Hans');
  });
});

describe('language wire mapping + predicate', () => {
  it('renames method/status onto the wire shape and omits empty warnings', () => {
    const wire = compactPolicyLanguageForWire(normalizePolicyText({ text: '仅当 SOL 高于 80 美元时才批准。', knownTokenSymbols: ['SOL'] }));
    expect(wire.sourceLanguage).toBe('zh-Hans');
    expect(wire.canonicalizationMethod).toBe('phrase_pack');
    expect(wire.canonicalizationStatus).toBe('success');
    expect(wire.requiresInput).toBe(false);
    expect(wire.warnings).toBeUndefined();
  });

  it('carries requiresInput + warnings on a failed canonicalization', () => {
    const wire = compactPolicyLanguageForWire(normalizePolicyText({ text: '仅当这个奇怪条件满足时才批准。' }));
    expect(wire.canonicalizationStatus).toBe('failed');
    expect(wire.requiresInput).toBe(true);
    expect((wire.warnings ?? []).length).toBeGreaterThan(0);
  });

  it('policyLanguageRequiresInput accepts wire and internal shapes', () => {
    expect(policyLanguageRequiresInput({ requiresInput: true })).toBe(true);
    expect(policyLanguageRequiresInput({ canonicalizationStatus: 'failed' })).toBe(true);
    expect(policyLanguageRequiresInput({ status: 'failed' })).toBe(true);
    expect(policyLanguageRequiresInput({ requiresInput: false, canonicalizationStatus: 'success' })).toBe(false);
    expect(policyLanguageRequiresInput(null)).toBe(false);
    expect(policyLanguageRequiresInput(undefined)).toBe(false);
    expect(policyLanguageRequiresInput('failed')).toBe(false);
  });

  it('exposes stable copy constants for cross-surface enforcers', () => {
    expect(POLICY_LANGUAGE_NEEDS_INPUT_REASON).toMatch(/could not safely translate/i);
    expect(POLICY_LANGUAGE_MISSING_FACT_ID).toBe('policy.language.canonicalization');
  });
});
