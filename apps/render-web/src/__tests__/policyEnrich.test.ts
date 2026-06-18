import { describe, expect, it } from 'vitest';

import { handlePolicyEnrich } from '../cloud/policyEnrich.js';

// These inputs produce ZERO atoms, so the pipeline never calls a network resolver — the
// test exercises only language detection + the wire-format mapping (status ->
// canonicalizationStatus, method -> canonicalizationMethod) emitted to BYOK/native clients.
describe('handlePolicyEnrich — language metadata wire shape', () => {
  it('uses an injected canonicalizer to extract atoms from unsupported non-English policy text', async () => {
    const result = await handlePolicyEnrich(
      { instruction: '仅当这个奇怪条件满足时才批准。' },
      {
        policyTextCanonicalizer: async ({ sourceLanguage }) => {
          expect(sourceLanguage).toBe('zh-Hans');
          return 'approve only if there are no extra transfers';
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.policyBundle as {
      atoms: Array<{ id: string; type: string }>;
      evaluations: Array<{ atomId: string; unresolved?: boolean }>;
      language?: Record<string, unknown>;
    };
    expect(bundle.language?.sourceLanguage).toBe('zh-Hans');
    expect(bundle.language?.canonicalizationStatus).toBe('success');
    expect(bundle.language?.canonicalizationMethod).toBe('model');
    expect(bundle.language?.requiresInput).toBe(false);
    expect(bundle.atoms.map((atom) => atom.type)).toContain('tx_gate');
    expect(bundle.evaluations.some((entry) => entry.atomId.startsWith('atom.tx_gate.'))).toBe(true);
  });

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

  it('keeps the endpoint shaped when the injected canonicalizer fails', async () => {
    const result = await handlePolicyEnrich(
      { instruction: '仅当这个奇怪条件满足时才批准。' },
      {
        policyTextCanonicalizer: async () => {
          throw new Error('model unavailable');
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.policyBundle as {
      atoms: unknown[];
      language?: Record<string, unknown>;
    };
    expect(bundle.atoms).toHaveLength(0);
    expect(bundle.language?.sourceLanguage).toBe('zh-Hans');
    expect(bundle.language?.canonicalizationStatus).toBe('failed');
    expect(bundle.language?.canonicalizationMethod).toBe('model');
    expect(bundle.language?.requiresInput).toBe(true);
  });

  it('keeps the original instruction as the source of language metadata when canonicalInstruction is present', async () => {
    let sourceLanguage = '';
    const result = await handlePolicyEnrich(
      {
        instruction: '仅当这个奇怪条件满足时才批准。',
        canonicalInstruction: 'approve only if SOL is above $80',
      },
      {
        policyTextCanonicalizer: async (input) => {
          sourceLanguage = input.sourceLanguage;
          return 'approve only if there are no extra transfers';
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bundle = result.policyBundle as {
      atoms: Array<{ type: string }>;
      language?: Record<string, unknown>;
    };
    expect(sourceLanguage).toBe('zh-Hans');
    expect(bundle.language?.sourceLanguage).toBe('zh-Hans');
    expect(bundle.atoms.map((atom) => atom.type)).toContain('tx_gate');
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
