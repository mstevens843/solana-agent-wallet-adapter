import { describe, expect, it } from 'vitest';

import { localizeAgentAskResultForDisplay } from '../agentAskLocalization.js';

describe('agent Ask localization', () => {
  it('translates Android non-English Ask answers and preserves non-answer fields', async () => {
    const citations = [{ title: 'Source', url: 'https://example.com' }];
    const result = await localizeAgentAskResultForDisplay(
      { answer: 'The swap matches your request.', citations },
      {
        enabled: true,
        language: 'es',
        fallbackText: '¿Está bien este swap?',
        localizeReviewCopy: async (review, language, fallbackText) => {
          expect(review).toEqual({ reason: 'The swap matches your request.' });
          expect(language).toBe('es');
          expect(fallbackText).toBe('¿Está bien este swap?');
          return {
            language,
            status: 'ready',
            source: 'model',
            reason: 'El swap coincide con tu solicitud.',
          };
        },
      },
    );

    expect(result.answer).toBe('El swap coincide con tu solicitud.');
    expect(result.citations).toBe(citations);
  });

  it('does not invoke localization for English display language', async () => {
    let calls = 0;
    const original = { answer: 'The swap matches your request.' };
    const result = await localizeAgentAskResultForDisplay(original, {
      enabled: true,
      language: 'en',
      fallbackText: 'Is this ok?',
      localizeReviewCopy: async () => {
        calls += 1;
        return null;
      },
    });

    expect(result).toBe(original);
    expect(calls).toBe(0);
  });

  it('returns the original answer when model localization fails', async () => {
    const original = { answer: 'The swap matches your request.' };
    const result = await localizeAgentAskResultForDisplay(original, {
      enabled: true,
      language: 'ja',
      fallbackText: 'このスワップは大丈夫ですか？',
      localizeReviewCopy: async () => {
        throw new Error('localizer unavailable');
      },
    });

    expect(result).toBe(original);
  });

  it('returns the original answer when localization is disabled', async () => {
    let calls = 0;
    const original = { answer: 'The swap matches your request.' };
    const result = await localizeAgentAskResultForDisplay(original, {
      enabled: false,
      language: 'ko',
      fallbackText: '괜찮나요?',
      localizeReviewCopy: async () => {
        calls += 1;
        return {
          language: 'ko',
          status: 'ready',
          source: 'model',
          reason: '번역',
        };
      },
    });

    expect(result).toBe(original);
    expect(calls).toBe(0);
  });
});
