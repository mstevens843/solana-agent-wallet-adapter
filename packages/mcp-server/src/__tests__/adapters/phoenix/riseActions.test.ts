import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  phoenixCancelOrderAction,
  phoenixCloseAction,
  phoenixModifyCollateralAction,
  phoenixOpenAction,
  phoenixPlaceTriggerAction,
} from '../../../adapters/phoenix/actions.js';
import {
  resetPhoenixClientFactory,
  setPhoenixClientFactory,
  type PhoenixClient,
  type PhoenixTraderStateSnapshot,
} from '../../../adapters/phoenix/client.js';
import { hasRiseExtensions } from '../../../adapters/phoenix/riseClient.js';
import type { DAppAdapterContext } from '../../../adapters/types.js';
import type { AgentWalletConfig } from '../../../config.js';
import type { Connection } from '@solana/web3.js';

const VALID_BLOCKHASH = 'GwY7VR4hHvBfStcAd3rJ4FuFiF5KFRDavBKwjkqsdYkS';
const VALID_WALLET = 'Cda4ZQ6oPdW97zh39NHX1njzvSjmJqkx3jJB8FZw1iCu';
const PHOENIX_PROGRAM = 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY';

afterEach(() => {
  resetPhoenixClientFactory();
});

/** Fake Rise-backed client: implements both reads and the write extensions. */
function fakeRiseClient(overrides: Partial<PhoenixClient> = {}): PhoenixClient {
  const baseIx = {
    programAddress: PHOENIX_PROGRAM,
    accounts: [{ address: VALID_WALLET, role: 3 }],
    data: new Uint8Array([1, 2, 3]),
  };
  // Cast through unknown: hasRiseExtensions does the runtime narrowing.
  return {
    async activate() {
      return { activatedAt: new Date().toISOString() };
    },
    async activateIfNeeded() {},
    async fetchMarketSnapshot({ symbol }: { symbol: string }) {
      return { symbol, markPriceUsd: '100', asOf: new Date().toISOString() };
    },
    async fetchMarketCatalog() {
      return [{ symbol: 'SOL-PERP', markPriceUsd: '100', asOf: new Date().toISOString() }];
    },
    async fetchTraderState({ authority }: { authority: string }): Promise<PhoenixTraderStateSnapshot> {
      return {
        authority,
        traderPdaIndex: 0,
        positions: [{ symbol: 'SOL-PERP', side: 'long', baseSize: '0.5' }],
        openOrders: [],
        triggers: [],
        asOf: new Date().toISOString(),
      };
    },
    async fetchFundingHistory() {
      return [];
    },
    // Rise extensions
    async buildOpenIxs() {
      return [baseIx];
    },
    async buildCloseIxs() {
      return [baseIx];
    },
    async buildCancelOrderIxs() {
      return [baseIx];
    },
    async buildPlaceTriggerIxs() {
      return [baseIx];
    },
    async buildModifyCollateralIxs() {
      return [baseIx];
    },
    dispose() {},
    ...overrides,
  } as unknown as PhoenixClient;
}

function enabledConfig(): AgentWalletConfig {
  return {
    cluster: 'mainnet-beta',
    connectors: { phoenix: { perps: { enabled: true, paperModeOnly: false } } },
  } as AgentWalletConfig;
}

function fakeCtx(walletAddress: string = VALID_WALLET): DAppAdapterContext {
  return {
    backend: { async getAddress() { return walletAddress; } } as DAppAdapterContext['backend'],
    config: enabledConfig(),
    connection: {
      getLatestBlockhash: vi.fn(async () => ({ blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 1000 })),
    } as unknown as Connection,
    signTransaction: vi.fn(async () => 'sig_signed'),
    signAndBroadcast: vi.fn(async () => 'sig_broadcast'),
    signMessage: vi.fn(async () => 'sig_msg'),
    store: {} as DAppAdapterContext['store'],
  };
}

