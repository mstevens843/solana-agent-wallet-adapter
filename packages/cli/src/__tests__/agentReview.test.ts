import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { composeNoteWithReview } from '../forms/agentReview.js';
import { reviewSummaryLine } from '../forms/agentReviewRender.js';

test('reviewSummaryLine renders an approve verdict with summary', () => {
  const line = reviewSummaryLine({
    decision: 'approve',
    summary: 'Helium plan $15/mo meets the $20 threshold.',
  });
  assert.equal(line, 'Agent approved: Helium plan $15/mo meets the $20 threshold.');
});

test('reviewSummaryLine renders a deny verdict with reason fallback', () => {
  const line = reviewSummaryLine({
    decision: 'deny',
    reason: 'SOL at $85 below required $1,000,000.',
  });
  assert.equal(line, 'Agent denied: SOL at $85 below required $1,000,000.');
});

test('reviewSummaryLine truncates very long summaries to keep note under 200 chars', () => {
  const long = 'a'.repeat(500);
  const line = reviewSummaryLine({ decision: 'approve', summary: long });
  assert.ok(line.length <= 200, `expected <= 200 chars, got ${line.length}`);
  assert.ok(line.endsWith('…'));
});

test('composeNoteWithReview joins base + review + override under the 500-char limit', () => {
  const note = composeNoteWithReview(
    'Buy USDC',
    'Agent approved: Helium plan OK',
    undefined,
  );
  assert.equal(note, 'Buy USDC | Agent approved: Helium plan OK');
});

test('composeNoteWithReview appends override line when present', () => {
  const note = composeNoteWithReview(
    'Buy USDC',
    'Agent denied: threshold failed',
    'Override: agent denied',
  );
  assert.equal(note, 'Buy USDC | Agent denied: threshold failed | Override: agent denied');
});

test('composeNoteWithReview returns undefined when all parts blank', () => {
  assert.equal(composeNoteWithReview(undefined, undefined, undefined), undefined);
  assert.equal(composeNoteWithReview('   ', '   ', '   '), undefined);
});

test('composeNoteWithReview trims base when over the 500-char limit, preserving the audit tail', () => {
  const longBase = 'b'.repeat(490);
  const review = 'Agent approved: ok';
  const override = 'Override: agent denied';
  const note = composeNoteWithReview(longBase, review, override)!;
  assert.ok(note.length <= 500);
  assert.ok(note.endsWith(`${review} | ${override}`), 'audit tail must be preserved verbatim');
  assert.ok(note.includes('…'), 'base must be ellipsized when trimmed');
});

test('composeNoteWithReview returns just the review summary when base is empty', () => {
  assert.equal(
    composeNoteWithReview(undefined, 'Agent approved: ok', undefined),
    'Agent approved: ok',
  );
});
