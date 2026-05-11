import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PublicKey, Transaction } from '@solana/web3.js';

import {
  KAMINO_ADAPTER_ID,
  KAMINO_SUPPORTED_CLUSTERS,
  kaminoAdapter,
} from '../../adapters/kamino/index.js';
import {
  resetKaminoClientFactory,
  setKaminoClientFactory,
  type KaminoBuildDepositResult,
  type KaminoBuildWithdrawResult,
  type KaminoClient,
  type KaminoPosition,
  type KaminoReserveSnapshot,
} from '../../adapters/kamino/client.js';
import { clearReserveSnapshotCache } from '../../adapters/kamino/reserveSnapshot.js';
import { buildEarningsProof, canonicalizeJson } from '../../adapters/kamino/earningsProof.js';
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

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeKaminoState {
  snapshot: KaminoReserveSnapshot;
  positions: KaminoPosition[];
  depositCalls: Array<{ walletAddress: string; reserveMint: string; amountRaw: bigint }>;
  withdrawCalls: Array<{ walletAddress: string; reserveMint: string; amountRaw: bigint; withdrawAll?: boolean }>;
}

function buildFakeKamino(state: FakeKaminoState): KaminoClient {
  return {
    async getReserveSnapshot() {
      return state.snapshot;
    },
    async listReserveSnapshots() {
      return [state.snapshot];
    },
    async getPositions() {
      return state.positions;
    },
    async buildDepositTransaction(_connection, input): Promise<KaminoBuildDepositResult> {
      state.depositCalls.push(input);
      const tx = new Transaction();
      tx.feePayer = new PublicKey(input.walletAddress);
      tx.recentBlockhash = '11111111111111111111111111111111';
      return {
        transaction: tx,
        reserveAddress: state.snapshot.reserveAddress,
        reserveSymbol: state.snapshot.reserveSymbol,
        decimals: state.snapshot.decimals,
        amountUi: (Number(input.amountRaw) / 10 ** state.snapshot.decimals).toString(),
        reserveSnapshot: state.snapshot,
      };
    },
    async buildWithdrawTransaction(_connection, input): Promise<KaminoBuildWithdrawResult> {
      state.withdrawCalls.push(input);
      const tx = new Transaction();
      tx.feePayer = new PublicKey(input.walletAddress);
      tx.recentBlockhash = '11111111111111111111111111111111';
      return {
        transaction: tx,
        reserveAddress: state.snapshot.reserveAddress,
        reserveSymbol: state.snapshot.reserveSymbol,
        decimals: state.snapshot.decimals,
        amountUi: (Number(input.amountRaw) / 10 ** state.snapshot.decimals).toString(),
        reserveSnapshot: state.snapshot,
      };
    },
  };
}

function fakeSnapshot(overrides: Partial<KaminoReserveSnapshot> = {}): KaminoReserveSnapshot {
  return {
    reserveAddress: 'ReserveAddressForSolPlaceholder111111111111',
    reserveMint: 'So11111111111111111111111111111111111111112',
    reserveSymbol: 'SOL',
    decimals: 9,
    supplyApy: 5.4,
    borrowApy: 7.2,
    utilization: 68,
    totalSupply: '10000',
    totalBorrow: '6800',
    depositLimit: '50000',
    depositLimitRemaining: '40000',
    withdrawalDelaySec: 0,
    withdrawAvailable: '3200',
    lastUpdateSlot: 280_000_000,
    asOfBlockTime: 1_770_000_000,
    ...overrides,
  };
}

function fakeConfig(cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'): AgentWalletConfig {
  return { cluster, rpcUrl: 'https://api.fake', mainnet: { enabled: true, maxSolTransfer: '10', maxSwapInput: '10', maxSlippageBps: 100, allowArbitraryTransactions: false }, tokens: [], jupiter: { baseUrl: 'https://fake', apiKeyEnv: 'JUP_API_KEY' }, recurring: {} } as unknown as AgentWalletConfig;
}