describe('phoenix actions with Rise-backed client', () => {
  it('hasRiseExtensions identifies the fake Rise client correctly', () => {
    expect(hasRiseExtensions(fakeRiseClient())).toBe(true);
  });

  describe('phoenixOpenAction', () => {
    it('prepares an open with non-empty transactionBase64', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3 },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.transactionBase64).toEqual(expect.any(String));
      expect((params.transactionBase64 as string).length).toBeGreaterThan(0);
      expect(params.action).toBe('open');
      expect(params.symbol).toBe('SOL-PERP');
      expect(params.side).toBe('long');
    });

    it('executes by re-building + broadcasting', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const ctx = fakeCtx();
      const prep = await phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3 },
        ctx,
      );
      const execResult = await phoenixOpenAction.execute(
        {
          id: 'a',
          kind: 'phoenix_open',
          status: 'approval_pending',
          walletAddress: VALID_WALLET,
          cluster: 'mainnet-beta',
          summary: prep.addInput.summary,
          params: prep.addInput.params,
          dueAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ctx,
      );
      expect(execResult.txid).toBe('sig_broadcast');
      expect(ctx.signAndBroadcast).toHaveBeenCalled();
    });

    it('enforces policy before SDK access (over-leverage)', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      await expect(
        phoenixOpenAction.prepare(
          { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 999 },
          fakeCtx(),
        ),
      ).rejects.toThrow(/exceeds Phoenix policy max/);
    });
  });

  describe('phoenixCloseAction', () => {
    it('reads current position and prepares opposite-side close', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixCloseAction.prepare({ symbol: 'SOL-PERP' }, fakeCtx());
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.action).toBe('close');
      expect(params.currentSide).toBe('long');
      expect(params.baseSize).toBe('0.5');
      expect(params.transactionBase64).toEqual(expect.any(String));
    });

    it('throws no_open_position when fetchTraderState returns empty', async () => {
      setPhoenixClientFactory(() =>
        fakeRiseClient({
          async fetchTraderState({ authority }: { authority: string }) {
            return {
              authority,
              traderPdaIndex: 0,
              positions: [],
              openOrders: [],
              triggers: [],
              asOf: new Date().toISOString(),
            };
          },
        }),
      );
      await expect(phoenixCloseAction.prepare({ symbol: 'SOL-PERP' }, fakeCtx())).rejects.toThrow(
        /no open SOL-PERP position/,
      );
    });
  });

  describe('phoenixModifyCollateralAction', () => {
    it('prepares deposit with USD amount preserved in params', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixModifyCollateralAction.prepare(
        { direction: 'deposit', amountUsd: '100' },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.direction).toBe('deposit');
      expect(params.amountUsd).toBe('100');
      expect(params.transactionBase64).toEqual(expect.any(String));
    });

    it('prepares withdraw with summary mentioning Withdraw', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixModifyCollateralAction.prepare(
        { direction: 'withdraw', amountUsd: '50' },
        fakeCtx(),
      );
      expect(result.addInput.summary).toMatch(/Withdraw 50/);
    });
  });

  describe('phoenixPlaceTriggerAction', () => {
    it('prepares a stop-loss with USD→tick conversion', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixPlaceTriggerAction.prepare(
        {
          symbol: 'SOL-PERP',
          side: 'short',
          baseSize: '0.5',
          triggerPriceUsd: '90',
          triggerDirection: 'less_than',
        },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      // usdToTickPrice(90) = 90 * 1e6 = 90_000_000
      expect(params.triggerPriceTicks).toBe('90000000');
      expect(params.triggerDirection).toBe('less_than');
    });
  });

  describe('phoenixCancelOrderAction', () => {
    it('prepares a cancel with orderId + priceTicks in params', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixCancelOrderAction.prepare(
        { orderId: '12345', symbol: 'SOL-PERP', priceTicks: '90000000' },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.orderId).toBe('12345');
      expect(params.priceTicks).toBe('90000000');
      expect(params.transactionBase64).toEqual(expect.any(String));
    });

    it('rejects non-numeric priceTicks at prepare (BigInt coercion in cancel flow)', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      // BigInt('abc') throws SyntaxError synchronously inside prepare's buildCancelOrderIxs call.
      await expect(
        phoenixCancelOrderAction.prepare(
          { orderId: '12345', symbol: 'SOL-PERP', priceTicks: 'abc' },
          fakeCtx(),
        ),
      ).rejects.toThrow(/BigInt|Cannot convert/i);
    });
  });

  describe('symbol normalization (H4)', () => {
    it('normalizes input symbol to uppercase regardless of input case', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixOpenAction.prepare(
        { symbol: 'sol-perp', side: 'long', baseSize: '0.5', leverage: 3 },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.symbol).toBe('SOL-PERP');
    });
  });

  describe('execute-time validation (C3 + H3)', () => {
    const VALID_BLOCKHASH = 'GwY7VR4hHvBfStcAd3rJ4FuFiF5KFRDavBKwjkqsdYkS';

    function preparedActionFor(walletAddress: string, mode: 'live' | 'paper' = 'live'): PreparedAction {
      return {
        id: 'a',
        kind: 'phoenix_open',
        status: 'approval_pending',
        walletAddress,
        cluster: 'mainnet-beta',
        summary: 'Open long 0.5 SOL-PERP',
        params: {
          symbol: 'SOL-PERP',
          side: 'long',
          baseSize: '0.5',
          walletAddress,
          mode,
          adapter: 'phoenix',
          connectorId: 'phoenix',
        },
        dueAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as PreparedAction;
    }

    it('rejects with unauthorized when current wallet differs from prepared wallet (C3)', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const ctx = fakeCtx('CurrentWalletAddress11111111111111111111111111');
      const action = preparedActionFor('DifferentWalletAddress22222222222222222222222');
      // AdapterError code is 'unauthorized'; message mentions "prepared for ... connected wallet is ...".
      await expect(phoenixOpenAction.execute(action, ctx)).rejects.toThrow(/was prepared for.*connected wallet is/);
    });

    it('rejects paper-mode action when policy flips paperModeOnly=false back to true (H3)', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const paperOnlyCtx = {
        ...fakeCtx(VALID_WALLET),
        config: {
          cluster: 'mainnet-beta',
          connectors: { phoenix: { perps: { enabled: true, paperModeOnly: true } } },
        } as AgentWalletConfig,
        connection: {
          getLatestBlockhash: async () => ({ blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 1000 }),
        } as DAppAdapterContext['connection'],
      };
      // Action stored with mode=live; policy now requires paper.
      const liveAction = preparedActionFor(VALID_WALLET, 'live');
      await expect(phoenixOpenAction.execute(liveAction, paperOnlyCtx)).rejects.toThrow(/paper_mode_required|paper-mode-only/i);
    });

    it('paper-mode action under paper policy executes (H3 positive)', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const paperOnlyCtx = {
        ...fakeCtx(VALID_WALLET),
        config: {
          cluster: 'mainnet-beta',
          connectors: { phoenix: { perps: { enabled: true, paperModeOnly: true } } },
        } as AgentWalletConfig,
      };
      const paperAction = preparedActionFor(VALID_WALLET, 'paper');
      const result = await phoenixOpenAction.execute(paperAction, paperOnlyCtx);
      expect(result.txid).toBe('sig_broadcast');
    });
  });

  describe('stop-loss direction combinations (regression for C1)', () => {
    it.each([
      ['long', 'less_than'],
      ['long', 'greater_than'],
      ['short', 'less_than'],
      ['short', 'greater_than'],
    ] as const)('prepares %s side / %s direction without inversion', async (side, triggerDirection) => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixPlaceTriggerAction.prepare(
        {
          symbol: 'SOL-PERP',
          side,
          baseSize: '0.5',
          triggerPriceUsd: '100',
          triggerDirection,
        },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.side).toBe(side);
      expect(params.triggerDirection).toBe(triggerDirection);
    });
  });

  describe('partial close (M-coverage)', () => {
    it('prepares a partial close when input.baseSize is smaller than current position', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixCloseAction.prepare(
        { symbol: 'SOL-PERP', baseSize: '0.2' },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.baseSize).toBe('0.2');
    });
  });

  // Note: invalid amountUsd validation lives in riseClient.usdcToLamports and is unit-tested there.
  // The actions.ts → fake-Rise-client path skips that helper, so we can't exercise the error here without
  // duplicating Rise's internals in the fake.

  describe('mode=live with paper-mode-only policy (prepare-time)', () => {
    it('rejects open with mode=live when policy.paperModeOnly=true', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const paperOnlyCtx = {
        ...fakeCtx(),
        config: {
          cluster: 'mainnet-beta',
          connectors: { phoenix: { perps: { enabled: true, paperModeOnly: true } } },
        } as AgentWalletConfig,
      };
      await expect(
        phoenixOpenAction.prepare(
          { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3, mode: 'live' },
          paperOnlyCtx,
        ),
      ).rejects.toThrow(/paper-mode-only/i);
    });
  });

  describe('refreshAtExecution flag (M4)', () => {
    it.each([
      ['open', () => phoenixOpenAction.prepare({ symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3 }, fakeCtx())],
      ['close', () => phoenixCloseAction.prepare({ symbol: 'SOL-PERP' }, fakeCtx())],
      ['modify_collateral', () => phoenixModifyCollateralAction.prepare({ direction: 'deposit', amountUsd: '100' }, fakeCtx())],
      ['place_trigger', () => phoenixPlaceTriggerAction.prepare({ symbol: 'SOL-PERP', side: 'short', baseSize: '0.5', triggerPriceUsd: '90', triggerDirection: 'less_than' }, fakeCtx())],
    ] as const)('%s sets refreshAtExecution: true', async (_name, fn) => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await fn();
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.refreshAtExecution).toBe(true);
    });
  });

  describe('dueAt + note propagation (M3)', () => {
    it('propagates dueAt + note to addInput for phoenix_open', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const dueAt = '2026-12-31T00:00:00.000Z';
      const note = 'pre-launch test memo';
      const result = await phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3, dueAt, note },
        fakeCtx(),
      );
      expect(result.addInput.dueAt).toBe(dueAt);
      expect(result.addInput.note).toBe(note);
    });
  });

  describe('priceLimitUsd (M1)', () => {
    it('propagates priceLimitUsd to params for phoenix_open', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3, priceLimitUsd: '120' },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.priceLimitUsd).toBe('120');
      expect(result.addInput.summary).toMatch(/limit \$120/);
    });
  });

  describe('traderPdaIndex (M2)', () => {
    it('propagates traderPdaIndex to params for phoenix_open', async () => {
      setPhoenixClientFactory(() => fakeRiseClient());
      const result = await phoenixOpenAction.prepare(
        { symbol: 'SOL-PERP', side: 'long', baseSize: '0.5', leverage: 3, traderPdaIndex: 2 },
        fakeCtx(),
      );
      const params = result.addInput.params as Record<string, unknown>;
      expect(params.traderPdaIndex).toBe(2);
    });
  });
});

// Re-import the AgentWalletConfig type for execute-time tests above. Top-level imports are kept clean.
import type { PreparedAction } from '../../../preparedActions.js';
