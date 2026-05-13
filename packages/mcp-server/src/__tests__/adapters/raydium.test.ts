import { afterEach, describe, expect, it } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  RAYDIUM_ADAPTER_ID,
  RAYDIUM_SUPPORTED_CLUSTERS,
  raydiumAdapter,
} from '../../adapters/raydium/index.js';
import {
  resetRaydiumClientFactory,
  setRaydiumClientFactory,
  type RaydiumClient,
  type RaydiumPoolSnapshot,
  type RaydiumPosition,
} from '../../adapters/raydium/client.js';
import {
  AdapterError,
  actionForKind,
  adapterForActionKind,
  assertSupportedCluster,
  requireAdapter,
} from '../../adapters/index.js';
import type { AgentWalletConfig } from '../../config.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const POOL = '11111111111111111111111111111111';
const POSITION_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeRaydiumState {
  snapshot: RaydiumPoolSnapshot;
  position: RaydiumPosition;
  buildCalls: string[];
}

function fakeRaydiumClient(state: FakeRaydiumState): RaydiumClient {
  const preview = {
    poolId: state.snapshot.poolId,
    poolType: state.snapshot.poolType,
    positionMint: state.position.positionMint,
    tokenMints: [TOKEN_A, TOKEN_B],
    tokenAmounts: [{ mint: TOKEN_A, amount: '0.01', symbol: 'SOL' }],
    tickRange: { lowerTick: 56, upperTick: 80 },
    priceRange: { currentPrice: state.snapshot.price },
    rewardMints: [],
  };
  return {
    async getPoolSnapshot() {
      return state.snapshot;
    },
    async getWalletPositions(_connection, walletAddress, input) {
      return {
        walletAddress,
        ...(input?.poolId !== undefined && { poolId: input.poolId }),
        positions: [state.position],
        totals: { positions: 1, clmmPositions: 1, cpmmPositions: 0, farmPositions: 0 },
      };
    },
    async getPositionDetail() {
      return state.position;
    },
    async previewAddLiquidity() {
      return preview;
    },
    async previewRemoveLiquidity() {
      return preview;
    },
    async previewCollectFees() {
      return {
        ...preview,
        tokenAmounts: [{ mint: TOKEN_A, amount: '0.0001', symbol: 'SOL' }],
      };
    },
    async previewFarmStake(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: TOKEN_A,
        tokenAmounts: [{ mint: TOKEN_A, amount: input.amount ?? '0', symbol: 'SOL' }],
        rewardMints: [TOKEN_B],
      };
    },
    async previewFarmUnstake(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: TOKEN_A,
        tokenAmounts: [{ mint: TOKEN_A, amount: input.amount ?? '0', symbol: 'SOL' }],
        rewardMints: [TOKEN_B],
      };
    },
    async previewHarvest(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: TOKEN_A,
        rewardMints: [TOKEN_B],
        quote: { operation: 'harvest' },
      };
    },
    async buildAddLiquidityTransaction() {
      state.buildCalls.push('add');
      return { transactionBase64: 'base64-add', programIds: [state.snapshot.programId], preview };
    },
    async buildRemoveLiquidityTransaction() {
      state.buildCalls.push('remove');
      return { transactionBase64: 'base64-remove', programIds: [state.snapshot.programId], preview };
    },
    async buildCollectFeesTransaction() {
      state.buildCalls.push('fees');
      return { transactionBase64: 'base64-fees', programIds: [state.snapshot.programId], preview };
    },
    async buildFarmStakeTransaction() {
      state.buildCalls.push('stake');
      return { transactionBase64: 'base64-stake', programIds: [state.snapshot.programId], preview };
    },
    async buildFarmUnstakeTransaction() {
      state.buildCalls.push('unstake');
      return { transactionBase64: 'base64-unstake', programIds: [state.snapshot.programId], preview };
    },
    async buildHarvestTransaction() {
      state.buildCalls.push('harvest');
      return { transactionBase64: 'base64-harvest', programIds: [state.snapshot.programId], preview };
    },
  };
}

