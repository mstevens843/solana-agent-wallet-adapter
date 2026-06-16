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

  it('reloads once when the deployed commit changes', async () => {
    const storage = memoryStorage({ 'agentic:lastSeenBuildCommit': 'aaa111' });
    const location = testLocation('/demo?tab=app#top');
    const result = await checkNativeLiveUpdate({
      enabled: true,
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

    const second = await checkNativeLiveUpdate({
      enabled: true,
      fetch: buildFetch({ commit: 'bbb222', deployedAt: '2026-06-16T08:30:00.000Z' }),
      storage,
      location,
      nowMs: () => 2_000,
      walletRequestActive: () => false,
      minCheckIntervalMs: 0,
    });
    expect(second).toBe('current');
    expect(location.replace).toHaveBeenCalledTimes(1);
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
  };
}

function testLocation(path: string): NativeLiveUpdateLocation {
  const url = new URL(path, 'https://agentic-signer.com');
  return {
    href: url.href,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    replace: vi.fn(),
    reload: vi.fn(),
  };
}
