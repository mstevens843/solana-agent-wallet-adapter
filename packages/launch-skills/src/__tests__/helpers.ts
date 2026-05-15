import { expect } from 'vitest';

export const FORBIDDEN_AUTHORITY_NEEDLES: readonly string[] = [
  'privatekey',
  'secretkey',
  'seedphrase',
  'recoveryphrase',
  'mnemonic',
  'delegatedsigner',
  'delegatesigner',
  'unlimitedapproval',
  'private key',
  'seed phrase',
  'recovery phrase',
  'secret key',
  'delegated signer',
  'server signer',
  'unlimited approval',
  'unrestricted authority',
];

export function assertManifestHasNoForbiddenAuthority(manifest: unknown): void {
  const serialized = JSON.stringify(manifest).toLowerCase();
  for (const needle of FORBIDDEN_AUTHORITY_NEEDLES) {
    expect(serialized.includes(needle), `forbidden phrase "${needle}" must not appear in manifest`).toBe(false);
  }
}

const CRON_5_FIELD = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
const ISO_8601_DURATION = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;

export function expectScheduleSpec(schedule: { kind: string; spec: string }): void {
  expect(schedule.spec.length).toBeGreaterThan(0);
  if (schedule.kind === 'cron') {
    expect(schedule.spec).toMatch(CRON_5_FIELD);
    return;
  }
  if (schedule.kind === 'interval') {
    expect(schedule.spec).toMatch(ISO_8601_DURATION);
    expect(schedule.spec).not.toBe('P');
    return;
  }
  if (schedule.kind === 'price-trigger') {
    const parsed = JSON.parse(schedule.spec) as Record<string, unknown>;
    expect(typeof parsed.feedId).toBe('string');
    expect(['<', '<=', '>', '>=']).toContain(parsed.op);
    expect(typeof parsed.threshold).toBe('string');
    return;
  }
  throw new Error(`unknown schedule.kind: ${schedule.kind}`);
}

export function expectCapsSane(caps: {
  perRunMaxAmount: string;
  lifetimeMaxAmount: string;
  allowlistedTokens: string[];
}): void {
  expect(caps.allowlistedTokens.length).toBeGreaterThanOrEqual(1);
  const perRun = Number(caps.perRunMaxAmount);
  const lifetime = Number(caps.lifetimeMaxAmount);
  expect(Number.isFinite(perRun)).toBe(true);
  expect(perRun).toBeGreaterThan(0);
  expect(Number.isFinite(lifetime)).toBe(true);
  expect(lifetime).toBeGreaterThanOrEqual(perRun);
}
