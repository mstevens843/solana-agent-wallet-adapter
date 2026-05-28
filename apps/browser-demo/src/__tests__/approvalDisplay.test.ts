import { describe, expect, it } from 'vitest';

import { approvalErrorMessages } from '../approvalDisplay.js';

describe('approvalErrorMessages', () => {
  it('renders one message when error and txError match', () => {
    const message = 'Transaction abc was not found on-chain after 90 seconds.';
    expect(approvalErrorMessages({ error: message, txError: message })).toEqual([message]);
  });

  it('dedupes messages that differ only by whitespace', () => {
    expect(approvalErrorMessages({
      error: 'Transaction abc was not found on-chain after 90 seconds.',
      txError: ' Transaction abc was not found on-chain after 90 seconds. ',
    })).toEqual(['Transaction abc was not found on-chain after 90 seconds.']);
  });

  it('keeps distinct error details', () => {
    expect(approvalErrorMessages({
      error: 'Transaction failed on-chain.',
      txError: 'Instruction 2 failed.',
    })).toEqual(['Transaction failed on-chain.', 'Instruction 2 failed.']);
  });

  it('drops empty fields', () => {
    expect(approvalErrorMessages({ error: '', txError: '  ' })).toEqual([]);
  });
});
