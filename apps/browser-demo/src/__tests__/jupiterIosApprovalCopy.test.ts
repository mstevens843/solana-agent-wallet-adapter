import { describe, expect, it } from 'vitest';

import {
  JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL,
  JUPITER_IOS_MANUAL_APPROVAL_URL,
  jupiterIosManualApprovalMessage,
} from '../jupiterIosApprovalCopy.js';

describe('Jupiter iOS manual approval copy', () => {
  it('keeps the approval instruction short and user-facing', () => {
    expect(jupiterIosManualApprovalMessage('Approve the proof in your wallet.')).toBe(
      "Open Jupiter to approve. Return to Agentic when it's done. Approve the proof in your wallet.",
    );
  });

  it('uses only the root Jupiter app URL for the manual open action', () => {
    expect(JUPITER_IOS_MANUAL_APPROVAL_ACTION_LABEL).toBe('Open Jupiter');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).toBe('jupiter://');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).not.toContain('jup.ag');
    expect(JUPITER_IOS_MANUAL_APPROVAL_URL).not.toContain('wc?');
  });
});
