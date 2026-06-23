import { describe, expect, it } from 'vitest';

import { chatSignProofStatement, isChatSignProofAction } from '../chatProof.js';

describe('chat sign proof helpers', () => {
  it('detects chat-created sign proof actions', () => {
    expect(isChatSignProofAction({
      kind: 'manual_review',
      params: { proofKind: 'sign_proof', statement: 'I reviewed Q3.' },
    })).toBe(true);
    expect(isChatSignProofAction({
      kind: 'manual_review',
      params: { proofKind: 'other' },
    })).toBe(false);
  });

  it('returns the normalized statement the wallet should sign and the receipt should show', () => {
    expect(chatSignProofStatement({
      kind: 'manual_review',
      params: { proofKind: 'sign_proof', statement: '  I attest that Helium Mobile is under $20.  ' },
      note: 'fallback',
    })).toBe('I attest that Helium Mobile is under $20.');
  });

  it('falls back to note for older sign proof snapshots', () => {
    expect(chatSignProofStatement({
      kind: 'manual_review',
      params: { proofKind: 'sign_proof' },
      note: 'I approve this statement.',
    })).toBe('I approve this statement.');
  });
});
