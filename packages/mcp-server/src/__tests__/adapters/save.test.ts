import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PublicKey, Transaction } from '@solana/web3.js';

import {
  SAVE_ADAPTER_ID,
  SAVE_MAIN_MARKET,
  SAVE_SUPPORTED_CLUSTERS,
  saveAdapter,
} from '../../adapters/save/index.js';
import {
  describeSolendUnavailableReason,
  resetSaveClientFactory,
  setSaveClientFactory,
  type SaveBuildInput,
  type SaveBuildResult,
  type SaveClient,
  type SaveMarketSnapshot,
  type SaveObligation,
  type SaveReserveSnapshot,
} from '../../adapters/save/client.js';
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
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeSaveState {
  reserves: Record<string, SaveReserveSnapshot>;
  obligation: SaveObligation | null;
  depositCalls: SaveBuildInput[];
  withdrawCalls: SaveBuildInput[];
  borrowCalls: SaveBuildInput[];
  repayCalls: SaveBuildInput[];
}

function buildFakeSave(state: FakeSaveState): SaveClient {
  const market: SaveMarketSnapshot = {
    marketAddress: SAVE_MAIN_MARKET.toBase58(),
    programId: 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',
    reserveCount: Object.keys(state.reserves).length,
    totalDeposits: '1000000',
    totalBorrows: '500000',
    reserves: Object.values(state.reserves),
  };
  const buildTx = (input: SaveBuildInput, kind: 'deposit' | 'withdraw' | 'borrow' | 'repay'): SaveBuildResult => {
    const snapshot = state.reserves[input.reserveMint];
    if (!snapshot) throw new Error(`No fake reserve for ${input.reserveMint}`);
    const tx = new Transaction();
    tx.feePayer = new PublicKey(input.walletAddress);
    tx.recentBlockhash = '11111111111111111111111111111111';
    const amountUi = (Number(input.amountRaw) / 10 ** snapshot.decimals).toString();
    if (kind === 'deposit') state.depositCalls.push(input);
    if (kind === 'withdraw') state.withdrawCalls.push(input);
    if (kind === 'borrow') state.borrowCalls.push(input);
    if (kind === 'repay') state.repayCalls.push(input);
    return {
      transaction: tx,
      reserveAddress: snapshot.reserveAddress,
      reserveSymbol: snapshot.reserveSymbol,
      decimals: snapshot.decimals,
      amountUi,
      reserveSnapshot: snapshot,
    };
  };
  return {
    async getMarketSnapshot() {
      return market;
    },
    async getReserveSnapshot(_connection, reserveMint) {
      const snapshot = state.reserves[reserveMint];
      if (!snapshot) throw new Error(`No fake reserve for ${reserveMint}`);
      return snapshot;
    },
    async listReserveSnapshots() {
      return Object.values(state.reserves);
    },
    async getObligation() {
      return state.obligation;
    },
    async buildDepositTransaction(_connection, input) {
      return buildTx(input, 'deposit');
    },
    async buildWithdrawTransaction(_connection, input) {
      return buildTx(input, 'withdraw');
    },
    async buildBorrowTransaction(_connection, input) {
      return buildTx(input, 'borrow');
    },
    async buildRepayTransaction(_connection, input) {
      return buildTx(input, 'repay');
    },
  };
}

function fakeReserve(overrides: Partial<SaveReserveSnapshot> = {}): SaveReserveSnapshot {
  return {
    reserveAddress: 'ReserveAddressForUsdcPlaceholder1111111111',
    reserveMint: USDC_MINT,
    reserveSymbol: 'USDC',
    decimals: 6,
    marketAddress: SAVE_MAIN_MARKET.toBase58(),
    supplyApy: 4.2,
    borrowApy: 7.5,
    utilization: 0.62,
    totalSupply: '10000000',
    totalBorrow: '6200000',
    liquidity: '3800000',
    collateralFactor: 0.85,
    liquidationThreshold: 0.9,
    liquidationBonus: 0.05,
    depositLimit: '50000000',
    depositLimitRemaining: '40000000',
    borrowLimit: '40000000',
    borrowLimitRemaining: '33800000',
    withdrawAvailable: '3800000',
    priceUsd: 1,
    lastUpdateSlot: 280_000_000,
    asOfBlockTime: 1_770_000_000,
    ...overrides,
  };
}

function solReserve(overrides: Partial<SaveReserveSnapshot> = {}): SaveReserveSnapshot {
  return fakeReserve({
    reserveAddress: 'ReserveAddressForSolPlaceholder11111111111',
    reserveMint: SOL_MINT,
    reserveSymbol: 'SOL',
    decimals: 9,
    priceUsd: 200,
    ...overrides,
  });
}

