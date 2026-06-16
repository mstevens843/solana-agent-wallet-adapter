import { describe, expect, it } from 'vitest';

import { handlePolicyEnrich } from '../cloud/policyEnrich.js';

// These inputs produce ZERO atoms, so the pipeline never calls a network resolver — the
// test exercises only language detection + the wire-format mapping (status ->
// canonicalizationStatus, method -> canonicalizationMethod) emitted to BYOK/native clients.
describe('handlePolicyEnrich — language metadata wire shape', () => {
  it('surfaces a fail-closed language signal for untranslatable non-English policy text', async () => {
    const result = await handlePolicyEnrich({ instruction: '仅当这个奇怪条件满足时才批准。' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.policyBundle as {
      atoms: unknown[];
      language?: Record<string, unknown>;
    };
    expect(bundle.atoms).toHaveLength(0);
    expect(bundle.language?.sourceLanguage).toBe('zh-Hans');
    expect(bundle.language?.canonicalizationStatus).toBe('failed');
    expect(bundle.language?.canonicalizationMethod).toBe('phrase_pack');
    expect(bundle.language?.requiresInput).toBe(true);
    expect(Array.isArray(bundle.language?.warnings)).toBe(true);
  });

  it('does not flag plain English notes as requiring input', async () => {
    const result = await handlePolicyEnrich({ instruction: 'just a plain english note with no rule' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.policyBundle as { language?: Record<string, unknown> };
    if (bundle.language) {
      expect(bundle.language.requiresInput).toBe(false);
      expect(bundle.language.canonicalizationStatus).not.toBe('failed');
    }
  });
});
