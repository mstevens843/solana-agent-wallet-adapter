import { describe, expect, it, vi } from 'vitest';

import {
  cronMatches,
  evaluateSchedule,
  nextCronFiringAfter,
  nextCronFiringBefore,
  parseCronSpec,
  parseIntervalSpec,
  parsePriceTriggerSpec,
} from '../scheduler.js';
import type { SchedulerInput, SkillInstallRecord, SkillManifest } from '../types.js';

const WALLET = 'Wallet1111111111111111111111111111111111111';

const baseManifest = (overrides: Partial<SkillManifest> = {}): SkillManifest => ({
  id: 'friday-dca',
  name: 'Friday DCA',
  version: '1.0.0',
  authorWallet: 'Author11111111111111111111111111111111111',
  description: 'DCA every Friday',
  category: 'dca',
  schedule: { kind: 'cron', spec: '0 9 * * FRI' },
  action: { connectorAction: 'swap', paramsTemplate: { inputToken: 'USDC', amount: '50' } },
  caps: {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '5000',
    allowlistedTokens: ['USDC'],
  },
  ...overrides,
});

const baseInstall = (overrides: Partial<SkillInstallRecord> = {}): SkillInstallRecord => ({
  id: 'install_1',
  walletAddress: WALLET,
  skillId: 'friday-dca',
  manifestVersion: '1.0.0',
  caps: {
    perRunMaxAmount: '50',
    lifetimeMaxAmount: '5000',
    allowlistedTokens: ['USDC'],
  },
  installedAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  status: 'active',
  ...overrides,
});

describe('parseIntervalSpec', () => {
  it('parses seconds/minutes/hours/days', () => {
    expect(parseIntervalSpec('30s')).toBe(30_000);
    expect(parseIntervalSpec('15m')).toBe(15 * 60_000);
    expect(parseIntervalSpec('2h')).toBe(2 * 3_600_000);
    expect(parseIntervalSpec('7d')).toBe(7 * 86_400_000);
  });

  it('parses ISO-8601 day/week/time intervals used by launch skills', () => {
    expect(parseIntervalSpec('PT1H')).toBe(3_600_000);
    expect(parseIntervalSpec('P1D')).toBe(86_400_000);
    expect(parseIntervalSpec('P1W')).toBe(7 * 86_400_000);
    expect(parseIntervalSpec('P1DT30M')).toBe(86_400_000 + 30 * 60_000);
  });

  it('rejects bad spec shapes', () => {
    expect(parseIntervalSpec('abc')).toEqual({ error: 'invalid-interval-spec' });
    expect(parseIntervalSpec('0d')).toEqual({ error: 'invalid-interval-spec' });
    expect(parseIntervalSpec('1y')).toEqual({ error: 'invalid-interval-spec' });
    expect(parseIntervalSpec('-5m')).toEqual({ error: 'invalid-interval-spec' });
  });
});

describe('parsePriceTriggerSpec', () => {
  it('parses well-formed specs', () => {
    expect(parsePriceTriggerSpec('SOL/USD:lt:150')).toEqual({ feed: 'SOL/USD', op: 'lt', threshold: 150 });
    expect(parsePriceTriggerSpec('btc/usd:gte:80000.5')).toEqual({ feed: 'BTC/USD', op: 'gte', threshold: 80000.5 });
    expect(parsePriceTriggerSpec('{"feedId":"0xabc","op":"<","threshold":"100"}'))
      .toEqual({ feed: '0XABC', op: 'lt', threshold: 100 });
  });

  it('rejects bad specs', () => {
    expect(parsePriceTriggerSpec('SOL/USD:foo:150')).toEqual({ error: 'invalid-price-trigger-spec' });
    expect(parsePriceTriggerSpec('lt:150')).toEqual({ error: 'invalid-price-trigger-spec' });
  });
});

