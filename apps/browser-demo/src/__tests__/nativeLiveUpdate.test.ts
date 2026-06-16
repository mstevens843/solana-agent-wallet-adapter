import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkNativeLiveUpdate,
  parseAppBuildMetadata,
  resetNativeLiveUpdateStateForTests,
  type NativeLiveUpdateLocation,
  type NativeLiveUpdateStorage,
} from '../nativeLiveUpdate.js';

describe('native live update guard', () => {
  afterEach(() => {
    resetNativeLiveUpdateStateForTests();
  });

  it('parses build metadata defensively', () => {
    expect(parseAppBuildMetadata({ commit: 'abc123', deployedAt: '2026-06-16T08:30:00.000Z' })).toEqual({
      commit: 'abc123',
      deployedAt: '2026-06-16T08:30:00.000Z',
    });
    expect(parseAppBuildMetadata({ commit: 'abc123', deployedAt: 42 })).toEqual({
      commit: 'abc123',
      deployedAt: null,
    });
    expect(parseAppBuildMetadata({ deployedAt: '2026-06-16T08:30:00.000Z' })).toBeNull();
    expect(parseAppBuildMetadata(null)).toBeNull();
  });

  it('stores the first seen commit without reloading', async () => {
    const storage = memoryStorage();
    const location = testLocation('/demo');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      fetch: buildFetch({ commit: 'aaa111', deployedAt: null }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('current');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('aaa111');
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('does not reload when the current bundle commit matches the deployed commit', async () => {
    const storage = memoryStorage();
    const location = testLocation('/demo');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'aaa111', deployedAt: null }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('current');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('aaa111');
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('reloads stale JS even when no previous commit was stored', async () => {
    const storage = memoryStorage();
    const location = testLocation('/demo');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: '2026-06-16T08:30:00.000Z' }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('reloading');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('bbb222');
    expect(storage.getItem('agentic:lastReloadBuildCommit')).toBe('bbb222');
    expect(JSON.parse(storage.getItem('agentic:nativeLiveUpdateReloadAttempt') ?? '{}')).toMatchObject({
      commit: 'bbb222',
      count: 1,
      nextRetryAtMs: 6_000,
    });
    expect(location.replace).toHaveBeenCalledWith('/demo?agentic_build=bbb222');
  });

  it('retries a stale deployed commit until the running bundle matches it', async () => {
    const storage = memoryStorage({ 'agentic:lastSeenBuildCommit': 'aaa111' });
    const location = testLocation('/demo?tab=app#top');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: '2026-06-16T08:30:00.000Z' }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('reloading');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('bbb222');
    expect(storage.getItem('agentic:lastReloadBuildCommit')).toBe('bbb222');
    expect(location.replace).toHaveBeenCalledWith('/demo?tab=app&agentic_build=bbb222#top');

    const throttled = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: '2026-06-16T08:30:00.000Z' }),
      storage,
      location,
      nowMs: () => 2_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });
    expect(throttled).toBe('skipped');
    expect(location.replace).toHaveBeenCalledTimes(1);

    const retry = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: '2026-06-16T08:30:00.000Z' }),
      storage,
      location,
      nowMs: () => 6_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });
    expect(retry).toBe('reloading');
    expect(location.replace).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.getItem('agentic:nativeLiveUpdateReloadAttempt') ?? '{}')).toMatchObject({
      commit: 'bbb222',
      count: 2,
      nextRetryAtMs: 36_000,
    });
  });

  it('clears reload attempts when the running bundle matches the deployed commit', async () => {
    const storage = memoryStorage({
      'agentic:lastSeenBuildCommit': 'aaa111',
      'agentic:lastReloadBuildCommit': 'bbb222',
      'agentic:nativeLiveUpdateReloadAttempt': JSON.stringify({
        commit: 'bbb222',
        count: 2,
        nextRetryAtMs: 36_000,
      }),
    });
    const location = testLocation('/demo');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'bbb222',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: null }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('current');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('bbb222');
    expect(storage.getItem('agentic:nativeLiveUpdateReloadAttempt')).toBeNull();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('stops the immediate reload burst after the per-commit retry budget is exhausted', async () => {
    const storage = memoryStorage({
      'agentic:lastSeenBuildCommit': 'bbb222',
      'agentic:nativeLiveUpdateReloadAttempt': JSON.stringify({
        commit: 'bbb222',
        count: 2,
        nextRetryAtMs: 1_000,
      }),
    });
    const location = testLocation('/demo');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: null }),
      storage,
      location,
      nowMs: () => 2_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
      maxReloadAttemptsPerCommit: 2,
    });

    expect(result).toBe('error');
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('uses the live origin for reloads from native local fallback origins', async () => {
    const storage = memoryStorage();
    const location = testLocation('capacitor://localhost/app?tab=wallet#top', 'capacitor://localhost');
    const result = await checkNativeLiveUpdate({
      enabled: true,
      currentBuildCommit: 'aaa111',
      liveOrigin: 'https://agentic-signer.com',
      fetch: buildFetch({ commit: 'bbb222', deployedAt: null }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('reloading');
    expect(location.replace).toHaveBeenCalledWith('https://agentic-signer.com/app?tab=wallet&agentic_build=bbb222#top');
  });

  it('skips checks while a wallet request is active', async () => {
    const storage = memoryStorage({ 'agentic:lastSeenBuildCommit': 'aaa111' });
    const location = testLocation('/demo');
    const fetch = vi.fn();

    const result = await checkNativeLiveUpdate({
      enabled: true,
      fetch,
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => true,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('skipped');
    expect(fetch).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('does not mark a changed commit as seen if a wallet request starts before reload', async () => {
    const storage = memoryStorage({ 'agentic:lastSeenBuildCommit': 'aaa111' });
    const location = testLocation('/demo');
    let active = false;
    const result = await checkNativeLiveUpdate({
      enabled: true,
      fetch: vi.fn(async () => {
        active = true;
        return new Response(JSON.stringify({ commit: 'bbb222', deployedAt: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
      storage,
      location,
      nowMs: () => 1_000,
      walletRequestActive: () => active,
      minCheckIntervalMs: 0,
    });

    expect(result).toBe('skipped');
    expect(storage.getItem('agentic:lastSeenBuildCommit')).toBe('aaa111');
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('times out slow build metadata checks without blocking startup indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage({ 'agentic:lastSeenBuildCommit': 'aaa111' });
      const location = testLocation('/demo');
      const fetch = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      const result = checkNativeLiveUpdate({
        enabled: true,
        fetch,
        storage,
        location,
        nowMs: () => 1_000,
        walletRequestActive: () => false,
        minCheckIntervalMs: 0,
        requestTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe('error');
      expect(location.replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function buildFetch(body: unknown): (input: string, init?: RequestInit) => Promise<Response> {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

function memoryStorage(seed: Record<string, string> = {}): NativeLiveUpdateStorage {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
    removeItem(key: string): void {
      values.delete(key);
    },
  };
}

function testLocation(path: string, originOverride?: string): NativeLiveUpdateLocation {
  const url = new URL(path, 'https://agentic-signer.com');
  return {
    href: url.href,
    origin: originOverride ?? url.origin,
    pathname: url.pathname,
    search: url.search,
    replace: vi.fn(),
    reload: vi.fn(),
  };
}
