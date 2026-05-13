import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LULO_ADAPTER_ID,
  LULO_SUPPORTED_CLUSTERS,
  luloAdapter,
} from '../../adapters/lulo/index.js';
import {
  resetLuloClientFactory,
  setLuloClientFactory,
  redactLuloError,
  type LuloBalancesUnavailable,
  type LuloClient,
  type LuloPoolMetaSnapshot,
  type LuloPrepareCompleteWithdrawResult,
  type LuloPrepareDepositResult,
  type LuloPrepareWithdrawInput,
  type LuloPrepareWithdrawResult,
  type LuloRatesSnapshot,
  type LuloWalletBalancesSnapshot,
} from '../../adapters/lulo/client.js';
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

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

class FakeConnection {
  async getParsedAccountInfo(): Promise<{ value: { data: { parsed: { info: { decimals: number } } } } }> {
    return {
      value: {
        data: {
          parsed: {
            info: { decimals: 6 },
          },
        },
      },
    };
  }
}

interface FakeLuloState {
  rates: LuloRatesSnapshot;
  poolMeta: LuloPoolMetaSnapshot;
  balances: LuloWalletBalancesSnapshot | LuloBalancesUnavailable;
  depositCalls: Array<{ walletAddress: string; mintAddress: string; amountRaw: bigint; depositType: string }>;
  withdrawCalls: Array<LuloPrepareWithdrawInput>;
  completeCalls: Array<{ walletAddress: string; mintAddress: string; withdrawalId: string }>;
}

function buildFakeLulo(state: FakeLuloState): LuloClient {
  return {
    async getRates() {
      return state.rates;
    },
    async getPoolMeta() {
      return state.poolMeta;
    },
    async getWalletBalances() {
      return state.balances;
    },
    async generateDepositTransaction(input): Promise<LuloPrepareDepositResult> {
      state.depositCalls.push({
        walletAddress: input.walletAddress,
        mintAddress: input.mintAddress,
        amountRaw: input.amountRaw,
        depositType: input.depositType,
      });
      return {
        transactionBase64: 'AAAA-base64-deposit',
        programIds: ['LULO11111111111111111111111111111111111111'],
        ratesSnapshot: state.rates.rows[0],
        poolMetaSnapshot: state.poolMeta.pools[0],
      };
    },
    async generateWithdrawTransaction(input): Promise<LuloPrepareWithdrawResult> {
      state.withdrawCalls.push(input);
      return {
        transactionBase64: 'AAAA-base64-withdraw',
        programIds: ['LULO11111111111111111111111111111111111111'],
        ...(input.withdrawType === 'regular' ? { withdrawalId: 'wd_42', cooldownSeconds: 3600 } : {}),
      };
    },
    async generateCompleteWithdrawTransaction(input): Promise<LuloPrepareCompleteWithdrawResult> {
      state.completeCalls.push(input);
      return {
        transactionBase64: 'AAAA-base64-complete',
        programIds: ['LULO11111111111111111111111111111111111111'],
      };
    },
  };
}

function fakeRates(): LuloRatesSnapshot {
  return {
    rows: [
      {
        mintAddress: USDC_MINT,
        symbol: 'USDC',
        depositType: 'protected',
        apy: 5.2,
        tvlUsd: '120000000',
        liquidityAvailable: '5000000',
      },
    ],
    asOfIso: new Date().toISOString(),
    source: 'lulo-api',
  };
}

function fakePoolMeta(cooldownSeconds: number | undefined = undefined): LuloPoolMetaSnapshot {
  const base = {
    mintAddress: USDC_MINT,
    symbol: 'USDC',
    decimals: 6,
    supportedDepositTypes: ['protected', 'boost', 'regular'] as Array<'protected' | 'boost' | 'regular'>,
    programIds: ['LULO11111111111111111111111111111111111111'],
  };
  return {
    pools: [cooldownSeconds === undefined ? base : { ...base, cooldownSeconds }],
    asOfIso: new Date().toISOString(),
    source: 'lulo-api',
  };
}

function fakeBalances(): LuloWalletBalancesSnapshot {
  return {
    walletAddress: WALLET,
    rows: [
      {
        mintAddress: USDC_MINT,
        symbol: 'USDC',
        depositType: 'protected',
        amountUi: '125.5',
        earnedInterestUi: '1.25',
        apy: 5.2,
        withdrawableUi: '125.5',
      },
    ],
    asOfIso: new Date().toISOString(),
    source: 'lulo-api',
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
    connection: new FakeConnection() as unknown as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForLuloTests111111111111111'),
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
  resetLuloClientFactory();
});