function makeContext(opts: {
  store: PreparedActionStore;
  cluster?: 'mainnet-beta' | 'devnet';
  signed?: (transactionBase64: string, summary: string) => Promise<string>;
}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForKaminoTests111111111111111'),
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

afterEach(() => {
  resetKaminoClientFactory();
  clearReserveSnapshotCache();
});

function requireKaminoAction(id: 'deposit' | 'withdraw') {
  const action = kaminoAdapter.actions[id];
  if (!action) throw new Error(`Kamino adapter is missing action ${id}.`);
  return action;
}

describe('Kamino adapter shape', () => {
  it('registers with expected id, mainnet gating, and deposit/withdraw actions', () => {
    expect(kaminoAdapter.id).toBe(KAMINO_ADAPTER_ID);
    expect(kaminoAdapter.supportedClusters).toEqual(KAMINO_SUPPORTED_CLUSTERS);
    expect(Object.keys(kaminoAdapter.actions)).toEqual(['deposit', 'withdraw']);
    expect(kaminoAdapter.reads.positions).toBeDefined();
    expect(kaminoAdapter.reads.earnings_proof).toBeDefined();
    expect(kaminoAdapter.reads.reserve_snapshot).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('kamino').id).toBe('kamino');
    expect(adapterForActionKind('kamino_deposit')?.id).toBe('kamino');
    expect(actionForKind('kamino_withdraw')?.action.id).toBe('withdraw');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(kaminoAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(kaminoAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Kamino deposit prepare + execute', () => {
  let fakeState: FakeKaminoState;

  beforeEach(() => {
    fakeState = {
      snapshot: fakeSnapshot(),
      positions: [],
      depositCalls: [],
      withdrawCalls: [],
    };
    setKaminoClientFactory(() => buildFakeKamino(fakeState));
  });

  it('prepare enriches params with snapshot data and stores a kamino_deposit action', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireKaminoAction('deposit').prepare({ amount: '0.5', token: 'SOL' }, ctx);
    expect(result.addInput.kind).toBe('kamino_deposit');
    expect(result.addInput.summary).toBe('Deposit 0.5 SOL into Kamino');
    expect(result.addInput.params).toMatchObject({
      adapter: 'kamino',
      reserveMint: fakeState.snapshot.reserveMint,
      reserveSymbol: 'SOL',
      decimals: 9,
      amount: '0.5',
      amountRaw: (500_000_000n).toString(),
      supplyApy: 5.4,
      utilization: 68,
    });
  });

  it('execute calls signAndBroadcast with the rebuilt transaction and returns a txid', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (_tx, summary) => {
        signedCalls.push({ summary });
        return 'broadcasted-txid-for-deposit';
      },
    });
    const prepared = await requireKaminoAction('deposit').prepare({ amount: '1', token: 'SOL' }, ctx);
    const action = await store.addAction(prepared.addInput);
    const result = await requireKaminoAction('deposit').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-txid-for-deposit');
    expect(signedCalls[0]?.summary).toBe('Deposit 1 SOL into Kamino');
    expect(fakeState.depositCalls).toHaveLength(1);
    expect(fakeState.depositCalls[0]?.amountRaw).toBe(1_000_000_000n);
  });

  it('rejects unknown reserves with a clear AdapterError', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireKaminoAction('deposit').prepare({ amount: '1', token: 'TOTALLY_FAKE' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Kamino withdraw prepare', () => {
  let fakeState: FakeKaminoState;

  beforeEach(() => {
    fakeState = {
      snapshot: fakeSnapshot(),
      positions: [
        {
          reserveAddress: fakeSnapshot().reserveAddress,
          reserveMint: fakeSnapshot().reserveMint,
          reserveSymbol: 'SOL',
          decimals: 9,
          suppliedAmount: '2',
          currentValue: '2.1',
          earnedInterest: '0.1',
          supplyApy: 5.4,
          withdrawAvailable: '2.1',
          asOfSlot: 280_000_000,
        },
      ],
      depositCalls: [],
      withdrawCalls: [],
    };
    setKaminoClientFactory(() => buildFakeKamino(fakeState));
  });

  it('refuses to prepare when the wallet has no supply in the reserve', async () => {
    fakeState.positions = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireKaminoAction('withdraw').prepare({ amount: '0.1', token: 'SOL' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it("handles withdrawAll by reading current value from the position", async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireKaminoAction('withdraw').prepare(
      { withdrawAll: true, token: 'SOL' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      withdrawAll: true,
      amount: '2.1',
    });
  });
});

describe('earnings proof', () => {
  it('produces a deterministic canonical payload for the same inputs', async () => {
    setKaminoClientFactory(() =>
      buildFakeKamino({
        snapshot: fakeSnapshot(),
        positions: [
          {
            reserveAddress: 'ReserveAddressForSolPlaceholder111111111111',
            reserveMint: 'So11111111111111111111111111111111111111112',
            reserveSymbol: 'SOL',
            decimals: 9,
            suppliedAmount: '10',
            currentValue: '10.421',
            earnedInterest: '0.421',
            supplyApy: 5.4,
            withdrawAvailable: '10.421',
            asOfSlot: 280_000_000,
          },
        ],
        depositCalls: [],
        withdrawCalls: [],
      }),
    );
    const now = new Date('2026-05-11T12:00:00Z');
    const first = await buildEarningsProof({} as never, {
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      now,
    });
    const second = await buildEarningsProof({} as never, {
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      now,
    });
    expect(first.canonicalJson).toEqual(second.canonicalJson);
    expect(first.canonicalBase64).toEqual(second.canonicalBase64);
    expect(first.payload.schema).toBe('kamino-earnings-v1');
    expect(first.payload.totals.reserveCount).toBe(1);
  });

  it('canonicalizes JSON with sorted keys (deterministic bytes)', () => {
    const a = canonicalizeJson({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalizeJson({ a: 2, b: 1, c: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}');
  });
});
