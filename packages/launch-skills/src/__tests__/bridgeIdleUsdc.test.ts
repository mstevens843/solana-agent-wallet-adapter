import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import { DEV_AUTHOR_WALLET, USDC_MINT } from '../constants.js';
import { bridgeIdleUsdcSkill } from '../manifests/bridgeIdleUsdc.js';
import {
  assertManifestHasNoForbiddenAuthority,
  expectCapsSane,
  expectScheduleSpec,
} from './helpers.js';

describe('bridgeIdleUsdcSkill', () => {
  it('round-trips through validateSkillManifest', () => {
    const result = skills.validateSkillManifest(bridgeIdleUsdcSkill);
    expect(result).toEqual(bridgeIdleUsdcSkill);
  });

  it('declares the expected identity and category', () => {
    expect(bridgeIdleUsdcSkill.id).toBe('bridge-idle-usdc');
    expect(bridgeIdleUsdcSkill.name).toBe('Bridge Idle USDC');
    expect(bridgeIdleUsdcSkill.version).toBe('1.0.0');
    expect(bridgeIdleUsdcSkill.category).toBe('bridge');
    expect(bridgeIdleUsdcSkill.authorWallet).toBe(DEV_AUTHOR_WALLET);
  });

  it('schedules weekly Mondays via UTC cron', () => {
    expect(bridgeIdleUsdcSkill.schedule.kind).toBe('cron');
    expect(bridgeIdleUsdcSkill.schedule.spec).toBe('0 15 * * 1');
    expectScheduleSpec(bridgeIdleUsdcSkill.schedule);
  });

  it('targets a Wormhole transfer from Solana to Base with auto route', () => {
    expect(bridgeIdleUsdcSkill.action.connectorAction).toBe('prepare_wormhole_transfer');
    expect(bridgeIdleUsdcSkill.action.paramsTemplate.sourceMint).toBe(USDC_MINT);
    expect(bridgeIdleUsdcSkill.action.paramsTemplate.destinationChain).toBe('Base');
    expect(bridgeIdleUsdcSkill.action.paramsTemplate.routeType).toBe('auto');
  });

  it('requires destinationAddress from install-time params', () => {
    expect(bridgeIdleUsdcSkill.action.paramsTemplate.destinationAddress).toBe('{{install.destinationAddress}}');
  });

  it('has USDC-only allowlist and sane caps', () => {
    expectCapsSane(bridgeIdleUsdcSkill.caps);
    expect(bridgeIdleUsdcSkill.caps.allowlistedTokens).toEqual([USDC_MINT]);
    expect(bridgeIdleUsdcSkill.caps.maxExecutions).toBe(12);
  });

  it('does not monetize', () => {
    expect(bridgeIdleUsdcSkill.monetization).toBeUndefined();
  });

  it('contains no forbidden authority phrases', () => {
    assertManifestHasNoForbiddenAuthority(bridgeIdleUsdcSkill);
  });
});
