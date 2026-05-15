import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import { DEV_AUTHOR_WALLET, USDC_MINT, WSOL_MINT } from '../constants.js';
import { fridayDcaSkill } from '../manifests/fridayDca.js';
import {
  assertManifestHasNoForbiddenAuthority,
  expectCapsSane,
  expectScheduleSpec,
} from './helpers.js';

describe('fridayDcaSkill', () => {
  it('round-trips through validateSkillManifest', () => {
    const result = skills.validateSkillManifest(fridayDcaSkill);
    expect(result).toEqual(fridayDcaSkill);
  });

  it('declares the expected identity and category', () => {
    expect(fridayDcaSkill.id).toBe('friday-dca');
    expect(fridayDcaSkill.name).toBe('Friday DCA');
    expect(fridayDcaSkill.version).toBe('1.0.0');
    expect(fridayDcaSkill.category).toBe('dca');
    expect(fridayDcaSkill.authorWallet).toBe(DEV_AUTHOR_WALLET);
  });

  it('schedules weekly Fridays via UTC cron', () => {
    expect(fridayDcaSkill.schedule.kind).toBe('cron');
    expect(fridayDcaSkill.schedule.spec).toBe('0 14 * * 5');
    expectScheduleSpec(fridayDcaSkill.schedule);
  });

  it('targets a Jupiter swap from USDC to SOL', () => {
    expect(fridayDcaSkill.action.connectorAction).toBe('prepare_swap');
    expect(fridayDcaSkill.action.paramsTemplate.inputMint).toBe(USDC_MINT);
    expect(fridayDcaSkill.action.paramsTemplate.outputMint).toBe(WSOL_MINT);
  });

  it('has sane caps allowlisting both swap tokens', () => {
    expectCapsSane(fridayDcaSkill.caps);
    expect(fridayDcaSkill.caps.allowlistedTokens).toContain(USDC_MINT);
    expect(fridayDcaSkill.caps.allowlistedTokens).toContain(WSOL_MINT);
    expect(fridayDcaSkill.caps.maxExecutions).toBe(52);
    expect(fridayDcaSkill.caps.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not monetize and has no composability dependencies', () => {
    expect(fridayDcaSkill.monetization).toBeUndefined();
    expect(fridayDcaSkill.dependencies).toBeUndefined();
  });

  it('contains no forbidden authority phrases', () => {
    assertManifestHasNoForbiddenAuthority(fridayDcaSkill);
  });
});
