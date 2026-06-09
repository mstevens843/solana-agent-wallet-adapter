import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_PROVIDER_PRESETS,
  agentProviderFromArg,
  visibleAiProviderPresets,
} from '../ai/presets.js';

test('visibleAiProviderPresets hides custom-openai-compatible from the interactive picker', () => {
  const ids = visibleAiProviderPresets().map((preset) => preset.id);
  assert.ok(!ids.includes('custom-openai-compatible'), 'custom-openai-compatible must not be offered in the picker');
  assert.deepEqual(ids, ['anthropic', 'openai', 'gemini', 'openrouter']);
});

test('custom-openai-compatible stays defined and resolvable via --provider / config', () => {
  // Hidden from the picker, NOT deleted — explicit selection still works.
  assert.ok(AI_PROVIDER_PRESETS.some((preset) => preset.id === 'custom-openai-compatible'));
  assert.equal(agentProviderFromArg('custom-openai-compatible'), 'custom-openai-compatible');
  assert.equal(agentProviderFromArg('custom'), 'custom-openai-compatible');
  assert.equal(agentProviderFromArg('openai-compatible'), 'custom-openai-compatible');
});
