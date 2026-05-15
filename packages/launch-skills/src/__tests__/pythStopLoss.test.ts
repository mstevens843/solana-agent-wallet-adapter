import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import { DEV_AUTHOR_WALLET, PYTH_SOL_USD_FEED, USDC_MINT, WSOL_MINT } from '../constants.js';
import { pythStopLossSkill } from '../manifests/pythStopLoss.js';
import {
  assertManifestHasNoForbiddenAuthority,
  expectCapsSane,
  expectScheduleSpec,
} from './helpers.js';

describe('pythStopLossSkill', () => {
  it('round-trips through validateSkillManifest', () => {
    const result = skills.validateSkillManifest(pythStopLossSkill);
    expect(result).toEqual(pythStopLossSkill);
  });

  it('declares the expected identity and category', () => {
    expect(pythStopLossSkill.id).toBe('pyth-stop-loss');
    expect(pythStopLossSkill.name).toBe('Pyth Stop-Loss');
    expect(pythStopLossSkill.version).toBe('1.0.0');
    expect(pythStopLossSkill.category).toBe('stops');
    expect(pythStopLossSkill.authorWallet).toBe(DEV_AUTHOR_WALLET);
  });

  it('is a price-trigger schedule pointing at the Pyth SOL/USD feed', () => {
    expect(pythStopLossSkill.schedule.kind).toBe('price-trigger');
    expectScheduleSpec(pythStopLossSkill.schedule);
    const parsed = JSON.parse(pythStopLossSkill.schedule.spec) as Record<string, unknown>;
    expect(parsed.feedId).toBe(PYTH_SOL_USD_FEED);
    expect(typeof parsed.feedId === 'string' && parsed.feedId.startsWith('0x')).toBe(true);
    expect(parsed.op).toBe('<');
    expect(parsed.threshold).toBe('100');
  });

  it('targets a Jupiter swap from SOL to USDC', () => {
    expect(pythStopLossSkill.action.connectorAction).toBe('prepare_swap');
    expect(pythStopLossSkill.action.paramsTemplate.inputMint).toBe(WSOL_MINT);
    expect(pythStopLossSkill.action.paramsTemplate.outputMint).toBe(USDC_MINT);
    expect(pythStopLossSkill.action.paramsTemplate.slippageBps).toBe(100);
  });

  it('caps lifetime at exactly one execution', () => {
    expectCapsSane(pythStopLossSkill.caps);
    expect(pythStopLossSkill.caps.maxExecutions).toBe(1);
    expect(pythStopLossSkill.caps.perRunMaxAmount).toBe(pythStopLossSkill.caps.lifetimeMaxAmount);
    expect(pythStopLossSkill.caps.allowlistedTokens).toContain(WSOL_MINT);
    expect(pythStopLossSkill.caps.allowlistedTokens).toContain(USDC_MINT);
  });

  it('does not monetize', () => {
    expect(pythStopLossSkill.monetization).toBeUndefined();
  });

  it('contains no forbidden authority phrases', () => {
    assertManifestHasNoForbiddenAuthority(pythStopLossSkill);
  });
});
