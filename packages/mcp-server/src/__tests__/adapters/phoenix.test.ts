import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPhoenixPolicyAllowed,
  phoenixCloseAction,
  phoenixOpenAction,
} from '../../adapters/phoenix/actions.js';
import {
  resetPhoenixClientFactory,
  setPhoenixClientFactory,
  type PhoenixClient,
  type PhoenixMarketSnapshot,
  type PhoenixTraderStateSnapshot,
} from '../../adapters/phoenix/client.js';
import { previewHealth } from '../../adapters/phoenix/healthPreview.js';
import { getPositionSnapshot } from '../../adapters/phoenix/positions.js';
import {
  combinePosition,
  liquidationBufferPct,
  projectLiquidationPriceUsd,
  projectMarginRatio,
  tickPriceToUsd,
  usdToTickPrice,
} from '../../adapters/phoenix/sharedMath.js';
import { getPhoenixPerpsPolicy, DEFAULT_PHOENIX_PERPS_POLICY, type AgentWalletConfig } from '../../config.js';
import { phoenixAdapter } from '../../adapters/phoenix/index.js';
import { getAdapter } from '../../adapters/registry.js';
import { AdapterError, type DAppAdapterContext } from '../../adapters/types.js';

afterEach(() => {
  resetPhoenixClientFactory();
  delete process.env.PHOENIX_ACCESS_CODE;
});

const enabledConfig = (overrides: Partial<typeof DEFAULT_PHOENIX_PERPS_POLICY> = {}): AgentWalletConfig => ({
  cluster: 'mainnet-beta',
  connectors: {
    phoenix: {
      perps: { enabled: true, ...overrides },
    },
  },
} as AgentWalletConfig);

describe('phoenix adapter registration', () => {
  it('is reachable via the global adapter registry', () => {
    expect(getAdapter('phoenix')).toBe(phoenixAdapter);
  });

  it('exports the v1 read tools', () => {
    expect(Object.keys(phoenixAdapter.reads).sort()).toEqual([
      'funding_history',
      'health_preview',
      'market_catalog',
      'market_snapshot',
      'position_snapshot',
      'wallet_positions',
    ]);
  });

  it('exports the v1 action keys (each scaffolded; prepare gates policy, execute throws unsupported)', () => {
    expect(Object.keys(phoenixAdapter.actions).sort()).toEqual([
      'cancel_order',
      'close',
      'modify_collateral',
      'open',
      'place_trigger',
    ]);
  });
});

describe('PhoenixPerpsPolicyConfig defaults', () => {
  it('disabled by default until operator opts in', () => {
    const policy = getPhoenixPerpsPolicy({ cluster: 'mainnet-beta' } as AgentWalletConfig);
    expect(policy.enabled).toBe(false);
    expect(policy.paperModeOnly).toBe(true);
    expect(policy.maxLeverage).toBe(5);
    expect(policy.allowedSymbols).toEqual(['SOL-PERP']);
  });

  it('merges per-key overrides without losing defaults', () => {
    const policy = getPhoenixPerpsPolicy(enabledConfig({ maxLeverage: 10 }));
    expect(policy.enabled).toBe(true);
    expect(policy.maxLeverage).toBe(10);
    expect(policy.allowedSymbols).toEqual(['SOL-PERP']);
  });
});

