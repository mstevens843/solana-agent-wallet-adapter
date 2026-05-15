import { describe, expect, it } from 'vitest';

import { findOptimalSettlement } from '../router.js';
import type { QuoteSource, SettlementRequest, SettlementRoute } from '../types.js';

const REQUEST: SettlementRequest = {
  usdAmount: '50',
  recipient: '4fTqUdd9SRCkmALQhQGF66VRYJFsCLDSQJYadqwMMoHd',
};

function fixedRoute(sourceId: string, estimatedCostUsd: string): SettlementRoute {
  return {
    sourceId,
    label: `route via ${sourceId}`,
    hops: [],
    expectedUsdOut: '50',
    estimatedCostUsd,
    slippageBps: 0,
    warnings: [],
  };
}

function sourceReturning(id: string, route: SettlementRoute | null): QuoteSource {
  return { id, async quote() { return route; } };
}

function sourceThrowing(id: string, message: string): QuoteSource {
  return {
    id,
    async quote() {
      throw new Error(message);
    },
  };
}

function sourceHanging(id: string): QuoteSource {
  return {
    id,
    async quote({ signal }) {
      return await new Promise<SettlementRoute | null>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
}

function sourceWaiting(id: string, ms: number, route: SettlementRoute | null): QuoteSource {
  return {
    id,
    async quote() {
      await new Promise<void>((r) => setTimeout(r, ms));
      return route;
    },
  };
}

describe('findOptimalSettlement', () => {
  it('returns no candidates when sources is empty', async () => {
    const result = await findOptimalSettlement(REQUEST, []);
    expect(result.best).toBeUndefined();
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('picks the single source when only one returns a route', async () => {
    const only = fixedRoute('only', '50');
    const result = await findOptimalSettlement(REQUEST, [sourceReturning('only', only)]);
    expect(result.best).toEqual(only);
    expect(result.candidates).toEqual([only]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ sourceId: 'only', status: 'ok' }),
    ]);
  });

  it('chooses the cheapest of multiple candidates', async () => {
    const cheap = fixedRoute('cheap', '50.10');
    const pricey = fixedRoute('pricey', '51.50');
    const result = await findOptimalSettlement(REQUEST, [
      sourceReturning('pricey', pricey),
      sourceReturning('cheap', cheap),
    ]);
    expect(result.best?.sourceId).toBe('cheap');
    expect(result.candidates.map((c) => c.sourceId)).toEqual(['cheap', 'pricey']);
  });

  it('treats null returns as no_route without breaking other candidates', async () => {
    const good = fixedRoute('good', '50.20');
    const result = await findOptimalSettlement(REQUEST, [
      sourceReturning('absent', null),
      sourceReturning('good', good),
    ]);
    expect(result.best?.sourceId).toBe('good');
    const absentDiag = result.diagnostics.find((d) => d.sourceId === 'absent');
    expect(absentDiag?.status).toBe('no_route');
  });

  it('records errors as diagnostics without crashing', async () => {
    const good = fixedRoute('good', '50.20');
    const result = await findOptimalSettlement(REQUEST, [
      sourceThrowing('boom', 'nope'),
      sourceReturning('good', good),
    ]);
    expect(result.best?.sourceId).toBe('good');
    const boomDiag = result.diagnostics.find((d) => d.sourceId === 'boom');
    expect(boomDiag?.status).toBe('error');
    expect(boomDiag?.errorMessage).toBe('nope');
  });

  it('aborts sources that exceed perSourceTimeoutMs as timeout', async () => {
    const good = fixedRoute('good', '50.20');
    const result = await findOptimalSettlement(
      REQUEST,
      [sourceHanging('slow'), sourceReturning('good', good)],
      { perSourceTimeoutMs: 50 },
    );
    expect(result.best?.sourceId).toBe('good');
    const slowDiag = result.diagnostics.find((d) => d.sourceId === 'slow');
    expect(slowDiag?.status).toBe('timeout');
  });

  it('passes the injected now() into the QuoteContext', async () => {
    let observed: Date | undefined;
    const probe: QuoteSource = {
      id: 'probe',
      async quote({ now }) {
        observed = now();
        return fixedRoute('probe', '50');
      },
    };
    const fixed = new Date('2026-01-01T00:00:00Z');
    await findOptimalSettlement(REQUEST, [probe], { now: () => fixed });
    expect(observed).toEqual(fixed);
  });

  it('runs sources in parallel (wall clock close to slowest, not sum)', async () => {
    const slow = sourceWaiting('slow', 100, fixedRoute('slow', '51'));
    const slower = sourceWaiting('slower', 150, fixedRoute('slower', '50.5'));
    const startedAt = Date.now();
    const result = await findOptimalSettlement(REQUEST, [slow, slower], { perSourceTimeoutMs: 1000 });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(280);
    expect(result.best?.sourceId).toBe('slower');
  });
});
