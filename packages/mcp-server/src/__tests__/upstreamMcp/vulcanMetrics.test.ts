import { describe, expect, it } from 'vitest';

import { VulcanMetricsRegistry, recordVulcanCall } from '../../upstreamMcp/vulcanMetrics.js';

describe('VulcanMetricsRegistry', () => {
  it('records a successful call with latency bucket increment', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('market.snapshot', 42, 'ok');
    const snap = reg.snapshot();
    expect(snap['market.snapshot']).toMatchObject({
      toolName: 'market.snapshot',
      totalCalls: 1,
      errorCount: 0,
      totalLatencyMs: 42,
      maxLatencyMs: 42,
    });
    expect(snap['market.snapshot']!.latencyBuckets.lt100ms).toBe(1);
    expect(snap['market.snapshot']!.lastSuccessAt).toBeDefined();
  });

  it('buckets latencies correctly', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('t', 50, 'ok'); // lt100
    reg.record('t', 250, 'ok'); // lt500
    reg.record('t', 750, 'ok'); // lt1000
    reg.record('t', 3000, 'ok'); // lt5000
    reg.record('t', 8000, 'ok'); // gte5000
    const b = reg.snapshot()['t']!.latencyBuckets;
    expect(b.lt100ms).toBe(1);
    expect(b.lt500ms).toBe(1);
    expect(b.lt1000ms).toBe(1);
    expect(b.lt5000ms).toBe(1);
    expect(b.gte5000ms).toBe(1);
  });

  it('tracks errors separately from successes', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('t', 100, 'ok');
    reg.record('t', 200, new Error('oracle stale'));
    const snap = reg.snapshot()['t']!;
    expect(snap.totalCalls).toBe(2);
    expect(snap.errorCount).toBe(1);
    expect(snap.lastErrorMessage).toBe('oracle stale');
    expect(snap.lastErrorAt).toBeDefined();
  });

  it('truncates long error messages to 240 chars', () => {
    const reg = new VulcanMetricsRegistry();
    const longMsg = 'x'.repeat(500);
    reg.record('t', 0, new Error(longMsg));
    expect(reg.snapshot()['t']!.lastErrorMessage!.length).toBe(240);
  });

  it('reset() clears all counters', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('t', 100, 'ok');
    reg.reset();
    expect(reg.snapshot()).toEqual({});
  });

  it('tracks maxLatencyMs across calls', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('t', 50, 'ok');
    reg.record('t', 500, 'ok');
    reg.record('t', 100, 'ok');
    expect(reg.snapshot()['t']!.maxLatencyMs).toBe(500);
  });

  it('keys metrics by upstream tool name (not sanitized name)', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('trade.place_market', 100, 'ok');
    expect(reg.snapshot()['trade.place_market']).toBeDefined();
    expect(reg.snapshot()['solana_vulcan_trade_place_market']).toBeUndefined();
  });

  // T2.1: per-wallet keying.
  it('keys with wallet prefix when walletName is supplied', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('market.snapshot', 50, 'ok', 'alice');
    reg.record('market.snapshot', 75, 'ok', 'bob');
    const snap = reg.snapshot();
    expect(snap['alice::market.snapshot']).toBeDefined();
    expect(snap['bob::market.snapshot']).toBeDefined();
    expect(snap['market.snapshot']).toBeUndefined();
    expect(snap['alice::market.snapshot']!.walletName).toBe('alice');
    expect(snap['alice::market.snapshot']!.totalCalls).toBe(1);
    expect(snap['bob::market.snapshot']!.totalCalls).toBe(1);
  });

  it('does not blend per-wallet entries with bare entries', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('market.snapshot', 50, 'ok'); // bare (single-wallet mode)
    reg.record('market.snapshot', 75, 'ok', 'alice'); // multi-wallet mode
    expect(reg.snapshot()['market.snapshot']!.totalCalls).toBe(1);
    expect(reg.snapshot()['alice::market.snapshot']!.totalCalls).toBe(1);
  });

  it('omits walletName from snapshot when not supplied', () => {
    const reg = new VulcanMetricsRegistry();
    reg.record('market.snapshot', 50, 'ok');
    expect(reg.snapshot()['market.snapshot']!.walletName).toBeUndefined();
  });
});

describe('recordVulcanCall wrapper', () => {
  it('records latency + ok on success and returns the result', async () => {
    const reg = new VulcanMetricsRegistry();
    const result = await recordVulcanCall(reg, 'foo', async () => 'value');
    expect(result).toBe('value');
    expect(reg.snapshot()['foo']!.totalCalls).toBe(1);
    expect(reg.snapshot()['foo']!.errorCount).toBe(0);
  });

  it('records error and re-throws', async () => {
    const reg = new VulcanMetricsRegistry();
    await expect(
      recordVulcanCall(reg, 'foo', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(reg.snapshot()['foo']!.errorCount).toBe(1);
    expect(reg.snapshot()['foo']!.lastErrorMessage).toBe('boom');
  });

  it('measures real wall-clock latency (rough lower bound)', async () => {
    const reg = new VulcanMetricsRegistry();
    await recordVulcanCall(reg, 'foo', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(reg.snapshot()['foo']!.totalLatencyMs).toBeGreaterThanOrEqual(15);
  });

  // T2.1: walletName threads through to record().
  it('forwards walletName to record() for per-wallet keying', async () => {
    const reg = new VulcanMetricsRegistry();
    await recordVulcanCall(reg, 'foo', async () => 'ok', 'alice');
    expect(reg.snapshot()['alice::foo']).toBeDefined();
    expect(reg.snapshot()['alice::foo']!.walletName).toBe('alice');
  });
});
