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
  protocolConnectorPlannerContext,
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

  it('seeds the major protocol connector catalog', () => {
    expect(KNOWN_CONNECTED_DAPPS.map((adapter) => adapter.id)).toEqual([
      'kamino',
      'jupiter',
      'raydium',
      'orca',
      'meteora',
      'marginfi',
      'drift',
      'squads',
      'realms',
      'lulo',
      'save',
      'jito',
      'marinade',
      'sanctum',
      'magiceden',
      'tensor',
      'wormhole',
      'mayan',
      'pyth',
    ]);
    expect(KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === 'meteora')?.capabilities).toEqual(
      expect.arrayContaining(['first_class_adapter', 'read_positions', 'read_rewards', 'blink_actions']),
    );
    expect(KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === 'wormhole')?.readTools).toEqual(
      expect.arrayContaining(['solana_wormhole_quote', 'solana_wormhole_transfer_status']),
    );
    const mayan = KNOWN_CONNECTED_DAPPS.find((adapter) => adapter.id === 'mayan');
    expect(mayan).toMatchObject({
      actionKinds: [],
      readTools: [],
    });
    expect(mayan?.actionSource).toBeUndefined();
    expect(mayan?.readSource).toBeUndefined();
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
    expect(result.ok).toBe(true);
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

  it('can include disabled connector readiness for planner missing-connector answers', () => {
    const state = setConnectedDappEnabled(emptyConnectedDapps(), 'kamino', true);
    const context = protocolConnectorPlannerContext(state, 'mainnet-beta', {
      includeDisabled: true,
      dialectClientKeyConfigured: false,
    });

    expect(context.find((entry) => entry.id === 'kamino')).toMatchObject({
      enabled: true,
      readiness: 'ready',
      readApiReady: true,
      writeActions: expect.arrayContaining([
        expect.objectContaining({
          kind: 'kamino_deposit',
          ready: true,
          approvalBoundary: 'prepare_only_wallet_approval_required',
        }),
      ]),
    });
    expect(context.find((entry) => entry.id === 'meteora')).toMatchObject({
      enabled: false,
      readiness: 'disabled',
      limitation: 'Meteora is not enabled in Protocol Connectors.',
    });
  });
});

describe('helper lookups', () => {
  it('findAdapterByActionKind maps the action kind back to its adapter', () => {
    expect(findAdapterByActionKind('kamino_deposit')?.id).toBe('kamino');
    expect(findAdapterByActionKind('raydium_harvest')?.id).toBe('raydium');
    expect(findAdapterByActionKind('marinade_liquid_stake')?.id).toBe('marinade');
    expect(findAdapterByActionKind('wormhole_transfer')?.id).toBe('wormhole');
    expect(findAdapterByActionKind('mayan_swap')).toBeUndefined();
    expect(findAdapterByActionKind('totally-fake')).toBeUndefined();
  });

  it('findAdapterByReadTool maps the read tool name back to its adapter', () => {
    expect(findAdapterByReadTool('solana_kamino_reserve_snapshot')?.id).toBe('kamino');
    expect(findAdapterByReadTool('solana_jupiter_token_risk_evidence')?.id).toBe('jupiter');
    expect(findAdapterByReadTool('solana_raydium_pool_snapshot')?.id).toBe('raydium');
    expect(findAdapterByReadTool('solana_marinade_quote')?.id).toBe('marinade');
    expect(findAdapterByReadTool('solana_wormhole_quote')?.id).toBe('wormhole');
    expect(findAdapterByReadTool('solana_mayan_quote')).toBeUndefined();
  });

  it('findProtocolConnectorByInput resolves common aliases', () => {
    expect(findProtocolConnectorByInput('Meteora DLMM')?.id).toBe('meteora');
    expect(findProtocolConnectorByInput('go check my Meteora account')?.id).toBe('meteora');
    expect(findProtocolConnectorByInput('jup')?.id).toBe('jupiter');
    expect(findProtocolConnectorByInput('mSOL')?.id).toBe('marinade');
    expect(findProtocolConnectorByInput('portal bridge')?.id).toBe('wormhole');
    expect(findProtocolConnectorByInput('cross-chain swap')?.id).toBe('mayan');
  });

  it('exposes the storage key as a stable constant', () => {
    expect(CONNECTED_DAPPS_STORAGE_KEY).toBe('solana-agent-wallet-connected-dapps-v1');
    expect(PROTOCOL_CONNECTORS_STORAGE_KEY).toBe('solana-agent-wallet-protocol-connectors-v2');
  });
});
