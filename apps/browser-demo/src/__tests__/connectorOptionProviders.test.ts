import { afterEach, describe, expect, it } from 'vitest';

import {
  clearConnectorOptionProvidersForTests,
  connectorOptionCacheKey,
  dependenciesSatisfied,
  getConnectorOptionProvider,
  listConnectorOptionProviders,
  missingDependencyLabel,
  registerBuiltInConnectorOptionProviders,
  registerConnectorOptionProvider,
  unregisterBuiltInConnectorOptionProvidersForTests,
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

describe('built-in connector option fallbacks', () => {
  afterEach(() => {
    clearConnectorOptionProvidersForTests();
    unregisterBuiltInConnectorOptionProvidersForTests();
  });

  it('surfaces common Pyth feeds when bridge facts are unavailable', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('pyth.feed');
    if (!provider) throw new Error('pyth.feed provider missing');
    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge: async () => {
        throw new Error('bridge down');
      },
    });

    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(['SOL/USD', 'USDC/USD']));
    expect(options.find((option) => option.label === 'SOL/USD')?.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('combines Raydium CPMM and CLMM pool dropdowns for read checks', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('raydium.pool');
    if (!provider) throw new Error('raydium.pool provider missing');
    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge: async () => {
        throw new Error('bridge down');
      },
    });

    expect(options.some((option) => option.label.includes('CPMM'))).toBe(true);
    expect(options.some((option) => option.label.includes('CLMM'))).toBe(true);
  });

  it('surfaces Project 0 bank fallbacks when bridge facts are unavailable', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('project0.bank');
    if (!provider) throw new Error('project0.bank provider missing');
    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge: async () => {
        throw new Error('bridge down');
      },
    });

    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(['USDC bank', 'SOL bank']));
    expect(options.find((option) => option.value === 'USDC')?.detail).toContain('Project 0');
  });

  it('submits Save reserve symbols or mints instead of reserve account addresses', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('save.reserve');
    if (!provider) throw new Error('save.reserve provider missing');
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(_path: string, init?: RequestInit): Promise<T> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.capability === 'positions') {
        return {
          deposits: [{
            reserveAddress: 'Reserve1111111111111111111111111111111111',
            reserveMint: 'So11111111111111111111111111111111111111112',
            reserveSymbol: 'SOL',
          }],
        } as T;
      }
      return {
        reserves: [{
          reserveAddress: 'Reserve2222222222222222222222222222222222',
          reserveMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          reserveSymbol: 'USDC',
          supplyApy: '4.2%',
        }],
      } as T;
    };

    const options = await provider.fetch({
      fieldValues: {},
      walletAddress: 'wallet',
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'SOL', label: 'SOL reserve' }),
      expect.objectContaining({ value: 'USDC', label: 'USDC reserve' }),
    ]));
    expect(options.some((option) => option.value.startsWith('Reserve'))).toBe(false);
  });

  it('uses Wormhole source mint values for token and destination dropdowns', async () => {
    registerBuiltInConnectorOptionProviders();
    const tokenProvider = getConnectorOptionProvider('wormhole.token');
    const destinationProvider = getConnectorOptionProvider('wormhole.destination');
    if (!tokenProvider || !destinationProvider) throw new Error('Wormhole providers missing');
    const solMint = 'So11111111111111111111111111111111111111112';
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ path, body });
      if (body.sourceMint) {
        return {
          snapshot: {
            routes: [
              { sourceMint: solMint, destinationChain: 'Base', estimatedTime: '10 minutes' },
            ],
          },
        } as T;
      }
      return {
        snapshot: {
          routes: [
            { sourceMint: solMint, destinationChain: 'Base' },
          ],
        },
      } as T;
    };

    const tokenOptions = await tokenProvider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge,
    });
    const destinationOptions = await destinationProvider.fetch({
      fieldValues: { sourceMint: solMint },
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(tokenOptions[0]).toMatchObject({ value: solMint });
    expect(calls[1]?.body).toMatchObject({
      connectorId: 'wormhole',
      capability: 'markets',
      sourceMint: solMint,
    });
    expect(calls[1]?.body.token).toBeUndefined();
    expect(destinationOptions[0]).toMatchObject({ value: 'Base', label: 'Base' });
  });

  it('loads Drift vault dropdown options from bridge catalog facts', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('drift.vault');
    if (!provider) throw new Error('drift.vault provider missing');
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ path, body });
      return {
        vaults: [
          {
            vaultAddress: 'CoHd9JpwfcA76XQGA4AYfnjvAtWKoBQ6eWBkFzR1A2ui',
            name: 'hJLP (USDC)',
            managerName: 'Gauntlet',
            depositSymbol: 'USDC',
          },
        ],
      } as T;
    };

    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(calls).toEqual([{
      path: '/bridge/action/connector-read-facts',
      body: { connectorId: 'drift', capability: 'markets' },
    }]);
    expect(options[0]).toMatchObject({
      value: 'CoHd9JpwfcA76XQGA4AYfnjvAtWKoBQ6eWBkFzR1A2ui',
      label: 'hJLP (USDC)',
      detail: expect.stringContaining('USDC deposits'),
      group: 'all',
    });
  });

  it('surfaces Drift vault fallbacks when bridge facts are unavailable', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('drift.vault');
    if (!provider) throw new Error('drift.vault provider missing');
    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge: async () => {
        throw new Error('bridge down');
      },
    });

    expect(options.map((option) => option.label)).toEqual(expect.arrayContaining(['hJLP (USDC)', 'SOL Super Staking']));
    expect(options.find((option) => option.label === 'hJLP (USDC)')?.value)
      .toBe('CoHd9JpwfcA76XQGA4AYfnjvAtWKoBQ6eWBkFzR1A2ui');
  });

  it('prepends Drift wallet vault positions before fallback catalog options', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('drift.vault');
    if (!provider) throw new Error('drift.vault provider missing');
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(_path: string, init?: RequestInit): Promise<T> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.capability === 'positions') {
        return {
          positions: [
            {
              vaultAddress: 'UserVault111111111111111111111111111111111',
              name: 'My Drift vault',
              shares: '12.5',
            },
          ],
        } as T;
      }
      throw new Error('catalog down');
    };

    const options = await provider.fetch({
      fieldValues: {},
      walletAddress: 'wallet',
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(options[0]).toMatchObject({
      value: 'UserVault111111111111111111111111111111111',
      label: 'My Drift vault',
      group: 'positions',
    });
    expect(options.some((option) => option.label === 'hJLP (USDC)' && option.group === 'all')).toBe(true);
  });

  it('loads Magic Eden top collection options from bridge facts', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('magiceden.collection');
    if (!provider) throw new Error('magiceden.collection provider missing');
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return {
        collections: {
          rows: [
            {
              collectionSymbol: 'mad_lads',
              name: 'Mad Lads',
              floorPriceSol: '5.1',
              rank: 1,
            },
          ],
        },
        facts: [{ label: 'Ignored fact row' }],
      } as T;
    };

    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(calls[0]).toEqual({
      path: '/bridge/action/connector-read-facts',
      body: { connectorId: 'magiceden', capability: 'markets', limit: 25 },
    });
    expect(options[0]).toMatchObject({
      value: 'mad_lads',
      label: 'Mad Lads',
      detail: expect.stringContaining('Floor 5.1 SOL'),
    });
  });

  it('loads Tensor supported collection options from bridge facts', async () => {
    registerBuiltInConnectorOptionProviders();
    const provider = getConnectorOptionProvider('tensor.collection');
    if (!provider) throw new Error('tensor.collection provider missing');
    const bridge: ConnectorOptionBridgeFetch = async <T = unknown>(): Promise<T> => {
      return {
        collections: {
          collections: [
            {
              collectionId: 'madlads',
              slug: 'madlads',
              name: 'Mad Lads',
              floorPriceSol: '5',
            },
          ],
        },
        facts: [{ label: 'Ignored fact row' }],
      } as T;
    };

    const options = await provider.fetch({
      fieldValues: {},
      cluster: 'mainnet-beta',
      bridge,
    });

    expect(options[0]).toMatchObject({
      value: 'madlads',
      label: 'Mad Lads',
      detail: expect.stringContaining('Floor 5 SOL'),
    });
  });
});