function requireLuloAction(id: 'deposit' | 'withdraw' | 'complete_withdraw') {
  const action = luloAdapter.actions[id];
  if (!action) throw new Error(`Lulo adapter is missing action ${id}.`);
  return action;
}

describe('Lulo adapter shape', () => {
  it('registers with expected id, mainnet gating, and three actions', () => {
    expect(luloAdapter.id).toBe(LULO_ADAPTER_ID);
    expect(luloAdapter.supportedClusters).toEqual(LULO_SUPPORTED_CLUSTERS);
    expect(Object.keys(luloAdapter.actions).sort()).toEqual(['complete_withdraw', 'deposit', 'withdraw']);
    expect(luloAdapter.reads.rates).toBeDefined();
    expect(luloAdapter.reads.pool_meta).toBeDefined();
    expect(luloAdapter.reads.wallet_balances).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('lulo').id).toBe('lulo');
    expect(adapterForActionKind('lulo_deposit')?.id).toBe('lulo');
    expect(adapterForActionKind('lulo_withdraw')?.id).toBe('lulo');
    expect(adapterForActionKind('lulo_complete_withdraw')?.id).toBe('lulo');
    expect(actionForKind('lulo_withdraw')?.action.id).toBe('withdraw');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(luloAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(luloAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Lulo deposit prepare + execute', () => {
  let state: FakeLuloState;

  beforeEach(() => {
    state = {
      rates: fakeRates(),
      poolMeta: fakePoolMeta(),
      balances: fakeBalances(),
      depositCalls: [],
      withdrawCalls: [],
      completeCalls: [],
    };
    setLuloClientFactory(() => buildFakeLulo(state));
  });

  it('prepare snapshots params (mint, amountRaw, depositType, supplyApy, refreshAtExecution)', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireLuloAction('deposit').prepare(
      { amount: '10', mintAddress: USDC_MINT, depositType: 'protected' },
      ctx,
    );
    expect(result.addInput.kind).toBe('lulo_deposit');
    expect(result.addInput.summary).toContain('Deposit 10');
    expect(result.addInput.params).toMatchObject({
      adapter: 'lulo',
      connectorId: 'lulo',
      action: 'deposit',
      mintAddress: USDC_MINT,
      decimals: 6,
      amount: '10',
      amountRaw: (10_000_000n).toString(),
      depositType: 'protected',
      supplyApy: 5.2,
      refreshAtExecution: true,
    });
  });

  it('execute calls signAndBroadcast with a fresh transaction and returns a txid', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string; tx: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ summary, tx });
        return 'broadcasted-txid-for-lulo-deposit';
      },
    });
    const prepared = await requireLuloAction('deposit').prepare(
      { amount: '5', mintAddress: USDC_MINT, depositType: 'boost' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireLuloAction('deposit').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-txid-for-lulo-deposit');
    expect(signedCalls[0]?.tx).toBe('AAAA-base64-deposit');
    expect(state.depositCalls).toHaveLength(1);
    expect(state.depositCalls[0]).toMatchObject({
      walletAddress: WALLET,
      mintAddress: USDC_MINT,
      amountRaw: 5_000_000n,
      depositType: 'boost',
    });
  });
});

describe('Lulo withdraw prepare', () => {
  let state: FakeLuloState;

  beforeEach(() => {
    state = {
      rates: fakeRates(),
      poolMeta: fakePoolMeta(3600),
      balances: fakeBalances(),
      depositCalls: [],
      withdrawCalls: [],
      completeCalls: [],
    };
    setLuloClientFactory(() => buildFakeLulo(state));
  });

  it('records percentage withdraw and surfaces cooldown warning copy for regular', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireLuloAction('withdraw').prepare(
      { mintAddress: USDC_MINT, withdrawType: 'regular', percentage: 50 },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      withdrawType: 'regular',
      percentage: 50,
      cooldownSeconds: 3600,
    });
    expect(result.addInput.params.cooldownWarning).toMatch(/Regular withdrawals are two-step/);
  });

  it('rejects when both amount and percentage are supplied', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireLuloAction('withdraw').prepare(
        { mintAddress: USDC_MINT, amount: '5', percentage: 50 },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('defaults to percentage 100 when neither amount nor percentage is supplied', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireLuloAction('withdraw').prepare(
      { mintAddress: USDC_MINT, withdrawType: 'protected' },
      ctx,
    );
    expect(result.addInput.params.percentage).toBe(100);
  });
});

