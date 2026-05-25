import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAgentActionChoices,
  buildOverrideNote,
  buildReviewLine,
  composeNote,
} from '../flows/agent.js';

test('agent choices always offer the queue path so the user can override', () => {
  const cases = [
    buildAgentActionChoices({ blocked: false, needsInput: false }),
    buildAgentActionChoices({ blocked: true, needsInput: false }),
    buildAgentActionChoices({ blocked: false, needsInput: true }),
    buildAgentActionChoices({ blocked: false, needsInput: false, reviewIndeterminate: true }),
  ];

  for (const choices of cases) {
    const values = choices.map((c) => c.value);
    assert.ok(values.includes('queue'), 'queue must always be offered so the user can override');
    assert.ok(values.includes('both'), 'both must always be offered');
    assert.ok(values.includes('proof'));
    assert.ok(values.includes('done'));
  }
});

test('queue label rephrases per override reason (denial / questions / unfinished review)', () => {
  const approveLabel = labelFor(buildAgentActionChoices({ blocked: false, needsInput: false }));
  const denyLabel = labelFor(buildAgentActionChoices({ blocked: true, needsInput: false }));
  const needsInputLabel = labelFor(buildAgentActionChoices({ blocked: false, needsInput: true }));
  const indeterminateLabel = labelFor(
    buildAgentActionChoices({ blocked: false, needsInput: false, reviewIndeterminate: true }),
  );

  assert.equal(approveLabel, 'Queue as a prepared approval (sends to /inbox)');
  assert.match(denyLabel, /Queue anyway/);
  assert.match(denyLabel, /denial/);
  assert.match(needsInputLabel, /Queue anyway/);
  assert.match(needsInputLabel, /questions/);
  assert.match(indeterminateLabel, /Queue anyway/);
  assert.match(indeterminateLabel, /unfinished review/);
});

function labelFor(choices: ReturnType<typeof buildAgentActionChoices>): string {
  return choices.find((c) => c.value === 'queue')!.name;
}

test('override note uses capital "Override:" prefix to match browser-demo (main.ts:37955)', () => {
  assert.equal(buildOverrideNote('denied', undefined), 'Override: agent denied');
  assert.equal(buildOverrideNote('denied', 'urgent payroll'), 'Override: agent denied; user: urgent payroll');
  assert.equal(buildOverrideNote('needs_input', undefined), 'Override: agent needed input');
  assert.equal(
    buildOverrideNote('needs_input', '  manual review pending  '),
    'Override: agent needed input; user: manual review pending',
  );
  assert.equal(
    buildOverrideNote('indeterminate', undefined),
    'Override: agent review unfinished',
  );
  assert.equal(
    buildOverrideNote('indeterminate', 'bridge AI key invalid'),
    'Override: agent review unfinished; user: bridge AI key invalid',
  );
});

test('reviewLine renders the agent verdict context that joins the note', () => {
  assert.equal(buildReviewLine('denied', undefined), 'Agent denied');
  assert.equal(buildReviewLine('denied', 'amount over $100 cap'), 'Agent denied: amount over $100 cap');
  assert.equal(buildReviewLine('needs_input', 'which mint?'), 'Agent needs input: which mint?');
  assert.equal(buildReviewLine('indeterminate', undefined), 'Agent review unfinished');
});

test('composeNote handles base + single string override', () => {
  assert.equal(composeNote(undefined, undefined), undefined);
  assert.equal(composeNote('rent for Q3', undefined), 'rent for Q3');
  assert.equal(composeNote(undefined, 'Override: agent denied'), 'Override: agent denied');
  assert.equal(
    composeNote('rent for Q3', 'Override: agent denied; user: tenant approved'),
    'rent for Q3 | Override: agent denied; user: tenant approved',
  );
});

test('composeNote accepts an array of override pieces (review line + override)', () => {
  assert.equal(
    composeNote('stake 0.01 SOL', ['Agent denied: cap exceeded', 'Override: agent denied; user: ok']),
    'stake 0.01 SOL | Agent denied: cap exceeded | Override: agent denied; user: ok',
  );
  // Empty / undefined entries in the array are dropped, not rendered as " |  | ".
  assert.equal(
    composeNote('stake 0.01 SOL', [undefined, 'Override: agent denied', '']),
    'stake 0.01 SOL | Override: agent denied',
  );
  assert.equal(
    composeNote(undefined, ['Agent denied', 'Override: agent denied']),
    'Agent denied | Override: agent denied',
  );
});

test('composeNote preserves the override block when the combined note overflows 500 chars', () => {
  const longBase = 'b'.repeat(400);
  const override = 'Override: agent denied; user: ' + 'x'.repeat(200); // 230 chars total
  const result = composeNote(longBase, override);
  assert.ok(result, 'expected a result');
  assert.equal(result.length, 500);
  assert.ok(result.endsWith(override), 'the override block must survive truncation in full');
  assert.ok(result.includes('…'), 'the base note should be ellipsized');
});

test('composeNote returns the verbatim override head when the override alone exceeds 500 chars', () => {
  const longOverride = 'Override: agent denied; user: ' + 'x'.repeat(600); // 630 chars
  const result = composeNote('short base', longOverride);
  assert.ok(result);
  assert.equal(result.length, 500);
  assert.ok(result.startsWith('Override: agent denied'));
});
