import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTED_DAPPS_STORAGE_KEY,
  KNOWN_CONNECTED_DAPPS,
  PROTOCOL_CONNECTORS_STORAGE_KEY,
  checkDappForKind,
  checkProtocolConnector,
  connectedDappsSummary,
  enabledProtocolConnectors,
  emptyConnectedDapps,
  findAdapterByActionKind,
  findAdapterByReadTool,
  findProtocolConnectorByInput,
  isDappEnabled,
  loadConnectedDapps,
  normalizeConnectedDapps,
  saveConnectedDapps,
  setConnectedDappEnabled,
} from '../connectedDapps.js';

// Minimal localStorage shim so the module-under-test can round-trip in node.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    } as Storage,
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('KNOWN_CONNECTED_DAPPS', () => {
  it('registers Kamino as a mainnet-only adapter with deposit and withdraw kinds', () => {
    const kamino = KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === 'kamino');
    expect(kamino).toBeDefined();
    expect(kamino?.supportedClusters).toEqual(['mainnet-beta']);
    expect(kamino?.actionKinds).toEqual(['kamino_deposit', 'kamino_withdraw']);
    expect(kamino?.readTools).toContain('solana_kamino_get_positions');
    expect(kamino?.capabilities).toContain('first_class_adapter');
    expect(kamino?.enabledByDefault).toBe(false);
  });

  it('seeds the major protocol connector catalog with Blink-capable protocols', () => {
    expect(KNOWN_CONNECTED_DAPPS.map((adapter) => adapter.id)).toEqual([
      'kamino',
      'jupiter',
      'raydium',
      'orca',
      'meteora',
      'marginfi',
      'drift',
      'lulo',
      'save',
    ]);
    expect(KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === 'meteora')?.capabilities).toEqual(
      expect.arrayContaining(['read_positions', 'read_rewards', 'blink_actions']),
    );
  });
});

describe('emptyConnectedDapps + persistence round-trip', () => {
  it('round-trips state through localStorage', () => {
    const initial = emptyConnectedDapps();
    const enabled = setConnectedDappEnabled(initial, 'kamino', true, new Date('2026-05-11T00:00:00Z'));
    saveConnectedDapps(enabled);
    const loaded = loadConnectedDapps();
    expect(loaded.entries.kamino?.enabled).toBe(true);
    expect(loaded.entries.kamino?.enabledAt).toBe('2026-05-11T00:00:00.000Z');
  });

  it('falls back to empty defaults when storage is empty', () => {
    const loaded = loadConnectedDapps();
    expect(loaded.entries.kamino?.enabled).toBe(false);
    expect(loaded.entries.meteora?.enabled).toBe(false);
  });

  it('normalizes unexpected payloads to the empty state without throwing', () => {
    expect(normalizeConnectedDapps(null).entries.kamino).toBeDefined();
    expect(normalizeConnectedDapps({ entries: 'oops' }).entries.kamino).toBeDefined();
    expect(normalizeConnectedDapps({ entries: { kamino: { enabled: 'truthy-string' } } }).entries.kamino?.enabled).toBe(true);
  });

  it('migrates legacy connected dApps storage when v2 connector storage is absent', () => {
    window.localStorage.setItem(CONNECTED_DAPPS_STORAGE_KEY, JSON.stringify({
      entries: { kamino: { enabled: true, enabledAt: '2026-05-11T00:00:00.000Z' } },
    }));
    const loaded = loadConnectedDapps();
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.entries.kamino?.enabled).toBe(true);
    expect(loaded.entries.jupiter?.enabled).toBe(false);
  });
});

describe('cluster gating', () => {
  it('isDappEnabled returns false on unsupported cluster even when entry says enabled', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    expect(isDappEnabled('kamino', state, 'devnet')).toBe(false);
    expect(isDappEnabled('kamino', state, 'mainnet-beta')).toBe(true);
  });

  it('checkDappForKind blocks unsupported clusters with a structured error', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    const result = checkDappForKind('kamino_deposit', state, 'devnet');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unsupported_cluster');
      expect(result.adapter?.id).toBe('kamino');
      expect(result.message).toMatch(/mainnet-beta/);
    }
  });

  it('checkDappForKind blocks disabled adapters with a structured error', () => {
    const state = emptyConnectedDapps();
    const result = checkDappForKind('kamino_deposit', state, 'mainnet-beta');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('disabled');
      expect(result.message).toMatch(/Enable it in Protocol Connectors/);
    }
  });

  it('checkDappForKind returns ok for an enabled adapter on a supported cluster', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    const result = checkDappForKind('kamino_deposit', state, 'mainnet-beta');
    expect(result.ok).toBe(true);
  });

  it('checkDappForKind accepts adapter read-tool names as inputs', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    const result = checkDappForKind('solana_kamino_get_positions', state, 'mainnet-beta');
    expect(result.ok).toBe(true);
  });

  it('checkDappForKind flags unknown adapter ids', () => {
    const state = emptyConnectedDapps();
    const result = checkDappForKind('marinade_stake', state, 'mainnet-beta');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_adapter');
    }
  });

  it('checkProtocolConnector can require a specific capability', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'raydium', true);
    const result = checkProtocolConnector('raydium', state, 'mainnet-beta', 'read_positions');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing_capability');
    }
  });
});

describe('summary copy', () => {
  it('reads "Kamino connected" when only Kamino is on', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    expect(connectedDappsSummary(state, 'mainnet-beta')).toBe('Kamino Finance connector enabled');
  });

  it('reads "No protocol connectors enabled" with catalog count when nothing is on', () => {
    const state = emptyConnectedDapps();
    expect(connectedDappsSummary(state, 'mainnet-beta')).toMatch(/No protocol connectors enabled/);
  });

  it('lists enabled connectors for planner context', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'meteora', true);
    expect(enabledProtocolConnectors(state, 'mainnet-beta').map((connector) => connector.id)).toEqual(['meteora']);
  });
});

describe('helper lookups', () => {
  it('findAdapterByActionKind maps the action kind back to its adapter', () => {
    expect(findAdapterByActionKind('kamino_deposit')?.id).toBe('kamino');
    expect(findAdapterByActionKind('totally-fake')).toBeUndefined();
  });

  it('findAdapterByReadTool maps the read tool name back to its adapter', () => {
    expect(findAdapterByReadTool('solana_kamino_reserve_snapshot')?.id).toBe('kamino');
  });

  it('findProtocolConnectorByInput resolves common aliases', () => {
    expect(findProtocolConnectorByInput('Meteora DLMM')?.id).toBe('meteora');
    expect(findProtocolConnectorByInput('go check my Meteora account')?.id).toBe('meteora');
    expect(findProtocolConnectorByInput('jup')?.id).toBe('jupiter');
  });

  it('exposes the storage key as a stable constant', () => {
    expect(CONNECTED_DAPPS_STORAGE_KEY).toBe('solana-agent-wallet-connected-dapps-v1');
    expect(PROTOCOL_CONNECTORS_STORAGE_KEY).toBe('solana-agent-wallet-protocol-connectors-v2');
  });
});
