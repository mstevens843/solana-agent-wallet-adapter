import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractUsdFromQuote } from '../flows/safetyGate.js';

test('prefers swapUsdValue (Jupiter v6 pre-computed USD float)', () => {
  const quote = { swapUsdValue: 0.84, outAmount: 843621 };
  assert.equal(extractUsdFromQuote(quote), 0.84);
});

test('falls back through inUsdValue and outUsdValue in order', () => {
  assert.equal(extractUsdFromQuote({ inUsdValue: 0.84, outAmount: 843621 }), 0.84);
  assert.equal(extractUsdFromQuote({ outUsdValue: 0.84, outAmount: 843621 }), 0.84);
});

test('accepts string-encoded USD floats', () => {
  assert.equal(extractUsdFromQuote({ swapUsdValue: '12.34' }), 12.34);
});

test('falls back to outAmount / 1e6 when USD fields missing (USDC base units)', () => {
  // This is the regression: 0.01 SOL at ~$84.36 made Jupiter return outAmount: 843621
  // (= 0.843621 USDC in 6-decimal base units). Previously treated as $843,621 dollars.
  assert.equal(extractUsdFromQuote({ outAmount: 843621 }), 0.843621);
  assert.equal(extractUsdFromQuote({ outputAmount: '500000' }), 0.5);
  assert.equal(extractUsdFromQuote({ expectedOutput: 1_000_000 }), 1);
});

test('returns null when neither USD fields nor outAmount are present', () => {
  assert.equal(extractUsdFromQuote({}), null);
  assert.equal(extractUsdFromQuote({ unrelated: 'data' }), null);
});

test('returns null for non-numeric values in all positions', () => {
  assert.equal(extractUsdFromQuote({ swapUsdValue: 'not-a-number' }), null);
  assert.equal(extractUsdFromQuote({ outAmount: {} as unknown as number }), null);
});

test('USD field with NaN falls through to outAmount fallback', () => {
  // Guard: if swapUsdValue is somehow corrupt (NaN), don't return NaN — use the
  // raw amount fallback so the caller still gets a sane price (or null).
  assert.equal(extractUsdFromQuote({ swapUsdValue: 'NaN', outAmount: 843621 }), 0.843621);
});

test('accepts zero USD value (real edge case for tiny amounts)', () => {
  assert.equal(extractUsdFromQuote({ swapUsdValue: 0 }), 0);
  assert.equal(extractUsdFromQuote({ outAmount: 0 }), 0);
});

test('rejects negative values from either source', () => {
  // Defensive: a negative USD value would indicate a bug in the upstream quote.
  // Returning null lets the caller fall into the "couldn't price" panel rather
  // than show a negative dollar figure to the user.
  assert.equal(extractUsdFromQuote({ swapUsdValue: -5, outAmount: 843621 }), 0.843621);
  assert.equal(extractUsdFromQuote({ outAmount: -100 }), null);
});
