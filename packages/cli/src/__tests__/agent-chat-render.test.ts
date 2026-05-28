import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgentChatDisplay } from '../flows/agent.js';

test('agent chat display renders answer, sections, next step, and sources separately', () => {
  const display = buildAgentChatDisplay({
    answer: 'Helium Mobile has Air at $15/month and Infinity at $30/month for new users.',
    sections: [{
      title: 'Key Facts',
      bullets: [
        'Air includes 10GB of high-speed data.',
        'Infinity includes unlimited talk, text, and data.',
      ],
    }],
    next: 'Type /plan when you want to prepare a visible wallet request.',
    citations: [
      { kind: 'url', title: 'Helium Mobile Plans', ref: 'https://hellohelium.com/plans' },
      { kind: 'url', title: 'Helium Mobile Plans duplicate', ref: 'https://hellohelium.com/plans' },
    ],
  });
  const plain = stripAnsi(display.output);

  assert.match(plain, /Agent/);
  assert.match(plain, /Answer\n  Helium Mobile has Air at \$15\/month/);
  assert.match(plain, /Key Facts\n  • Air includes 10GB/);
  assert.match(plain, /Next\n  Type \/plan when you want/);
  assert.match(plain, /Sources\n  \[1\] Helium Mobile Plans - hellohelium\.com/);
  assert.doesNotMatch(plain, /duplicate/);
  assert.match(display.transcript, /Key Facts:\n- Air includes/);
});

test('agent chat display keeps plain-text fallback readable and caps noisy sources', () => {
  const display = buildAgentChatDisplay({
    answer: '## Current Plans\n- Air: $15/month\n- Infinity: $30/month',
    citations: Array.from({ length: 8 }, (_, index) => ({
      kind: 'url',
      title: `Source ${index + 1}`,
      ref: `https://example${index + 1}.com/page`,
    })),
  });
  const plain = stripAnsi(display.output);

  assert.match(plain, /Answer\n  ## Current Plans\n  - Air: \$15\/month/);
  assert.match(plain, /Next\n  Type \/plan, \/new, or \/prepare/);
  assert.match(plain, /\[6\] Source 6 - example6\.com/);
  assert.doesNotMatch(plain, /\[7\] Source 7/);
  assert.match(plain, /and 2 more/);
});

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
