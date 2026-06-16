import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { agentReviewLocalizationMessages } from '../agentReviewLocalization.js';

// Guards against the drift that let packages/shared-test-fixtures/fixtures/system-prompts.json
// fall behind the live prompts: the canonical shared fixture and its iOS mirror
// (Tests/Fixtures, copied by ios-capacitor-bridge/scripts/sync-fixtures.mjs) must stay
// byte-identical for every prompt key, and the localize prompt must match the single TS source.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sharedPrompts = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/shared-test-fixtures/fixtures/system-prompts.json'), 'utf8'),
) as Record<string, string>;
const iosPrompts = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/ios-capacitor-bridge/Tests/Fixtures/system-prompts.json'), 'utf8'),
) as Record<string, string>;

describe('shared system-prompts fixture parity', () => {
  for (const key of ['plan', 'review', 'ask', 'localize'] as const) {
    it(`"${key}" is byte-identical between shared-test-fixtures and the iOS mirror`, () => {
      expect(typeof sharedPrompts[key]).toBe('string');
      expect(iosPrompts[key]).toBe(sharedPrompts[key]);
    });
  }

  it('the fixture "localize" prompt matches the canonical TS builder (single source of truth)', () => {
    const [system] = agentReviewLocalizationMessages({
      language: 'es',
      findings: [],
      questions: [],
      reviewers: [],
      policies: [],
      facts: [],
      counterfactuals: [],
    });
    expect(sharedPrompts.localize).toBe(system?.content);
  });
});
