import { skills } from '@solana-agent-wallet-adapter/workflow/dev';
import { describe, expect, it } from 'vitest';

import {
  LAUNCH_SKILLS,
  bridgeIdleUsdcSkill,
  fridayDcaSkill,
  pythStopLossSkill,
  recurringDonationSkill,
  yieldAutoRotateSkill,
} from '../index.js';
import { assertManifestHasNoForbiddenAuthority } from './helpers.js';

describe('LAUNCH_SKILLS catalog', () => {
  it('contains exactly five manifests', () => {
    expect(LAUNCH_SKILLS).toHaveLength(5);
  });

  it('orders the catalog as Friday DCA, Yield Auto-Rotate, Pyth Stop-Loss, Bridge Idle USDC, Recurring Donation', () => {
    expect(LAUNCH_SKILLS.map((s) => s.id)).toEqual([
      'friday-dca',
      'yield-auto-rotate',
      'pyth-stop-loss',
      'bridge-idle-usdc',
      'recurring-donation',
    ]);
  });

  it('exports each manifest both by name and inside the LAUNCH_SKILLS array', () => {
    expect(LAUNCH_SKILLS).toContain(fridayDcaSkill);
    expect(LAUNCH_SKILLS).toContain(yieldAutoRotateSkill);
    expect(LAUNCH_SKILLS).toContain(pythStopLossSkill);
    expect(LAUNCH_SKILLS).toContain(bridgeIdleUsdcSkill);
    expect(LAUNCH_SKILLS).toContain(recurringDonationSkill);
  });

  it('has globally unique ids', () => {
    const ids = LAUNCH_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has globally unique (id, version) pairs', () => {
    const keys = LAUNCH_SKILLS.map((s) => `${s.id}@${s.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('round-trips every manifest through validateSkillManifest', () => {
    for (const manifest of LAUNCH_SKILLS) {
      expect(skills.validateSkillManifest(manifest)).toEqual(manifest);
    }
  });

  it('exposes only one sentinel (dot-containing) connectorAction in v1: yield.auto_rotate', () => {
    const sentinelActions = LAUNCH_SKILLS.filter((s) => s.action.connectorAction.includes('.')).map(
      (s) => s.action.connectorAction,
    );
    expect(sentinelActions).toEqual(['yield.auto_rotate']);
  });

  it('monetizes exactly one launch skill (yield-auto-rotate)', () => {
    const monetized = LAUNCH_SKILLS.filter((s) => s.monetization !== undefined);
    expect(monetized).toHaveLength(1);
    expect(monetized[0]?.id).toBe('yield-auto-rotate');
  });

  it('contains no forbidden authority phrases anywhere in the catalog', () => {
    for (const manifest of LAUNCH_SKILLS) {
      assertManifestHasNoForbiddenAuthority(manifest);
    }
  });

  it('does not ship empty string action params', () => {
    for (const manifest of LAUNCH_SKILLS) {
      const serialized = JSON.stringify(manifest.action.paramsTemplate);
      expect(serialized).not.toContain('""');
    }
  });

  it('caps every manifest with at least one allowlisted token', () => {
    for (const manifest of LAUNCH_SKILLS) {
      expect(manifest.caps.allowlistedTokens.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses the same author wallet across the launch catalog', () => {
    const authors = new Set(LAUNCH_SKILLS.map((s) => s.authorWallet));
    expect(authors.size).toBe(1);
  });
});
