import { afterEach, describe, expect, it } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  ORCA_ADAPTER_ID,
  ORCA_SUPPORTED_CLUSTERS,
  orcaAdapter,
} from '../../adapters/orca/index.js';
import {
  resetOrcaClientFactory,
  setOrcaClientFactory,
  type OrcaClient,
  type OrcaPosition,
  type OrcaWhirlpoolSnapshot,
} from '../../adapters/orca/client.js';
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
const WHIRLPOOL = '11111111111111111111111111111111';
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

interface FakeOrcaState {
  snapshot: OrcaWhirlpoolSnapshot;
  position: OrcaPosition;
  buildCalls: string[];
}

function fakeOrcaClient(state: FakeOrcaState): OrcaClient {
  const preview = {
    whirlpoolAddress: state.snapshot.whirlpoolAddress,
    positionMint: state.position.positionMint,
    tokenMints: [TOKEN_A, TOKEN_B],
    tokenAmounts: [{ mint: TOKEN_A, amount: '0.01', symbol: 'SOL' }],
    tickRange: { lowerTick: state.position.tickLowerIndex, upperTick: state.position.tickUpperIndex },
    priceRange: { currentPrice: state.snapshot.currentPrice },
    quote: { tokenMaxA: '0.01', tokenMaxB: '1.2' },
  };
  return {
    async getWhirlpoolSnapshot() {
      return state.snapshot;
    },
    async getWalletPositions(_connection, walletAddress, whirlpoolAddress) {
      return {
        walletAddress,
        ...(whirlpoolAddress !== undefined && { whirlpoolAddress }),
        positions: [state.position],
        totals: { positions: 1, inRange: 1, outOfRange: 0 },
      };
    },
    async getPositionDetail() {
      return state.position;
    },
    async previewIncreaseLiquidity() {
      return preview;
    },
    async previewDecreaseLiquidity() {
      return preview;
    },
    async previewCollectFees() {
      return {
        ...preview,
        tokenAmounts: [{ mint: TOKEN_A, amount: '0.0001', symbol: 'SOL' }],
      };
    },
    async previewCollectRewards() {
      return {
        ...preview,
        tokenAmounts: [{ mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', amount: '2', symbol: 'JUP' }],
      };
    },
    async buildIncreaseLiquidityTransaction() {
      state.buildCalls.push('increase');
      return { transactionBase64: 'base64-increase', preview };
    },
    async buildDecreaseLiquidityTransaction() {
      state.buildCalls.push('decrease');
      return { transactionBase64: 'base64-decrease', preview };
    },
    async buildCollectFeesTransaction() {
      state.buildCalls.push('fees');
      return { transactionBase64: 'base64-fees', preview };
    },
    async buildCollectRewardsTransaction() {
      state.buildCalls.push('rewards');
      return { transactionBase64: 'base64-rewards', preview };
    },
  };
}

function fakeSnapshot(overrides: Partial<OrcaWhirlpoolSnapshot> = {}): OrcaWhirlpoolSnapshot {
  return {
    whirlpoolAddress: WHIRLPOOL,
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    configAddress: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
    tokenMintA: TOKEN_A,
    tokenMintB: TOKEN_B,
    tokenVaultA: TOKEN_A,
    tokenVaultB: TOKEN_B,
    tickSpacing: 8,
    feeRateBps: 30,
    currentTickIndex: 64,
    currentPrice: '150',
    sqrtPrice: '123456',
    liquidity: '100000',
    rewardMints: [],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakePosition(overrides: Partial<OrcaPosition> = {}): OrcaPosition {
  return {
    positionMint: POSITION_MINT,
    positionAddress: POSITION_MINT,
    owner: WALLET,
    tokenAccount: POSITION_MINT,
    whirlpoolAddress: WHIRLPOOL,
    tokenMintA: TOKEN_A,
    tokenMintB: TOKEN_B,
    tickLowerIndex: 56,
    tickUpperIndex: 80,
    currentTickIndex: 64,
    inRange: true,
    liquidity: '5000',
    feesOwed: [{ mint: TOKEN_A, amount: '0.0001', symbol: 'SOL' }],
    rewardsOwed: [{ mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', amount: '2', symbol: 'JUP', familiar: false }],
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
    jupiter: { baseUrl: 'https://fake', apiKeyEnv: 'JUP_API_KEY' },
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
    signAndBroadcast: opts.signed ?? (async () => 'txid-orca'),
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

function fakeState(): FakeOrcaState {
  return {
    snapshot: fakeSnapshot(),
    position: fakePosition(),
    buildCalls: [],
  };
}

function requireOrcaAction(id: 'increase_liquidity' | 'decrease_liquidity' | 'collect_fees' | 'collect_rewards') {
  const action = orcaAdapter.actions[id];
  if (!action) throw new Error(`Orca adapter is missing action ${id}.`);
  return action;
}

afterEach(() => {
  resetOrcaClientFactory();
});

describe('Orca adapter shape', () => {
  it('registers with expected id, mainnet gating, reads, and actions', () => {
    expect(orcaAdapter.id).toBe(ORCA_ADAPTER_ID);
    expect(orcaAdapter.supportedClusters).toEqual(ORCA_SUPPORTED_CLUSTERS);
    expect(Object.keys(orcaAdapter.actions)).toEqual([
      'increase_liquidity',
      'decrease_liquidity',
      'collect_fees',
      'collect_rewards',
    ]);
    expect(orcaAdapter.reads.whirlpool_snapshot).toBeDefined();
    expect(orcaAdapter.reads.wallet_positions).toBeDefined();
    expect(orcaAdapter.reads.position_detail).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('orca').id).toBe('orca');
    expect(adapterForActionKind('orca_increase_liquidity')?.id).toBe('orca');
    expect(actionForKind('orca_collect_rewards')?.action.id).toBe('collect_rewards');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(orcaAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(orcaAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Orca liquidity preparation', () => {
  it('blocks new positions without a tick range', async () => {
    const state = fakeState();
    setOrcaClientFactory(() => fakeOrcaClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(requireOrcaAction('increase_liquidity').prepare({
      whirlpoolAddress: WHIRLPOOL,
      tokenAAmount: '0.01',
    }, ctx)).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares increase liquidity for an existing position with refreshed execution params', async () => {
    const state = fakeState();
    setOrcaClientFactory(() => fakeOrcaClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireOrcaAction('increase_liquidity').prepare({
      whirlpoolAddress: WHIRLPOOL,
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
    }, ctx);

    expect(result.addInput.kind).toBe('orca_increase_liquidity');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'orca',
      whirlpoolAddress: WHIRLPOOL,
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
      slippageBps: 100,
      refreshAtExecution: true,
    });
  });

  it('rejects decrease liquidity when percent and amount are both supplied', async () => {
    const state = fakeState();
    setOrcaClientFactory(() => fakeOrcaClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(requireOrcaAction('decrease_liquidity').prepare({
      whirlpoolAddress: WHIRLPOOL,
      positionMint: POSITION_MINT,
      liquidityPercent: 25,
      liquidityAmount: '100',
    }, ctx)).rejects.toBeInstanceOf(AdapterError);
  });

  it('executes by rebuilding a fresh transaction through the Orca client', async () => {
    const state = fakeState();
    setOrcaClientFactory(() => fakeOrcaClient(state));
    const store = inMemoryStore();
    const signedCalls: Array<{ tx: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ tx, summary });
        return 'txid-increase';
      },
    });

    const prepared = await requireOrcaAction('increase_liquidity').prepare({
      whirlpoolAddress: WHIRLPOOL,
      positionMint: POSITION_MINT,
      tokenAAmount: '0.01',
    }, ctx);
    const action = await store.addAction(prepared.addInput);
    const result = await requireOrcaAction('increase_liquidity').execute(action, ctx);

    expect(result.txid).toBe('txid-increase');
    expect(state.buildCalls).toEqual(['increase']);
    expect(signedCalls[0]).toMatchObject({ tx: 'base64-increase' });
  });
});

describe('Orca fee and reward preparation', () => {
  it('adds warning context for unfamiliar reward mints', async () => {
    const state = fakeState();
    setOrcaClientFactory(() => fakeOrcaClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireOrcaAction('collect_rewards').prepare({
      positionMint: POSITION_MINT,
      whirlpoolAddress: WHIRLPOOL,
    }, ctx);

    expect(result.addInput.kind).toBe('orca_collect_rewards');
    expect(result.addInput.params.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Reward mint'),
    ]));
  });
});