describe('parseCronSpec', () => {
  it('parses 5-field cron with day-of-week names', () => {
    const expr = parseCronSpec('0 9 * * FRI');
    if ('error' in expr) throw new Error(`unexpected error: ${expr.error}`);
    expect(expr.minutes.has(0)).toBe(true);
    expect(expr.hours.has(9)).toBe(true);
    expect(expr.dows.has(5)).toBe(true);
    expect(expr.dows.has(1)).toBe(false);
  });

  it('parses every-15-min', () => {
    const expr = parseCronSpec('*/15 * * * *');
    if ('error' in expr) throw new Error(`unexpected error: ${expr.error}`);
    expect(expr.minutes.has(0)).toBe(true);
    expect(expr.minutes.has(15)).toBe(true);
    expect(expr.minutes.has(30)).toBe(true);
    expect(expr.minutes.has(45)).toBe(true);
    expect(expr.minutes.has(5)).toBe(false);
  });

  it('parses ranges and lists', () => {
    const expr = parseCronSpec('0 0 1-15 * MON,WED,FRI');
    if ('error' in expr) throw new Error(`unexpected error: ${expr.error}`);
    expect(expr.doms.has(1)).toBe(true);
    expect(expr.doms.has(15)).toBe(true);
    expect(expr.doms.has(16)).toBe(false);
    expect(expr.dows.has(1)).toBe(true);
    expect(expr.dows.has(3)).toBe(true);
    expect(expr.dows.has(5)).toBe(true);
    expect(expr.dows.has(2)).toBe(false);
  });

  it('rejects unsupported tokens', () => {
    expect(parseCronSpec('0 9 ? * FRI')).toEqual({ error: 'cron-feature-not-supported' });
    expect(parseCronSpec('0 9 L * FRI')).toEqual({ error: 'cron-feature-not-supported' });
    expect(parseCronSpec('@daily')).toEqual({ error: 'cron-feature-not-supported' });
  });

  it('rejects wrong field count', () => {
    expect(parseCronSpec('0 9')).toEqual({ error: 'cron-must-have-5-fields' });
    expect(parseCronSpec('0 9 * * FRI EXTRA')).toEqual({ error: 'cron-must-have-5-fields' });
  });

  it('rejects out-of-range values', () => {
    const result = parseCronSpec('60 9 * * FRI');
    expect('error' in result && result.error.startsWith('cron-minute-')).toBe(true);
  });
});

describe('cronMatches + nextCronFiringBefore/After', () => {
  it('cronMatches respects UTC day-of-week', () => {
    const expr = parseCronSpec('0 9 * * FRI');
    if ('error' in expr) throw new Error(expr.error);
    // 2026-05-15 is a Friday
    const friday = new Date('2026-05-15T09:00:00.000Z');
    const thursday = new Date('2026-05-14T09:00:00.000Z');
    expect(cronMatches(expr, friday)).toBe(true);
    expect(cronMatches(expr, thursday)).toBe(false);
  });

  it('nextCronFiringBefore finds the most recent firing', () => {
    const expr = parseCronSpec('0 9 * * FRI');
    if ('error' in expr) throw new Error(expr.error);
    // 2026-05-17 is a Sunday; previous Friday firing was 2026-05-15T09:00.
    const sunday = new Date('2026-05-17T12:00:00.000Z');
    const firing = nextCronFiringBefore(expr, sunday);
    expect(firing?.toISOString()).toBe('2026-05-15T09:00:00.000Z');
  });

  it('nextCronFiringAfter finds the next future firing', () => {
    const expr = parseCronSpec('0 9 * * FRI');
    if ('error' in expr) throw new Error(expr.error);
    // 2026-05-14 is a Thursday; next Friday firing is 2026-05-15T09:00.
    const thursday = new Date('2026-05-14T12:00:00.000Z');
    const firing = nextCronFiringAfter(expr, thursday);
    expect(firing?.toISOString()).toBe('2026-05-15T09:00:00.000Z');
  });

  it('nextCronFiringAfter includes the current minute when it exactly matches', () => {
    const expr = parseCronSpec('0 9 * * FRI');
    if ('error' in expr) throw new Error(expr.error);
    const firing = nextCronFiringAfter(expr, new Date('2026-05-15T09:00:00.000Z'));
    expect(firing?.toISOString()).toBe('2026-05-15T09:00:00.000Z');
  });

  it('nextCronFiringAfter handles monthly schedules', () => {
    const expr = parseCronSpec('0 14 1 * *');
    if ('error' in expr) throw new Error(expr.error);
    const firing = nextCronFiringAfter(expr, new Date('2026-05-14T12:00:00.000Z'));
    expect(firing?.toISOString()).toBe('2026-06-01T14:00:00.000Z');
  });
});

