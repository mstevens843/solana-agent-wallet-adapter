import { describe, expect, it } from 'vitest';

import {
  evidenceEntryTone,
  isTokenMismatchEvidenceKey,
  swapTokenTextMismatchWarning,
  tokenMismatchEvidenceRows,
} from '../agentReviewPresentation.js';
import type { AgentPlan } from '../planner.js';

const POPCAT_MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function swapPlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    intent: 'Review DeFi swap of 0.1 SOL to USDC',
    route: 'SOL -> USDC',
    risk: 'Medium',
    approval: 'User wallet approval',
    source: 'template',
    category: 'trading',
    actionType: 'swap',
    templateTitle: 'Swap tokens',
    userNotes: '',
    parameters: {
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.1',
      slippageBps: '50',
    },
    fields: [],
    safeguards: [],
    ...overrides,
  };
}

describe('agent review presentation helpers', () => {
  it('warns when swap text says USDC but the active output token is a different mint', () => {
    const warning = swapTokenTextMismatchWarning(
      swapPlan({ parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' } }),
      (value) => value === POPCAT_MINT ? 'POPCAT' : value,
    );

    expect(warning).toMatchObject({
      expectedToken: 'USDC',
      actualToken: 'POPCAT',
      actualValue: POPCAT_MINT,
    });
    expect(warning?.message).toContain('Draft text mentions USDC');
  });

  it('does not warn when swap text and output token are both USDC', () => {
    expect(swapTokenTextMismatchWarning(swapPlan())).toBeUndefined();
    expect(swapTokenTextMismatchWarning(
      swapPlan({ parameters: { inputToken: 'SOL', outputToken: USDC_MINT, amount: '0.1', slippageBps: '50' } }),
    )).toBeUndefined();
  });

  it('does not warn when a custom mint is consistently described as that custom token', () => {
    expect(swapTokenTextMismatchWarning(swapPlan({
      intent: 'Review DeFi swap of 0.1 SOL to POPCAT',
      route: `SOL -> ${POPCAT_MINT}`,
      userNotes: 'Swap to POPCAT for the demo.',
      parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' },
    }))).toBeUndefined();
  });

  it('does not warn from stale prose when the route already uses the active output mint', () => {
    expect(swapTokenTextMismatchWarning(swapPlan({
      intent: 'Review DeFi swap of 0.1 SOL to USDC',
      route: `SOL -> ${POPCAT_MINT}`,
      userNotes: 'Review a new defi position before signing.',
      parameters: { inputToken: 'SOL', outputToken: POPCAT_MINT, amount: '0.1', slippageBps: '50' },
    }))).toBeUndefined();
  });

  it('promotes token mismatch evidence into a fail row', () => {
    const rows = tokenMismatchEvidenceRows({
      tokenMismatch: true,
      intendedToken: 'USDC',
      actualToken: 'POPCAT',
      actualMint: POPCAT_MINT,
    });

    expect(rows).toEqual([{
      label: 'Token mismatch',
      value: `expected USDC; actual POPCAT; mint ${POPCAT_MINT}`,
      tone: 'fail',
    }]);
  });

  it('marks generic mismatch evidence keys and copy as fail tone', () => {
    expect(isTokenMismatchEvidenceKey('actualMint')).toBe(true);
    expect(isTokenMismatchEvidenceKey('actual_output_token')).toBe(true);
    expect(evidenceEntryTone('Token mismatch', 'Wrong token')).toBe('fail');
    expect(evidenceEntryTone('Market data', 'Liquidity checked')).toBe('neutral');
  });
});
