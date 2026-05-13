import { afterEach, describe, expect, it } from 'vitest';

import {
  clearConnectorOptionProvidersForTests,
  connectorOptionCacheKey,
  dependenciesSatisfied,
  getConnectorOptionProvider,
  listConnectorOptionProviders,
  missingDependencyLabel,
  registerConnectorOptionProvider,
  type ConnectorOption,
  type ConnectorOptionBridgeFetch,
  type ConnectorOptionProvider,
} from '../connectorOptionProviders.js';

describe('connector option providers registry', () => {
  afterEach(() => {
    clearConnectorOptionProvidersForTests();
  });

  it('registers and looks up providers by id', () => {
    const provider: ConnectorOptionProvider = {
      id: 'kamino.reserve',
      connectorId: 'kamino',
      ttlMs: 60_000,
      async fetch() {
        return [];
      },
    };
    registerConnectorOptionProvider(provider);
    expect(getConnectorOptionProvider('kamino.reserve')).toBe(provider);
    expect(listConnectorOptionProviders()).toHaveLength(1);
  });

  it('throws on duplicate registration', () => {
    const provider: ConnectorOptionProvider = {
      id: 'duplicate',
      connectorId: 'kamino',
      ttlMs: 1000,
      async fetch() {
        return [];
      },
    };
    registerConnectorOptionProvider(provider);
    expect(() => registerConnectorOptionProvider(provider)).toThrow(/already registered/);
  });
});

describe('cache key + dependency helpers', () => {
  it('builds stable cache keys regardless of dependsOn ordering', () => {
    const key1 = connectorOptionCacheKey(
      'kamino.reserve',
      ['poolId', 'cluster'],
      { poolId: 'X', cluster: 'mainnet' },
      'wallet1',
      'mainnet-beta',
    );
    const key2 = connectorOptionCacheKey(
      'kamino.reserve',
      ['cluster', 'poolId'],
      { poolId: 'X', cluster: 'mainnet' },
      'wallet1',
      'mainnet-beta',
    );
    expect(key1).toBe(key2);
  });

  it('produces different cache keys when wallet, cluster, or deps change', () => {
    const baseline = connectorOptionCacheKey('kamino.reserve', ['poolId'], { poolId: 'X' }, 'wallet1', 'mainnet-beta');
    const otherPool = connectorOptionCacheKey('kamino.reserve', ['poolId'], { poolId: 'Y' }, 'wallet1', 'mainnet-beta');
    const otherWallet = connectorOptionCacheKey('kamino.reserve', ['poolId'], { poolId: 'X' }, 'wallet2', 'mainnet-beta');
    const otherCluster = connectorOptionCacheKey('kamino.reserve', ['poolId'], { poolId: 'X' }, 'wallet1', 'devnet');
    expect(new Set([baseline, otherPool, otherWallet, otherCluster]).size).toBe(4);
  });

  it('detects unsatisfied dependencies', () => {
    expect(dependenciesSatisfied([], {})).toBe(true);
    expect(dependenciesSatisfied(['poolId'], { poolId: 'X' })).toBe(true);
    expect(dependenciesSatisfied(['poolId'], { poolId: '  ' })).toBe(false);
    expect(dependenciesSatisfied(['poolId', 'token'], { poolId: 'X' })).toBe(false);
  });

  it('returns the first missing dependency label', () => {
    expect(missingDependencyLabel(['poolId', 'token'], { poolId: '', token: 'USDC' })).toBe('poolId');
    expect(missingDependencyLabel(['poolId', 'token'], { poolId: 'X', token: 'USDC' })).toBeUndefined();
  });
});

describe('provider integration shape', () => {
  afterEach(() => {
    clearConnectorOptionProvidersForTests();
  });

  it('invokes the bridge callback with the field values and wallet info', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const provider: ConnectorOptionProvider = {
      id: 'sample.echo',
      connectorId: 'sample',
      ttlMs: 0,
      async fetch(ctx) {
        await ctx.bridge('/bridge/echo', { method: 'POST', body: JSON.stringify({ fieldValues: ctx.fieldValues }) });
        return [{ value: 'a', label: 'A' } satisfies ConnectorOption];
      },
    };
    registerConnectorOptionProvider(provider);
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return {} as T;
    };
    const got = await provider.fetch({
      fieldValues: { foo: 'bar' },
      walletAddress: 'wallet',
      cluster: 'mainnet-beta',
      bridge,
    });
    expect(got).toEqual([{ value: 'a', label: 'A' }]);
    expect(calls).toEqual([{ path: '/bridge/echo', init: { method: 'POST', body: JSON.stringify({ fieldValues: { foo: 'bar' } }) } }]);
  });
});
