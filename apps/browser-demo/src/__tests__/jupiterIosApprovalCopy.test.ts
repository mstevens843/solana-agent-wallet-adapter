import { describe, expect, it } from 'vitest';

import {
  JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL,
  JUPITER_IOS_MANUAL_APPROVAL_URL,
  jupiterIosManualApprovalMessage,
} from '../jupiterIosApprovalCopy.js';

describe('Jupiter iOS approval copy', () => {
  it('promises an automatic return when notifications are available', () => {
    expect(jupiterIosManualApprovalMessage('Approve the proof in your wallet.')).toBe(
      "Approve in Jupiter. We'll bring you back here when it's done. Approve the proof in your wallet.",
    );
  });

  it('falls back to manual-return copy when notifications are denied', () => {
    expect(
      jupiterIosManualApprovalMessage('Approve the proof in your wallet.', { canNotify: false }),
    ).toBe(
      'Approve in Jupiter, then come back to Agentic to see the result. Approve the proof in your wallet.',
    );
  });

  it('returns just the prefix when no detail is supplied', () => {
    expect(jupiterIosManualApprovalMessage()).toBe(
      "Approve in Jupiter. We'll bring you back here when it's done.",
    );
    expect(jupiterIosManualApprovalMessage('   ')).toBe(
      "Approve in Jupiter. We'll bring you back here when it's done.",
    );
  });

  it('uses only the root Jupiter app URL for the manual open action', () => {
    expect(JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL).toBe('Open Jupiter');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).toBe('jupiter://');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).not.toContain('jup.ag');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).not.toContain('wc?');
  });
});