function fakeObligation(overrides: Partial<SaveObligation> = {}): SaveObligation {
  return {
    obligationAddress: 'ObligationAddressPlaceholder111111111111',
    marketAddress: SAVE_MAIN_MARKET.toBase58(),
    walletAddress: WALLET,
    deposits: [
      {
        reserveAddress: 'ReserveAddressForUsdcPlaceholder1111111111',
        reserveMint: USDC_MINT,
        reserveSymbol: 'USDC',
        decimals: 6,
        amount: '1000',
        amountRaw: (1_000_000_000n).toString(),
        valueUsd: 1000,
        collateralValueUsd: 850,
      },
    ],
    borrows: [
      {
        reserveAddress: 'ReserveAddressForUsdcPlaceholder1111111111',
        reserveMint: USDC_MINT,
        reserveSymbol: 'USDC',
        decimals: 6,
        amount: '100',
        amountRaw: (100_000_000n).toString(),
        valueUsd: 100,
        weightedValueUsd: 100,
      },
    ],
    totalDepositValueUsd: 1000,
    totalBorrowValueUsd: 100,
    borrowLimitUsd: 850,
    liquidationThresholdUsd: 900,
    healthFactor: 9,
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeConfig(cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'): AgentWalletConfig {
  return {
    cluster,
    rpcUrl: 'https://api.fake',
    mainnet: {
      enabled: true,
      maxSolTransfer: '10',
      maxSwapInput: '10',
      maxSlippageBps: 100,
      allowArbitraryTransactions: false,
    },
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
    connection: {
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 };
      },
    } as unknown as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForSaveTests111111111111111'),
    signTransaction: async () => "signed-base64-placeholder",
    signMessage: async () => "signature-base64-placeholder",
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
  resetSaveClientFactory();
});

function requireSaveAction(id: 'deposit' | 'withdraw' | 'borrow' | 'repay') {
  const action = saveAdapter.actions[id];
  if (!action) throw new Error(`Save adapter is missing action ${id}.`);
  return action;
}