function fakeSnapshot(overrides: Partial<RaydiumPoolSnapshot> = {}): RaydiumPoolSnapshot {
  return {
    poolId: POOL,
    poolType: 'clmm',
    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    mintA: { mint: TOKEN_A, decimals: 9, symbol: 'SOL' },
    mintB: { mint: TOKEN_B, decimals: 6, symbol: 'USDC' },
    price: '150',
    liquidity: '100000',
    tvl: '500000',
    feeRateBps: 25,
    tickCurrent: 64,
    tickSpacing: 8,
    rewardMints: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakePosition(overrides: Partial<RaydiumPosition> = {}): RaydiumPosition {
  return {
    positionType: 'clmm',
    poolType: 'clmm',
    poolId: POOL,
    positionMint: POSITION_MINT,
    tickLower: 56,
    tickUpper: 80,
    currentTick: 64,
    inRange: true,
    liquidity: '5000',
    feesOwed: [{ mint: TOKEN_A, amount: '0.0001', symbol: 'SOL' }],
    rewardsOwed: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeConfig(cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'): AgentWalletConfig {
  return {
    cluster,
    rpcUrl: 'https://api.fake',
    mainnet: { enabled: true, maxSolTransfer: '10', maxSwapInput: '10', maxSlippageBps: 100, allowArbitraryTransactions: false },
    tokens: [],
    jupiter: { baseUrl: 'https://fake', apiKeyEnv: 'JUPITER_API_KEY' },
    recurring: {},
  } as unknown as AgentWalletConfig;
}

function makeContext(opts: {
  store: PreparedActionStore;
  cluster?: 'mainnet-beta' | 'devnet';
  signed?: (transactionBase64: string, summary: string) => Promise<string>;
}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {} as Connection,
    signAndBroadcast: opts.signed ?? (async () => 'txid-raydium'),
    store: opts.store,
  };
}

function inMemoryStore(): PreparedActionStore {
  const actions: PreparedAction[] = [];
  return {
    async addAction(input: AddPreparedActionInput): Promise<PreparedAction> {
      const now = new Date().toISOString();
      const action: PreparedAction = {
        id: `pa_${actions.length + 1}`,
        kind: input.kind,
        status: input.status ?? 'ready',
        walletAddress: input.walletAddress,
        cluster: input.cluster,
        summary: input.summary,
        params: input.params,
        dueAt: input.dueAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      actions.push(action);
      return action;
    },
    async listActions() {
      return [...actions];
    },
    async getAction(id) {
      return actions.find((entry) => entry.id === id) ?? null;
    },
    async updateAction(id, patch) {
      const index = actions.findIndex((entry) => entry.id === id);
      const current = actions[index];
      if (!current) throw new Error(`Unknown ${id}`);
      actions[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
      return actions[index]!;
    },
    async deleteAction(id) {
      const before = actions.length;
      const next = actions.filter((entry) => entry.id !== id);
      actions.length = 0;
      actions.push(...next);
      return next.length !== before;
    },
    async archiveAction(id) {
      const current = await this.getAction(id);
      if (!current) throw new Error('missing');
      return current;
    },
    async addRecurringPayment() {
      throw new Error('not implemented for tests');
    },
    async listRecurringPayments() {
      return [];
    },
    async listRecurringPaymentViews() {
      return [];
    },
    async updateRecurringPayment() {
      throw new Error('not implemented for tests');
    },
    async deleteRecurringPayment() {
      return false;
    },
    async materializeDueRecurring() {
      return [];
    },
    async listReceipts() {
      return [];
    },
  };
}

function fakeState(): FakeRaydiumState {
  return {
    snapshot: fakeSnapshot(),
    position: fakePosition(),
    buildCalls: [],
  };
}

function requireRaydiumAction(id: 'add_liquidity' | 'remove_liquidity' | 'collect_fees' | 'farm_stake' | 'farm_unstake' | 'harvest') {
  const action = raydiumAdapter.actions[id];
  if (!action) throw new Error(`Raydium adapter is missing action ${id}.`);
  return action;
}

afterEach(() => {
  resetRaydiumClientFactory();
});

describe('Raydium adapter shape', () => {
  it('registers with expected id, mainnet gating, reads, and actions', () => {
    expect(raydiumAdapter.id).toBe(RAYDIUM_ADAPTER_ID);
    expect(raydiumAdapter.supportedClusters).toEqual(RAYDIUM_SUPPORTED_CLUSTERS);
    expect(Object.keys(raydiumAdapter.actions)).toEqual([
      'add_liquidity',
      'remove_liquidity',
      'collect_fees',
      'farm_stake',
      'farm_unstake',
      'harvest',
    ]);
    expect(raydiumAdapter.reads.pool_snapshot).toBeDefined();
    expect(raydiumAdapter.reads.wallet_positions).toBeDefined();
    expect(raydiumAdapter.reads.position_detail).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('raydium').id).toBe('raydium');
    expect(adapterForActionKind('raydium_add_liquidity')?.id).toBe('raydium');
    expect(actionForKind('raydium_harvest')?.action.id).toBe('harvest');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(raydiumAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(raydiumAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Raydium liquidity preparation', () => {
  it('blocks new CLMM positions without a range', async () => {
    const state = fakeState();
    setRaydiumClientFactory(() => fakeRaydiumClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(requireRaydiumAction('add_liquidity').prepare({
      poolId: POOL,
      poolType: 'clmm',
      tokenAAmount: '0.01',
      maxTokenBAmount: '1',
    }, ctx)).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares add liquidity with refreshed execution params', async () => {
    const state = fakeState();
    setRaydiumClientFactory(() => fakeRaydiumClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireRaydiumAction('add_liquidity').prepare({
      poolId: POOL,
      poolType: 'clmm',
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
      maxTokenBAmount: '1',
    }, ctx);

    expect(result.addInput.kind).toBe('raydium_add_liquidity');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'raydium',
      poolId: POOL,
      poolType: 'clmm',
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
      slippageBps: 100,
      refreshAtExecution: true,
    });
  });

  it('executes by rebuilding a fresh transaction through the Raydium client', async () => {
    const state = fakeState();
    setRaydiumClientFactory(() => fakeRaydiumClient(state));
    const store = inMemoryStore();
    const signedCalls: Array<{ tx: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ tx, summary });
        return 'txid-add';
      },
    });

    const prepared = await requireRaydiumAction('add_liquidity').prepare({
      poolId: POOL,
      poolType: 'clmm',
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
      maxTokenBAmount: '1',
    }, ctx);
    const action = await store.addAction(prepared.addInput);
    const result = await requireRaydiumAction('add_liquidity').execute(action, ctx);

    expect(result.txid).toBe('txid-add');
    expect(state.buildCalls).toEqual(['add']);
    expect(signedCalls[0]).toMatchObject({ tx: 'base64-add' });
  });
});

describe('Raydium farm preparation', () => {
  it('prepares harvest without requiring an amount', async () => {
    const state = fakeState();
    setRaydiumClientFactory(() => fakeRaydiumClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireRaydiumAction('harvest').prepare({
      farmId: POOL,
    }, ctx);

    expect(result.addInput.kind).toBe('raydium_harvest');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'raydium',
      farmId: POOL,
      refreshAtExecution: true,
    });
  });
});
