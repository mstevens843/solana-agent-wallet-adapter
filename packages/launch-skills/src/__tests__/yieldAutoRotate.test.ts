import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import { DEV_AUTHOR_WALLET, USDC_MINT } from '../constants.js';
import { yieldAutoRotateSkill } from '../manifests/yieldAutoRotate.js';
import {
  assertManifestHasNoForbiddenAuthority,
  expectCapsSane,
  expectScheduleSpec,
} from './helpers.js';

describe('yieldAutoRotateSkill', () => {
  it('round-trips through validateSkillManifest', () => {
    const result = skills.validateSkillManifest(yieldAutoRotateSkill);
    expect(result).toEqual(yieldAutoRotateSkill);
  });

  it('declares the expected identity and category', () => {
    expect(yieldAutoRotateSkill.id).toBe('yield-auto-rotate');
    expect(yieldAutoRotateSkill.name).toBe('Yield Auto-Rotate');
    expect(yieldAutoRotateSkill.version).toBe('1.0.0');
    expect(yieldAutoRotateSkill.category).toBe('yield');
    expect(yieldAutoRotateSkill.authorWallet).toBe(DEV_AUTHOR_WALLET);
  });

  it('schedules daily via UTC cron', () => {
    expect(yieldAutoRotateSkill.schedule.kind).toBe('cron');
    expect(yieldAutoRotateSkill.schedule.spec).toBe('0 13 * * *');
    expectScheduleSpec(yieldAutoRotateSkill.schedule);
  });

  it('uses the yield.auto_rotate sentinel for runtime resolution', () => {
    expect(yieldAutoRotateSkill.action.connectorAction).toBe('yield.auto_rotate');
    expect(yieldAutoRotateSkill.action.connectorAction).toContain('.');
    expect(yieldAutoRotateSkill.action.paramsTemplate.token).toBe(USDC_MINT);
    expect(yieldAutoRotateSkill.action.paramsTemplate.minApyDeltaBps).toBe(50);
  });

  it('has USDC-only allowlist and sane caps', () => {
    expectCapsSane(yieldAutoRotateSkill.caps);
    expect(yieldAutoRotateSkill.caps.allowlistedTokens).toEqual([USDC_MINT]);
    expect(yieldAutoRotateSkill.caps.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('monetizes monthly at $0.99 to the author wallet', () => {
    expect(yieldAutoRotateSkill.monetization).toBeDefined();
    expect(yieldAutoRotateSkill.monetization?.kind).toBe('monthly');
    expect(yieldAutoRotateSkill.monetization?.amount).toBe('0.99');
    expect(yieldAutoRotateSkill.monetization?.payoutWallet).toBe(DEV_AUTHOR_WALLET);
    expect(yieldAutoRotateSkill.monetization?.feePercent).toBeUndefined();
  });

  it('contains no forbidden authority phrases', () => {
    assertManifestHasNoForbiddenAuthority(yieldAutoRotateSkill);
  });
});