describe('Save adapter shape', () => {
  it('registers with expected id, mainnet gating, and deposit/withdraw/borrow/repay actions', () => {
    expect(saveAdapter.id).toBe(SAVE_ADAPTER_ID);
    expect(saveAdapter.supportedClusters).toEqual(SAVE_SUPPORTED_CLUSTERS);
    expect(Object.keys(saveAdapter.actions).sort()).toEqual(['borrow', 'deposit', 'repay', 'withdraw']);
    expect(saveAdapter.reads.reserve_snapshot).toBeDefined();
    expect(saveAdapter.reads.market_snapshot).toBeDefined();
    expect(saveAdapter.reads.wallet_obligation).toBeDefined();
    expect(saveAdapter.reads.health_preview).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('save').id).toBe('save');
    expect(adapterForActionKind('save_deposit')?.id).toBe('save');
    expect(adapterForActionKind('save_withdraw')?.id).toBe('save');
    expect(adapterForActionKind('save_borrow')?.id).toBe('save');
    expect(adapterForActionKind('save_repay')?.id).toBe('save');
    expect(actionForKind('save_borrow')?.action.id).toBe('borrow');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(saveAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(saveAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Save SDK availability', () => {
  it('default factory reports the unavailable reason instead of pretending to work', async () => {
    resetSaveClientFactory();
    expect(describeSolendUnavailableReason()).toMatch(/@solendprotocol\/solend-sdk/);
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('deposit').prepare({ amount: '10', token: 'USDC' }, ctx),
    ).rejects.toThrow(/Save adapter is not configured/);
  });
});

describe('Save deposit prepare + execute', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve(), [SOL_MINT]: solReserve() },
      obligation: null,
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('prepare enriches params with snapshot, obligation, health preview, and stores a save_deposit', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireSaveAction('deposit').prepare({ amount: '10', token: 'USDC' }, ctx);
    expect(result.addInput.kind).toBe('save_deposit');
    expect(result.addInput.summary).toBe('Deposit 10 USDC into Save');
    expect(result.addInput.params).toMatchObject({
      adapter: 'save',
      reserveMint: USDC_MINT,
      reserveSymbol: 'USDC',
      decimals: 6,
      amount: '10',
      amountRaw: (10_000_000n).toString(),
      refreshAtExecution: true,
    });
    expect(result.addInput.params.healthPreview).toBeDefined();
  });

  it('execute rebuilds tx and calls signAndBroadcast with a fresh blockhash', async () => {
    const store = inMemoryStore();
    const signed: Array<{ summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (_tx, summary) => {
        signed.push({ summary });
        return 'broadcasted-save-deposit-txid';
      },
    });
    const prepared = await requireSaveAction('deposit').prepare({ amount: '1', token: 'USDC' }, ctx);
    const action = await store.addAction(prepared.addInput);
    const result = await requireSaveAction('deposit').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-save-deposit-txid');
    expect(signed[0]?.summary).toBe('Deposit 1 USDC into Save');
    expect(state.depositCalls).toHaveLength(1);
    expect(state.depositCalls[0]?.amountRaw).toBe(1_000_000n);
  });

  it('rejects unknown reserves with a clear AdapterError', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('deposit').prepare({ amount: '1', token: 'TOTALLY_FAKE' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Save withdraw prepare + execute', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('withdrawAll uses the obligation deposit amount when no debt blocks it', async () => {
    state.obligation = fakeObligation({
      borrows: [],
      totalBorrowValueUsd: 0,
      healthFactor: Number.POSITIVE_INFINITY,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('withdraw').prepare(
      { withdrawAll: true, token: 'USDC' },
      ctx,
    );
    expect(prepared.addInput.params).toMatchObject({
      withdrawAll: true,
      reserveSymbol: 'USDC',
      amountRaw: (1_000_000_000n).toString(),
    });
  });

  it('execute rebuilds the withdraw transaction with a fresh obligation snapshot', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('withdraw').prepare(
      { amount: '50', token: 'USDC' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireSaveAction('withdraw').execute(action, ctx);
    expect(result.txid).toBeDefined();
    expect(state.withdrawCalls).toHaveLength(1);
  });

  it('execute throws projected_health_unsafe when oracle drift breaches min HF', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('withdraw').prepare(
      { amount: '50', token: 'USDC' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    // Simulate oracle drift: USDC price drops and obligation now has a heavy borrow.
    state.obligation = fakeObligation({
      totalBorrowValueUsd: 880,
      liquidationThresholdUsd: 900,
      healthFactor: 1.02,
    });
    await expect(requireSaveAction('withdraw').execute(action, ctx)).rejects.toMatchObject({
      code: 'projected_health_unsafe',
    });
  });

  it('rejects withdraw with no existing deposit', async () => {
    state.obligation = fakeObligation({ deposits: [] });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('withdraw').prepare({ amount: '1', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'no_position' });
  });
});

describe('Save defensive guards', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve(), [SOL_MINT]: solReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('deposit blocks amounts above depositLimitRemaining', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ depositLimitRemaining: '5' });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('deposit').prepare({ amount: '10', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'exceeds_cap' });
  });

  it('deposit refuses when depositLimitRemaining is zero', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ depositLimitRemaining: '0' });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('deposit').prepare({ amount: '1', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'exceeds_cap' });
  });

  it('borrow blocks amounts above borrowLimitRemaining', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ borrowLimitRemaining: '1' });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('borrow').prepare({ amount: '5', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'exceeds_cap' });
  });

  it('borrow refuses when the wallet has no collateral', async () => {
    state.obligation = null;
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('borrow').prepare({ amount: '5', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'no_collateral' });
  });

  it('borrow refuses when the obligation has zero deposit value', async () => {
    state.obligation = fakeObligation({
      deposits: [],
      borrows: [],
      totalDepositValueUsd: 0,
      totalBorrowValueUsd: 0,
      borrowLimitUsd: 0,
      liquidationThresholdUsd: 0,
      healthFactor: Number.POSITIVE_INFINITY,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('borrow').prepare({ amount: '5', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'no_collateral' });
  });

  it('borrow refuses when the reserve has no oracle price (priceUsd missing)', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ priceUsd: undefined });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('borrow').prepare({ amount: '1', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'projected_health_unsafe' });
  });

  it('withdraw refuses when the reserve has no oracle price (priceUsd missing)', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ priceUsd: undefined });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('withdraw').prepare({ amount: '1', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'projected_health_unsafe' });
  });

  it('deposit accepts a reserve without a price (deposit is conservative)', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ priceUsd: undefined });
    state.obligation = null;
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('deposit').prepare(
      { amount: '1', token: 'USDC' },
      ctx,
    );
    expect(prepared.addInput.kind).toBe('save_deposit');
  });

  it('repay accepts a reserve without a price (repay only improves health)', async () => {
    state.reserves[USDC_MINT] = fakeReserve({ priceUsd: undefined });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('repay').prepare(
      { amount: '1', token: 'USDC' },
      ctx,
    );
    expect(prepared.addInput.kind).toBe('save_repay');
  });
});

