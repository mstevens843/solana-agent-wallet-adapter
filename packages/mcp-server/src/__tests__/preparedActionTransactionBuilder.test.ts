import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PublicKey, Transaction } from '@solana/web3.js';

import {
  resetKaminoClientFactory,
  setKaminoClientFactory,
  type KaminoBuildDepositResult,
  type KaminoBuildWithdrawResult,
  type KaminoClient,
  type KaminoPosition,
  type KaminoReserveSnapshot,
} from '../adapters/kamino/client.js';
import { clearReserveSnapshotCache } from '../adapters/kamino/reserveSnapshot.js';
import { AdapterError } from '../adapters/types.js';
import {
  CONNECTOR_APPROVAL_ACTION_TYPES,
  adapterForKind,
} from '../adapters/registry.js';
import {
  createCaptureContext,
  prepareTransactionForApproval,
} from '../preparedActionTransactionBuilder.js';
import type { AgentWalletConfig } from '../config.js';
import type { DAppAdapterContext } from '../adapters/types.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionKind,
  PreparedActionStore,
} from '../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

function fakeSnapshot(): KaminoReserveSnapshot {
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
  };
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

function makeContext(store: PreparedActionStore): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(),
    connection: {
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 };
      },
    } as unknown as DAppAdapterContext['connection'],
    signAndBroadcast: async () => {
      throw new Error('signAndBroadcast must be overridden by capture context');
    },
    signTransaction: async () => 'signed-base64-placeholder',
    signMessage: async () => 'signature-base64-placeholder',
    store,
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

describe('adapterForKind / CONNECTOR_APPROVAL_ACTION_TYPES', () => {
  it('resolves a registered kind to its AdapterAction', () => {
    const action = adapterForKind('kamino_deposit');
    expect(action).toBeDefined();
    expect(action?.kind).toBe('kamino_deposit');
    expect(action?.id).toBe('deposit');
  });

  it('returns undefined for unknown kinds', () => {
    expect(adapterForKind('not_a_real_kind' as PreparedActionKind)).toBeUndefined();
  });

  it('contains every adapter-registered kind', () => {
    expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('kamino_deposit')).toBe(true);
    expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('marginfi_deposit')).toBe(true);
    expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('jito_stake_sol')).toBe(true);
  });

  it('excludes non-adapter kinds like manual_review', () => {
    expect(CONNECTOR_APPROVAL_ACTION_TYPES.has('manual_review' as PreparedActionKind)).toBe(false);
  });
});

describe('prepareTransactionForApproval', () => {
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

  it('returns base64 + summary for a kamino_deposit approval without signing', async () => {
    const store = inMemoryStore();
    const ctx = makeContext(store);
    const prepared = await adapterForKind('kamino_deposit')!.prepare(
      { amount: '0.5', token: 'SOL' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);

    const payload = await prepareTransactionForApproval(action, ctx);

    expect(typeof payload.transactionBase64).toBe('string');
    expect(payload.transactionBase64.length).toBeGreaterThan(0);
    expect(payload.summary).toBe('Deposit 0.5 SOL into Kamino');
    expect(payload.cluster).toBe('mainnet-beta');
    expect(payload.preview).toMatchObject({
      reserveAddress: fakeState.snapshot.reserveAddress,
      reserveSymbol: 'SOL',
    });
    // The fake client recorded a deposit call, confirming the real execute() ran.
    expect(fakeState.depositCalls).toHaveLength(1);
    expect(fakeState.depositCalls[0]?.amountRaw).toBe(500_000_000n);
  });

  it('throws AdapterError(unknown_kind) when no adapter is registered', async () => {
    const store = inMemoryStore();
    const ctx = makeContext(store);
    const action: PreparedAction = {
      id: 'pa_unknown',
      kind: 'not_a_real_kind' as PreparedActionKind,
      status: 'ready',
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      summary: 'fake',
      params: {},
      dueAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(prepareTransactionForApproval(action, ctx))
      .rejects.toBeInstanceOf(AdapterError);
    await expect(prepareTransactionForApproval(action, ctx))
      .rejects.toMatchObject({ code: 'unknown_kind' });
  });

  it('propagates underlying adapter errors (e.g., SDK failure) so callers can map them to HTTP 502', async () => {
    const store = inMemoryStore();
    const ctx = makeContext(store);
    const prepared = await adapterForKind('kamino_deposit')!.prepare(
      { amount: '0.1', token: 'SOL' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    setKaminoClientFactory(() => ({
      ...buildFakeKamino(fakeState),
      buildDepositTransaction: async () => {
        throw new Error('forced build failure');
      },
    }));
    await expect(prepareTransactionForApproval(action, ctx)).rejects.toThrow(/forced build failure/);
  });
});

describe('createCaptureContext', () => {
  it('captures the first signAndBroadcast call and returns the sentinel', async () => {
    const store = inMemoryStore();
    const baseCtx = makeContext(store);
    const { ctx, captured } = createCaptureContext(baseCtx);

    const sentinel = await ctx.signAndBroadcast('AAA-base64', 'do the thing');

    expect(sentinel).toBe('__captured__');
    expect(captured.base64).toBe('AAA-base64');
    expect(captured.summary).toBe('do the thing');
  });

  it('throws AdapterError(multi_tx_not_supported) on a second signAndBroadcast call', async () => {
    const store = inMemoryStore();
    const baseCtx = makeContext(store);
    const { ctx } = createCaptureContext(baseCtx);

    await ctx.signAndBroadcast('first', 'first summary');
    await expect(ctx.signAndBroadcast('second', 'second summary'))
      .rejects.toBeInstanceOf(AdapterError);
    await expect(ctx.signAndBroadcast('third', 'third summary'))
      .rejects.toMatchObject({ code: 'multi_tx_not_supported' });
  });

  it('throws AdapterError(multi_tx_not_supported) when signAndBroadcastMany is called', async () => {
    const store = inMemoryStore();
    const baseCtx = makeContext(store);
    const { ctx } = createCaptureContext(baseCtx);

    expect(ctx.signAndBroadcastMany).toBeDefined();
    await expect(ctx.signAndBroadcastMany!(['a', 'b'], 'many'))
      .rejects.toMatchObject({ code: 'multi_tx_not_supported' });
  });

  it('passes through backend, connection, config, and store unchanged', () => {
    const store = inMemoryStore();
    const baseCtx = makeContext(store);
    const { ctx } = createCaptureContext(baseCtx);

    expect(ctx.backend).toBe(baseCtx.backend);
    expect(ctx.connection).toBe(baseCtx.connection);
    expect(ctx.config).toBe(baseCtx.config);
    expect(ctx.store).toBe(baseCtx.store);
    expect(ctx.signTransaction).toBe(baseCtx.signTransaction);
    expect(ctx.signMessage).toBe(baseCtx.signMessage);
  });
});