describe('Lulo complete withdraw', () => {
  let state: FakeLuloState;

  beforeEach(() => {
    state = {
      rates: fakeRates(),
      poolMeta: fakePoolMeta(),
      balances: fakeBalances(),
      depositCalls: [],
      withdrawCalls: [],
      completeCalls: [],
    };
    setLuloClientFactory(() => buildFakeLulo(state));
  });

  it('rejects missing withdrawalId', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireLuloAction('complete_withdraw').prepare(
        { mintAddress: USDC_MINT, withdrawalId: '' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('snapshots params and calls API at execute', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireLuloAction('complete_withdraw').prepare(
      { mintAddress: USDC_MINT, withdrawalId: 'wd_42' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireLuloAction('complete_withdraw').execute(action, ctx);
    expect(result.txid).toBeDefined();
    expect(state.completeCalls).toHaveLength(1);
    expect(state.completeCalls[0]).toMatchObject({
      walletAddress: WALLET,
      mintAddress: USDC_MINT,
      withdrawalId: 'wd_42',
    });
  });
});

describe('Lulo API key redaction', () => {
  it('strips an api key from error messages via redactLuloError', () => {
    const apiKey = 'super-secret-key-abcdef-123456';
    const original = new Error(`Lulo rejected request: x-api-key=${apiKey} expired`);
    const wrapped = redactLuloError(original, apiKey);
    expect(wrapped.message).not.toContain(apiKey);
    expect(wrapped.message).toContain('***');
    expect((wrapped as Error & { cause?: unknown }).cause).toBe(original);
  });

  it('still redacts header-style key matches even when the literal key is missing', () => {
    const wrapped = redactLuloError(new Error('Headers: x-api-key="abcdef-1234"'), 'unused');
    expect(wrapped.message).not.toContain('abcdef-1234');
    expect(wrapped.message).toContain('***');
  });

  it('does not re-wrap an already-redacted error (idempotent)', () => {
    const apiKey = 'key-zzz';
    const once = redactLuloError(new Error(`oops ${apiKey}`), apiKey);
    const twice = redactLuloError(once, apiKey);
    expect(twice).toBe(once);
  });
});

describe('Lulo balances unavailable', () => {
  it('surfaces a balances_unavailable fact-style payload without throwing', async () => {
    setLuloClientFactory(() => buildFakeLulo({
      rates: fakeRates(),
      poolMeta: fakePoolMeta(),
      balances: { balances_unavailable: true, reason: 'Lulo API does not currently expose balances for this wallet (404).' },
      depositCalls: [],
      withdrawCalls: [],
      completeCalls: [],
    }));
    const ctx = makeContext({ store: inMemoryStore() });
    const read = luloAdapter.reads.wallet_balances;
    if (!read) throw new Error('wallet_balances read missing');
    const result = await read.read({}, ctx);
    expect(result).toMatchObject({
      balances_unavailable: true,
      reason: expect.stringContaining('balances'),
    });
  });
});

describe('Lulo unknown mint decimals', () => {
  it('throws AdapterError when on-chain decimals cannot be resolved and API has no hint', async () => {
    setLuloClientFactory(() => buildFakeLulo({
      rates: { rows: [], asOfIso: new Date().toISOString(), source: 'lulo-api' },
      poolMeta: { pools: [], asOfIso: new Date().toISOString(), source: 'lulo-api' },
      balances: { walletAddress: WALLET, rows: [], asOfIso: new Date().toISOString(), source: 'lulo-api' },
      depositCalls: [],
      withdrawCalls: [],
      completeCalls: [],
    }));
    const store = inMemoryStore();
    const ctx: DAppAdapterContext = {
      backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
      config: fakeConfig('mainnet-beta'),
      connection: {
        async getParsedAccountInfo() {
          return { value: null };
        },
      } as unknown as DAppAdapterContext['connection'],
      signAndBroadcast: async () => 'unused',
      signTransaction: async () => "signed-base64-placeholder",
      signMessage: async () => "signature-base64-placeholder",
      store,
    };
    await expect(
      requireLuloAction('deposit').prepare(
        { amount: '1', mintAddress: USDC_MINT },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});
