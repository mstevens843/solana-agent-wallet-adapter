import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from '../index.js';
import { aggregator } from '../dev/index.js';

describe('DevLayer1 aggregator validators', () => {
  it('normalizes valid rollup query fields', () => {
    expect(aggregator.validateAggregatorRollupQuery({
      sinceIso: ' 2026-05-08T20:00:00.000Z ',
      skillIds: ['friday-dca', 'yield-auto-rotate'],
    })).toEqual({
      sinceIso: '2026-05-08T20:00:00.000Z',
      skillIds: ['friday-dca', 'yield-auto-rotate'],
    });
  });

  it('rejects unknown fields', () => {
    expect(() => aggregator.validateAggregatorRollupQuery({ limit: 10 }))
      .toThrow(WorkflowValidationError);
  });

  it('rejects invalid dates and malformed skill ids', () => {
    expect(() => aggregator.validateAggregatorRollupQuery({ sinceIso: 'not-a-date' }))
      .toThrow(/sinceIso/);
    expect(() => aggregator.validateAggregatorRollupQuery({ skillIds: ['BadSkill'] }))
      .toThrow(/skillIds entries/);
  });
});
