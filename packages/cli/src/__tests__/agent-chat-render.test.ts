import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAgentAnswerDisplay, buildAgentChatDisplay } from '../flows/agent.js';

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

test('agent chat display strips provider cite tags but keeps source list', () => {
  const display = buildAgentChatDisplay({
    answer: '<cite index="6-36,8-14,8-15">The cheapest Helium Mobile plan is the Zero plan at $0/month base cost.</cite>',
    sections: [{
      title: 'Key Facts',
      bullets: [
        '<cite index="6-36,6-37">Zero plan: $0/month with 1GB cellular.</cite>',
        '<cite index="2-7">Air plan: $15/month.</cite>',
      ],
    }],
    next: '<cite index="2-12">Type /plan when ready.</cite>',
    citations: [
      { kind: 'url', title: 'Helium Mobile Plans', ref: 'https://hellohelium.com/plans' },
    ],
  });
  const plain = stripAnsi(display.output);

  assert.match(plain, /Answer\n  The cheapest Helium Mobile plan is the Zero plan/);
  assert.match(plain, /Key Facts\n  • Zero plan: \$0\/month with 1GB cellular/);
  assert.match(plain, /Next\n  Type \/plan when ready/);
  assert.match(plain, /Sources\n  \[1\] Helium Mobile Plans - hellohelium\.com/);
  assert.doesNotMatch(plain, /<\/?cite\b/i);
  assert.doesNotMatch(plain, /index="[^"]*"/);
  assert.doesNotMatch(display.transcript, /<\/?cite\b/i);
});

test('agent chat display unwraps nested structured JSON answer strings', () => {
  const display = buildAgentChatDisplay({
    answer: `{"answer":"
  <cite index="6-36,8-14,8-15">Helium Mobile's cheapest plan is $0/month, and the Air plan is $15/month.</cite>
  ","sections":[{"title":"Key Facts","bullets":["
  Zero Plan: $0/month with 3GB data, 300 texts, 100 minutes
  ","
  Air Plan: $15/month with unlimited talk/text and 10GB data
  "]}],"next":"Type /plan, /new, or /prepare when you want to prepare a visible wallet request."}`,
    citations: [
      { kind: 'url', title: 'Helium Mobile Plans', ref: 'https://hellohelium.com/plans' },
    ],
  });
  const plain = stripAnsi(display.output);

  assert.match(plain, /Answer\n  Helium Mobile's cheapest plan is \$0\/month/);
  assert.match(plain, /Key Facts\n  • Zero Plan: \$0\/month/);
  assert.match(plain, /• Air Plan: \$15\/month/);
  assert.match(plain, /Next\n  Type \/plan, \/new, or \/prepare/);
  assert.match(plain, /Sources\n  \[1\] Helium Mobile Plans - hellohelium\.com/);
  assert.doesNotMatch(plain, /\{"answer"/);
  assert.doesNotMatch(plain, /"sections"/);
  assert.doesNotMatch(plain, /"bullets"/);
  assert.doesNotMatch(plain, /","/);
  assert.doesNotMatch(plain, /<\/?cite\b/i);
  assert.doesNotMatch(display.transcript, /\{"answer"|"sections"|"bullets"|","|<\/?cite\b/i);
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

test('ask answer display uses structured chat normalization without default next prompt', () => {
  const display = buildAgentAnswerDisplay({
    answer: `{"answer":"<cite index=\"1-2\">SPY is above 500.</cite>","sections":[{"title":"Check","bullets":["Threshold passes."]}],"citations":[{"kind":"url","title":"Quote","ref":"https://finance.example/spy"}]}`,
  });
  const plain = stripAnsi(display.output);

  assert.match(plain, /Answer\n  SPY is above 500/);
  assert.match(plain, /Check\n  • Threshold passes/);
  assert.match(plain, /Sources\n  \[1\] Quote - finance\.example/);
  assert.doesNotMatch(plain, /Type \/plan/);
  assert.doesNotMatch(plain, /<\/?cite\b/i);
});

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