describe('evaluateSchedule', () => {
  const baseInput = (overrides: Partial<SchedulerInput> = {}): SchedulerInput => ({
    install: baseInstall(),
    manifest: baseManifest(),
    lastExecutionAtIso: undefined,
    executionCount: 0,
    now: new Date('2026-05-15T09:00:00.000Z'), // Friday 09:00 UTC
    cluster: 'mainnet-beta',
    ...overrides,
  });

  it('interval first-run is always due', async () => {
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'interval', spec: '7d' } }),
    }));
    expect(result.due).toBe(true);
    expect(result.reason).toBe('first-run');
  });

  it('interval respects last-execution boundary', async () => {
    const due = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'interval', spec: '7d' } }),
      lastExecutionAtIso: '2026-05-08T09:00:00.000Z',
      now: new Date('2026-05-15T09:00:00.000Z'),
    }));
    expect(due.due).toBe(true);

    const tooEarly = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'interval', spec: '7d' } }),
      lastExecutionAtIso: '2026-05-10T09:00:00.000Z',
      now: new Date('2026-05-15T09:00:00.000Z'),
    }));
    expect(tooEarly.due).toBe(false);
    if (!tooEarly.due) {
      expect(tooEarly.nextDueAtIso).toBe('2026-05-17T09:00:00.000Z');
    }
  });

  it('interval malformed spec → not due', async () => {
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'interval', spec: 'foo' } }),
    }));
    expect(result.due).toBe(false);
    if (!result.due) expect(result.reason).toBe('invalid-interval-spec');
  });

  it('cron fires on Friday and not again until the next', async () => {
    const friday = await evaluateSchedule(baseInput({
      lastExecutionAtIso: undefined,
      now: new Date('2026-05-15T09:00:00.000Z'),
    }));
    expect(friday.due).toBe(true);

    const justRan = await evaluateSchedule(baseInput({
      lastExecutionAtIso: '2026-05-15T09:00:00.000Z',
      now: new Date('2026-05-15T09:01:00.000Z'),
    }));
    expect(justRan.due).toBe(false);
    if (!justRan.due) expect(justRan.reason).toBe('cron-already-fired');
  });

  it('cron first-run does not backfill a firing from before install time', async () => {
    const result = await evaluateSchedule(baseInput({
      install: baseInstall({ installedAt: '2026-05-15T09:30:00.000Z' }),
      lastExecutionAtIso: undefined,
      now: new Date('2026-05-15T10:00:00.000Z'),
    }));
    expect(result.due).toBe(false);
    if (!result.due) {
      expect(result.reason).toBe('cron-before-install');
      expect(result.nextDueAtIso).toBe('2026-05-22T09:00:00.000Z');
    }
  });

  it('price-trigger without lookup returns not-due', async () => {
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'price-trigger', spec: 'SOL/USD:lt:150' } }),
    }));
    expect(result.due).toBe(false);
    if (!result.due) expect(result.reason).toBe('price-trigger-no-lookup-available');
  });

  it('price-trigger fires when threshold is met', async () => {
    const priceLookup = vi.fn().mockResolvedValue(140);
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'price-trigger', spec: 'SOL/USD:lt:150' } }),
      priceLookup,
    }));
    expect(priceLookup).toHaveBeenCalledWith('SOL/USD', 'mainnet-beta');
    expect(result.due).toBe(true);
  });

  it('price-trigger supports JSON Pyth-style specs', async () => {
    const priceLookup = vi.fn().mockResolvedValue(99);
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({
        schedule: { kind: 'price-trigger', spec: '{"feedId":"0xfeed","op":"<","threshold":"100"}' },
      }),
      priceLookup,
    }));
    expect(priceLookup).toHaveBeenCalledWith('0XFEED', 'mainnet-beta');
    expect(result.due).toBe(true);
  });

  it('price-trigger handles lookup failure gracefully', async () => {
    const priceLookup = vi.fn().mockRejectedValue(new Error('hermes down'));
    const result = await evaluateSchedule(baseInput({
      manifest: baseManifest({ schedule: { kind: 'price-trigger', spec: 'SOL/USD:lt:150' } }),
      priceLookup,
    }));
    expect(result.due).toBe(false);
    if (!result.due) expect(result.reason).toMatch(/^price-trigger-lookup-failed/);
  });
});