describe('assertPhoenixPolicyAllowed', () => {
  it('rejects when policy.enabled is false', () => {
    expect(() => assertPhoenixPolicyAllowed({ cluster: 'mainnet-beta' } as AgentWalletConfig, {}))
      .toThrow(AdapterError);
  });

  it('rejects over-leverage requests', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ maxLeverage: 5 }), { leverage: 10 }),
    ).toThrow(/exceeds Phoenix policy max 5x/);
  });

  it('rejects disallowed symbols', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ allowedSymbols: ['SOL-PERP'] }), {
        symbol: 'BTC-PERP',
      }),
    ).toThrow(/not in the Phoenix policy allowlist/);
  });

  it('rejects over-notional opens', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ maxNotionalUsd: 250 }), {
        notionalUsd: 300,
      }),
    ).toThrow(/exceeds Phoenix policy max \$250/);
  });

  it('rejects insufficient liquidation buffer', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ minLiquidationBufferPct: 15 }), {
        liquidationBufferPct: 8,
      }),
    ).toThrow(/below policy minimum 15%/);
  });

  it('allows compliant requests', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig(), {
        symbol: 'SOL-PERP',
        leverage: 3,
        notionalUsd: 100,
        liquidationBufferPct: 25,
        mode: 'paper',
      }),
    ).not.toThrow();
  });

  it('rejects writes when readOnly is true', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ readOnly: true }), {}),
    ).toThrow(/Phoenix Perpetuals policy is read-only/);
  });

  it('rejects live writes when policy.paperModeOnly is true', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ paperModeOnly: true }), { mode: 'live' }),
    ).toThrow(/Phoenix policy is paper-mode-only/);
  });

  it('rejects writes with undefined mode when policy.paperModeOnly is true', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ paperModeOnly: true }), {}),
    ).toThrow(/Phoenix policy is paper-mode-only/);
  });

  it('allows paper writes when policy.paperModeOnly is true', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ paperModeOnly: true }), { mode: 'paper' }),
    ).not.toThrow();
  });

  it('allows live writes when policy.paperModeOnly is false', () => {
    expect(() =>
      assertPhoenixPolicyAllowed(enabledConfig({ paperModeOnly: false }), { mode: 'live' }),
    ).not.toThrow();
  });
});

describe('Phoenix tick math', () => {
  it('round-trips USD → tick → USD with default precision', () => {
    const ticks = usdToTickPrice(142.305);
    expect(ticks).toBe(142_305_000n);
    expect(tickPriceToUsd(ticks)).toBe('142.305');
  });

  it('rejects negative USD prices', () => {
    expect(() => usdToTickPrice(-1)).toThrow(RangeError);
  });

  it('handles zero', () => {
    expect(usdToTickPrice(0)).toBe(0n);
    expect(tickPriceToUsd(0n)).toBe('0');
  });
});

describe('projectLiquidationPriceUsd', () => {
  it('is below entry for longs', () => {
    const liq = projectLiquidationPriceUsd({ side: 'long', entryPriceUsd: 100, leverage: 5 });
    expect(liq).toBeLessThan(100);
    expect(liq).toBeGreaterThan(0);
  });

  it('is above entry for shorts', () => {
    const liq = projectLiquidationPriceUsd({ side: 'short', entryPriceUsd: 100, leverage: 5 });
    expect(liq).toBeGreaterThan(100);
  });

  it('rejects non-positive entry price or leverage', () => {
    expect(() => projectLiquidationPriceUsd({ side: 'long', entryPriceUsd: 0, leverage: 5 })).toThrow(RangeError);
    expect(() => projectLiquidationPriceUsd({ side: 'long', entryPriceUsd: 100, leverage: 0 })).toThrow(RangeError);
  });
});

describe('liquidationBufferPct', () => {
  it('returns 0 when long mark sits at or below liq', () => {
    expect(liquidationBufferPct(100, 100, 'long')).toBe(0);
    expect(liquidationBufferPct(95, 100, 'long')).toBe(0);
  });

  it('returns positive buffer when long mark is above liq', () => {
    const buffer = liquidationBufferPct(100, 80, 'long');
    expect(buffer).toBeCloseTo(20);
  });

  it('returns positive buffer when short mark is below liq', () => {
    const buffer = liquidationBufferPct(100, 120, 'short');
    expect(buffer).toBeCloseTo(20);
  });
});

