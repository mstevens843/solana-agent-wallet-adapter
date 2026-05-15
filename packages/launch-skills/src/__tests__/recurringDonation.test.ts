import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import { DEV_AUTHOR_WALLET, USDC_MINT } from '../constants.js';
import { recurringDonationSkill } from '../manifests/recurringDonation.js';
import {
  assertManifestHasNoForbiddenAuthority,
  expectCapsSane,
  expectScheduleSpec,
} from './helpers.js';

describe('recurringDonationSkill', () => {
  it('round-trips through validateSkillManifest', () => {
    const result = skills.validateSkillManifest(recurringDonationSkill);
    expect(result).toEqual(recurringDonationSkill);
  });

  it('declares the expected identity and category', () => {
    expect(recurringDonationSkill.id).toBe('recurring-donation');
    expect(recurringDonationSkill.name).toBe('Recurring Donation');
    expect(recurringDonationSkill.version).toBe('1.0.0');
    expect(recurringDonationSkill.category).toBe('donation');
    expect(recurringDonationSkill.authorWallet).toBe(DEV_AUTHOR_WALLET);
  });

  it('schedules monthly on the 1st via UTC cron', () => {
    expect(recurringDonationSkill.schedule.kind).toBe('cron');
    expect(recurringDonationSkill.schedule.spec).toBe('0 14 1 * *');
    expectScheduleSpec(recurringDonationSkill.schedule);
  });

  it('targets an SPL transfer of USDC', () => {
    expect(recurringDonationSkill.action.connectorAction).toBe('prepare_transfer_spl');
    expect(recurringDonationSkill.action.paramsTemplate.token).toBe(USDC_MINT);
    expect(recurringDonationSkill.action.paramsTemplate.amount).toBe('10');
  });

  it('requires recipient from install-time params', () => {
    expect(recurringDonationSkill.action.paramsTemplate.recipient).toBe('{{install.recipient}}');
  });

  it('has USDC-only allowlist and sane caps', () => {
    expectCapsSane(recurringDonationSkill.caps);
    expect(recurringDonationSkill.caps.allowlistedTokens).toEqual([USDC_MINT]);
    expect(recurringDonationSkill.caps.allowlistedRecipients).toBeUndefined();
    expect(recurringDonationSkill.caps.maxExecutions).toBe(12);
  });

  it('does not monetize', () => {
    expect(recurringDonationSkill.monetization).toBeUndefined();
  });

  it('contains no forbidden authority phrases', () => {
    assertManifestHasNoForbiddenAuthority(recurringDonationSkill);
  });
});
