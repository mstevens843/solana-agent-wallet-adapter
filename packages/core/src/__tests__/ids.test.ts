import { describe, expect, it } from 'vitest';

import { newSigningRequestId } from '../ids.js';

describe('newSigningRequestId', () => {
  it('returns sar_ plus 24 lowercase hex characters', () => {
    expect(newSigningRequestId()).toMatch(/^sar_[0-9a-f]{24}$/);
  });

  it('does not collide over 1000 generated ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newSigningRequestId()));
    expect(ids.size).toBe(1000);
  });
});