describe('Save borrow prepare + execute', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('blocks at prepare when projected HF would drop below the minimum', async () => {
    state.obligation = fakeObligation({
      totalBorrowValueUsd: 800,
      borrowLimitUsd: 850,
      liquidationThresholdUsd: 900,
      healthFactor: 1.125,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('borrow').prepare({ amount: '100', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'projected_health_unsafe' });
  });

  it('prepare stores save_borrow with health preview when projected HF is safe', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('borrow').prepare(
      { amount: '5', token: 'USDC' },
      ctx,
    );
    expect(prepared.addInput.kind).toBe('save_borrow');
    expect(prepared.addInput.params.amountRaw).toBe((5_000_000n).toString());
    expect(prepared.addInput.params.healthPreview).toBeDefined();
  });

  it('execute throws projected_health_unsafe when fresh obligation breaches HF', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('borrow').prepare(
      { amount: '5', token: 'USDC' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    state.obligation = fakeObligation({
      totalBorrowValueUsd: 880,
      borrowLimitUsd: 850,
      liquidationThresholdUsd: 900,
      healthFactor: 1.02,
    });
    await expect(requireSaveAction('borrow').execute(action, ctx)).rejects.toMatchObject({
      code: 'projected_health_unsafe',
    });
    expect(state.borrowCalls).toHaveLength(0);
  });
});

describe('Save repay prepare + execute', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('repayAll stores the full outstanding debt amount and skips health gating', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('repay').prepare(
      { repayAll: true, token: 'USDC' },
      ctx,
    );
    expect(prepared.addInput.kind).toBe('save_repay');
    expect(prepared.addInput.params).toMatchObject({
      repayAll: true,
      amountRaw: (100_000_000n).toString(),
    });
    const action = await store.addAction(prepared.addInput);
    const result = await requireSaveAction('repay').execute(action, ctx);
    expect(result.txid).toBeDefined();
    expect(state.repayCalls).toHaveLength(1);
    expect(state.repayCalls[0]?.repayAll).toBe(true);
  });

  it('rejects repay when no debt exists for the reserve', async () => {
    state.obligation = fakeObligation({ borrows: [] });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireSaveAction('repay').prepare({ amount: '1', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({ code: 'no_position' });
  });
});

describe('Save wallet ownership gate', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('execute throws unauthorized when prepared action belongs to a different wallet', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireSaveAction('deposit').prepare(
      { amount: '1', token: 'USDC' },
      ctx,
    );
    const action = await store.addAction({
      ...prepared.addInput,
      walletAddress: 'WrongWalletAddressForOwnershipTest11111111',
    });
    await expect(requireSaveAction('deposit').execute(action, ctx)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('Save reads', () => {
  let state: FakeSaveState;

  beforeEach(() => {
    state = {
      reserves: { [USDC_MINT]: fakeReserve(), [SOL_MINT]: solReserve() },
      obligation: fakeObligation(),
      depositCalls: [],
      withdrawCalls: [],
      borrowCalls: [],
      repayCalls: [],
    };
    setSaveClientFactory(() => buildFakeSave(state));
  });

  it('reserve_snapshot returns the requested reserve by symbol', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = saveAdapter.reads.reserve_snapshot!;
    const snapshot = (await read.read({ token: 'USDC' }, ctx)) as SaveReserveSnapshot;
    expect(snapshot.reserveMint).toBe(USDC_MINT);
  });

  it('wallet_obligation returns the wallet obligation when present', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = saveAdapter.reads.wallet_obligation!;
    const result = (await read.read({}, ctx)) as { obligation: SaveObligation | null; walletAddress: string };
    expect(result.walletAddress).toBe(WALLET);
    expect(result.obligation?.deposits.length).toBe(1);
  });

  it('wallet_obligation returns null when no obligation exists', async () => {
    state.obligation = null;
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = saveAdapter.reads.wallet_obligation!;
    const result = (await read.read({}, ctx)) as { obligation: SaveObligation | null };
    expect(result.obligation).toBeNull();
  });

  it('market_snapshot returns aggregated reserves', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = saveAdapter.reads.market_snapshot!;
    const market = (await read.read({}, ctx)) as SaveMarketSnapshot;
    expect(market.reserveCount).toBe(2);
    expect(market.marketAddress).toBe(SAVE_MAIN_MARKET.toBase58());
  });

  it('health_preview flags a borrow breach at the configured min HF', async () => {
    state.obligation = fakeObligation({
      totalBorrowValueUsd: 800,
      borrowLimitUsd: 850,
      liquidationThresholdUsd: 900,
      healthFactor: 1.125,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = saveAdapter.reads.health_preview!;
    const result = (await read.read(
      { operation: 'borrow', amount: '100', token: 'USDC' },
      ctx,
    )) as { blocked: boolean; preview: { projectedHealthFactor: number } };
    expect(result.blocked).toBe(true);
    expect(result.preview.projectedHealthFactor).toBeLessThan(1.1);
  });
});