describe('projectMarginRatio', () => {
  it('handles zero notional', () => {
    expect(projectMarginRatio({ collateralUsd: 50, notionalUsd: 0 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('computes collateral / notional', () => {
    expect(projectMarginRatio({ collateralUsd: 50, notionalUsd: 100 })).toBeCloseTo(0.5);
  });
});

describe('combinePosition', () => {
  it('returns delta-only when no existing position', () => {
    const result = combinePosition({
      delta: { baseSize: 0.5, side: 'long' },
      action: 'open',
      markPriceUsd: 100,
    });
    expect(result.baseSize).toBe(0.5);
    expect(result.entryPriceUsd).toBe(100);
    expect(result.side).toBe('long');
    expect(result.warnings).toEqual([]);
  });

  it('weighted-averages entry when opening on the same side', () => {
    const result = combinePosition({
      existing: { baseSize: 0.5, entryPriceUsd: 120, side: 'long' },
      delta: { baseSize: 0.5, side: 'long' },
      action: 'open',
      markPriceUsd: 100,
    });
    expect(result.baseSize).toBe(1);
    expect(result.entryPriceUsd).toBeCloseTo(110);
    expect(result.side).toBe('long');
  });

  it('reduces existing position when opening opposite side (partial)', () => {
    const result = combinePosition({
      existing: { baseSize: 1, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 0.3, side: 'short' },
      action: 'open',
      markPriceUsd: 95,
    });
    expect(result.baseSize).toBeCloseTo(0.7);
    expect(result.side).toBe('long');
    expect(result.entryPriceUsd).toBe(100);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('flips to opposite side when opening opposite size exceeds existing', () => {
    const result = combinePosition({
      existing: { baseSize: 0.3, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 1, side: 'short' },
      action: 'open',
      markPriceUsd: 95,
    });
    expect(result.baseSize).toBeCloseTo(0.7);
    expect(result.side).toBe('short');
    expect(result.entryPriceUsd).toBe(95);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns flat when fully closing', () => {
    const result = combinePosition({
      existing: { baseSize: 0.5, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 0.5, side: 'long' },
      action: 'close',
      markPriceUsd: 100,
    });
    expect(result.baseSize).toBe(0);
  });

  it('returns flat when closing more than existing (clamped)', () => {
    const result = combinePosition({
      existing: { baseSize: 0.5, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 0.8, side: 'long' },
      action: 'close',
      markPriceUsd: 100,
    });
    expect(result.baseSize).toBe(0);
  });

  it('preserves entry and side when partially closing', () => {
    const result = combinePosition({
      existing: { baseSize: 0.5, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 0.2, side: 'long' },
      action: 'close',
      markPriceUsd: 95,
    });
    expect(result.baseSize).toBeCloseTo(0.3);
    expect(result.entryPriceUsd).toBe(100);
    expect(result.side).toBe('long');
  });

  it('preserves position on modify_collateral', () => {
    const result = combinePosition({
      existing: { baseSize: 0.5, entryPriceUsd: 100, side: 'long' },
      delta: { baseSize: 0, side: 'long' },
      action: 'modify_collateral',
      markPriceUsd: 95,
    });
    expect(result.baseSize).toBe(0.5);
    expect(result.entryPriceUsd).toBe(100);
  });
});

// Mock client builder for the read-path tests below.
function mockPhoenixClient(overrides: Partial<PhoenixClient> = {}): PhoenixClient {
  return {
    async activate() {
      return { activatedAt: new Date().toISOString() };
    },
    async activateIfNeeded() {
      // no-op
    },
    async fetchMarketSnapshot({ symbol }): Promise<PhoenixMarketSnapshot> {
      return { symbol, markPriceUsd: '100', asOf: new Date().toISOString() };
    },
    async fetchMarketCatalog(): Promise<PhoenixMarketSnapshot[]> {
      return [{ symbol: 'SOL-PERP', markPriceUsd: '100', asOf: new Date().toISOString() }];
    },
    async fetchTraderState({ authority, traderPdaIndex }): Promise<PhoenixTraderStateSnapshot> {
      return {
        authority,
        traderPdaIndex: traderPdaIndex ?? 0,
        positions: [],
        openOrders: [],
        triggers: [],
        asOf: new Date().toISOString(),
      };
    },
    async fetchFundingHistory() {
      return [];
    },
    ...overrides,
  };
}

const VALID_WALLET = 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu';

function fakePhoenixCtx(walletAddress: string = VALID_WALLET): DAppAdapterContext {
  return {
    backend: {
      async getAddress() {
        return walletAddress;
      },
    } as DAppAdapterContext['backend'],
    config: { cluster: 'mainnet-beta' } as DAppAdapterContext['config'],
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: async () => 'sig',
    signAndBroadcast: async () => 'sig',
    signMessage: async () => 'msg',
    store: {} as DAppAdapterContext['store'],
  };
}

describe('getPositionSnapshot (case-insensitive symbol lookup)', () => {
  afterEach(() => resetPhoenixClientFactory());

  it('matches the position even when input symbol case differs', async () => {
    setPhoenixClientFactory(() =>
      mockPhoenixClient({
        async fetchTraderState({ authority }): Promise<PhoenixTraderStateSnapshot> {
          return {
            authority,
            traderPdaIndex: 0,
            positions: [
              { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', entryPriceUsd: '120' },
            ],
            openOrders: [],
            triggers: [],
            asOf: new Date().toISOString(),
          };
        },
      }),
    );
    const result = await getPositionSnapshot(fakePhoenixCtx(), { symbol: 'sol-perp' });
    expect(result.position).toBeDefined();
    expect(result.symbol).toBe('SOL-PERP');
  });

  it('returns position: undefined when no match', async () => {
    setPhoenixClientFactory(() => mockPhoenixClient());
    const result = await getPositionSnapshot(fakePhoenixCtx(), { symbol: 'BTC-PERP' });
    expect(result.position).toBeUndefined();
  });
});

describe('previewHealth integration with combinePosition', () => {
  afterEach(() => resetPhoenixClientFactory());

  it('warns and omits margin ratio when free collateral is unknown', async () => {
    setPhoenixClientFactory(() =>
      mockPhoenixClient({
        async fetchTraderState({ authority }): Promise<PhoenixTraderStateSnapshot> {
          return {
            authority,
            traderPdaIndex: 0,
            // freeCollateralUsd intentionally omitted
            positions: [],
            openOrders: [],
            triggers: [],
            asOf: new Date().toISOString(),
          };
        },
      }),
    );
    const result = await previewHealth(fakePhoenixCtx(), {
      symbol: 'SOL-PERP',
      side: 'long',
      baseSize: 0.5,
      leverage: 3,
    });
    expect(result.projectedMarginRatio).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/freeCollateralUsd/)]),
    );
  });

  it('uses combined entry when adding to an existing same-side position', async () => {
    setPhoenixClientFactory(() =>
      mockPhoenixClient({
        async fetchTraderState({ authority }): Promise<PhoenixTraderStateSnapshot> {
          return {
            authority,
            traderPdaIndex: 0,
            freeCollateralUsd: '200',
            positions: [
              { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', entryPriceUsd: '120' },
            ],
            openOrders: [],
            triggers: [],
            asOf: new Date().toISOString(),
          };
        },
        async fetchMarketSnapshot(): Promise<PhoenixMarketSnapshot> {
          return { symbol: 'SOL-PERP', markPriceUsd: '100', asOf: new Date().toISOString() };
        },
      }),
    );
    const result = await previewHealth(fakePhoenixCtx(), {
      symbol: 'SOL-PERP',
      side: 'long',
      baseSize: 0.5,
      leverage: 3,
      action: 'open',
    });
    // Combined entry is weighted: (0.5*120 + 0.5*100) / 1 = 110. Liq is below 110 for a long.
    expect(result.projectedLiquidationPriceUsd).toBeDefined();
    expect(Number(result.projectedLiquidationPriceUsd!)).toBeLessThan(110);
    expect(Number(result.projectedLiquidationPriceUsd!)).toBeGreaterThan(0);
  });

  it('omits liquidation when projected position is flat (full close)', async () => {
    setPhoenixClientFactory(() =>
      mockPhoenixClient({
        async fetchTraderState({ authority }): Promise<PhoenixTraderStateSnapshot> {
          return {
            authority,
            traderPdaIndex: 0,
            freeCollateralUsd: '200',
            positions: [
              { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', entryPriceUsd: '120' },
            ],
            openOrders: [],
            triggers: [],
            asOf: new Date().toISOString(),
          };
        },
      }),
    );
    const result = await previewHealth(fakePhoenixCtx(), {
      symbol: 'SOL-PERP',
      side: 'long',
      baseSize: 0.5,
      leverage: 3,
      action: 'close',
    });
    expect(result.projectedLiquidationPriceUsd).toBeUndefined();
    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/flat/)]),
    );
  });
});

describe('Phoenix action prepare runs policy before SDK access', () => {
  it('open: disabled policy throws connector_disabled before unsupported_method', async () => {
    const ctx = {
      ...fakePhoenixCtx(),
      config: { cluster: 'mainnet-beta' } as DAppAdapterContext['config'],
    };
    await expect(
      phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.1', leverage: 3, mode: 'paper' },
        ctx,
      ),
    ).rejects.toThrow(/disabled by policy/);
  });

  it('close: passes policy then throws unsupported_method when no Rise client available', async () => {
    const ctx = {
      ...fakePhoenixCtx(),
      config: enabledConfig({ paperModeOnly: false }) as DAppAdapterContext['config'],
    };
    await expect(
      phoenixCloseAction.prepare({ symbol: 'SOL-PERP' }, ctx),
    ).rejects.toThrow(/unsupported_method|Rise SDK/i);
  });
});
