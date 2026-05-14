import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROJECT0_ADAPTER_ID,
  PROJECT0_SUPPORTED_CLUSTERS,
  project0Adapter,
} from '../../adapters/project0/index.js';
import {
  resetProject0ClientFactory,
  setProject0ClientFactory,
  type Project0AccountDetail,
  type Project0Bank,
  type Project0BuildTransactionResult,
  type Project0Client,
  type Project0HealthComponents,
  type Project0HealthPreview,
  type Project0Operation,
  type Project0Strategy,
  type Project0WalletSnapshot,
} from '../../adapters/project0/client.js';
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
const PROJECT0_ACCOUNT = '11111111111111111111111111111111';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BANK = '9xQeWvG816bUx9EPfzywVzQJSPYkF1f1P9Gm2Zx8xQeW';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeProject0State {
  bank: Project0Bank;
  strategies: Project0Strategy[];
  wallet: Project0WalletSnapshot;
  account: Project0AccountDetail;
  previewCalls: Array<{
    operation: 'create_account' | Project0Operation;
    amount?: string;
    withdrawAll?: boolean;
    repayAll?: boolean;
    minHealthRatio?: number;
    accountIndex?: number;
  }>;
  buildCalls: Array<{ operation: 'create_account' | Project0Operation; amount?: string; withdrawAll?: boolean; repayAll?: boolean }>;
  previewOverride?: Partial<Project0HealthPreview>;
}

function buildFakeProject0(state: FakeProject0State): Project0Client {
  return {
    async listBanks(input = {}) {
      if (input.token && input.token.toLowerCase() !== state.bank.symbol.toLowerCase()) return [];
      if (input.bankAddress && input.bankAddress !== state.bank.bankAddress) return [];
      if (input.bankMint && input.bankMint !== state.bank.mint) return [];
      return [state.bank];
    },
    async listStrategies() {
      return state.strategies;
    },
    async getWallet() {
      return state.wallet;
    },
    async getAccountDetail() {
      return state.account;
    },
    async previewHealth(_connection, input): Promise<Project0HealthPreview> {
      state.previewCalls.push({
        operation: input.operation,
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.withdrawAll ? { withdrawAll: true } : {}),
        ...(input.repayAll ? { repayAll: true } : {}),
        ...(input.minHealthRatio !== undefined && { minHealthRatio: input.minHealthRatio }),
        ...(input.accountIndex !== undefined && { accountIndex: input.accountIndex }),
      });
      if (input.operation === 'create_account') {
        return {
          operation: 'create_account',
          accountIndex: input.accountIndex ?? 0,
          minHealthRatio: input.minHealthRatio ?? 1.1,
          blocked: false,
          warnings: [],
          simulatedAt: '2026-05-12T00:00:00.000Z',
          ...state.previewOverride,
        };
      }
      const amount = input.withdrawAll ? '5' : input.repayAll ? '2' : input.amount ?? '1';
      return {
        operation: input.operation,
        project0Account: PROJECT0_ACCOUNT,
        bankAddress: state.bank.bankAddress,
        bankMint: state.bank.mint,
        tokenSymbol: state.bank.symbol,
        venue: state.bank.venue,
        amount,
        amountRaw: rawAmount(amount, state.bank.mintDecimals),
        ...(input.withdrawAll ? { withdrawAll: true } : {}),
        ...(input.repayAll ? { repayAll: true } : {}),
        before: healthyHealth(),
        after: healthyHealth(),
        minHealthRatio: input.minHealthRatio ?? 1.1,
        blocked: false,
        warnings: [],
        simulatedAt: '2026-05-12T00:00:00.000Z',
        ...state.previewOverride,
      };
    },
    async buildActionTransaction(_connection, input): Promise<Project0BuildTransactionResult> {
      state.buildCalls.push({
        operation: input.operation,
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.withdrawAll ? { withdrawAll: true } : {}),
        ...(input.repayAll ? { repayAll: true } : {}),
      });
      if (input.operation === 'create_account') {
        return {
          transactionsBase64: [Buffer.from('project0-create-account').toString('base64')],
          accountIndex: input.accountIndex ?? 0,
        };
      }
      const amount = input.withdrawAll ? '5' : input.repayAll ? '2' : input.amount ?? '1';
      return {
        transactionsBase64: [Buffer.from('project0-test-transaction').toString('base64')],
        project0Account: PROJECT0_ACCOUNT,
        bank: state.bank,
        amount,
        amountRaw: rawAmount(amount, state.bank.mintDecimals),
      };
    },
  };
}

function fakeState(overrides: Partial<FakeProject0State> = {}): FakeProject0State {
  const bank: Project0Bank = {
    bankAddress: USDC_BANK,
    mint: USDC_MINT,
    symbol: 'USDC',
    mintDecimals: 6,
    venue: 'P0',
    depositApy: 4.2,
    borrowApy: 7.1,
    usdPrice: 1,
  };
  return {
    bank,
    strategies: [{
      heading: 'USDC loop',
      primaryBankAddress: USDC_BANK,
      apy: 8.4,
    }],
    wallet: {
      wallet: WALLET,
      totalUsdValue: 25,
      tokens: [{ address: USDC_MINT, symbol: 'USDC', decimals: 6, balance: '25', usdValue: 25 }],
    },
    account: {
      project0Account: PROJECT0_ACCOUNT,
      authority: WALLET,
      activeBalances: 1,
      health: healthyHealth(),
      positions: [{
        bankAddress: USDC_BANK,
        bankMint: USDC_MINT,
        tokenSymbol: 'USDC',
        venue: 'P0',
        decimals: 6,
        suppliedAmount: '5',
        borrowedAmount: '2',
        suppliedUsd: '5',
        borrowedUsd: '2',
      }],
    },
    previewCalls: [],
    buildCalls: [],
    ...overrides,
  };
}

function healthyHealth(): Project0HealthComponents {
  return {
    assets: '100',
    liabilities: '40',
    netValue: '60',
    healthRatio: 2.5,
    healthRatioText: '2.5',
    healthy: true,
  };
}

function blockedHealth(): Project0HealthComponents {
  return {
    assets: '100',
    liabilities: '98',
    netValue: '2',
    healthRatio: 1.02,
    healthRatioText: '1.02',
    healthy: true,
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
    connectors: { project0: { minHealthRatio: 1.1, apiBaseUrl: 'https://ai.0.xyz' } },
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
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'project0-test-txid'),
    signTransaction: async () => 'signed-base64-placeholder',
    signMessage: async () => 'signature-base64-placeholder',
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
  resetProject0ClientFactory();
});

function requireProject0Action(id: 'create_account' | 'deposit' | 'withdraw' | 'borrow' | 'repay') {
  const action = project0Adapter.actions[id];
  if (!action) throw new Error(`Project 0 adapter is missing action ${id}.`);
  return action;
}

describe('Project 0 adapter shape', () => {
  it('registers with expected id, mainnet gating, actions, and reads', () => {
    expect(project0Adapter.id).toBe(PROJECT0_ADAPTER_ID);
    expect(project0Adapter.supportedClusters).toEqual(PROJECT0_SUPPORTED_CLUSTERS);
    expect(Object.keys(project0Adapter.actions)).toEqual(['create_account', 'deposit', 'withdraw', 'borrow', 'repay']);
    expect(Object.keys(project0Adapter.reads)).toEqual(['banks', 'strategies', 'wallet', 'account_detail', 'health_preview']);
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('project0').id).toBe('project0');
    expect(adapterForActionKind('project0_deposit')?.id).toBe('project0');
    expect(actionForKind('project0_borrow')?.action.id).toBe('borrow');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(project0Adapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(project0Adapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Project 0 prepare + execute', () => {
  let state: FakeProject0State;

  beforeEach(() => {
    state = fakeState();
    setProject0ClientFactory(() => buildFakeProject0(state));
  });

  it('prepare enriches params with bank and health preview data', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireProject0Action('deposit').prepare({ amount: '10', token: 'USDC', minHealthRatio: 1.2 }, ctx);

    expect(result.addInput.kind).toBe('project0_deposit');
    expect(result.addInput.summary).toBe('Deposit 10 USDC to Project 0');
    expect(result.addInput.params).toMatchObject({
      adapter: 'project0',
      connectorId: 'project0',
      operation: 'deposit',
      project0Account: PROJECT0_ACCOUNT,
      bankAddress: USDC_BANK,
      bankMint: USDC_MINT,
      tokenSymbol: 'USDC',
      amount: '10',
      amountRaw: '10000000',
      minHealthRatio: 1.2,
      refreshAtExecution: false,
    });
    expect(state.previewCalls).toEqual([{ operation: 'deposit', amount: '10', minHealthRatio: 1.2 }]);
  });

  it('prepares Project 0 account creation as a wallet approval item', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireProject0Action('create_account').prepare({ accountIndex: 2 }, ctx);

    expect(result.addInput.kind).toBe('project0_create_account');
    expect(result.addInput.summary).toBe('Create Project 0 account #2');
    expect(result.addInput.params).toMatchObject({
      adapter: 'project0',
      operation: 'create_account',
      accountIndex: 2,
    });
  });

  it('blocks borrow preparation when projected health is below policy', async () => {
    state.previewOverride = {
      after: blockedHealth(),
      blocked: true,
      warnings: ['Projected health ratio below policy.'],
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireProject0Action('borrow').prepare({ amount: '25', token: 'USDC' }, ctx),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'health_check_failed',
    });
  });

  it('execute rechecks borrow health and signs the rebuilt transaction', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ transactionBase64: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'project0-borrow-txid';
      },
    });
    const prepared = await requireProject0Action('borrow').prepare({ amount: '3', token: 'USDC' }, ctx);
    const action = await store.addAction(prepared.addInput);

    const result = await requireProject0Action('borrow').execute(action, ctx);

    expect(result.txid).toBe('project0-borrow-txid');
    expect(state.previewCalls).toEqual([
      { operation: 'borrow', amount: '3', minHealthRatio: 1.1 },
      { operation: 'borrow', amount: '3', minHealthRatio: 1.1 },
    ]);
    expect(state.buildCalls).toEqual([{ operation: 'borrow', amount: '3' }]);
    expect(signedCalls[0]).toMatchObject({
      transactionBase64: Buffer.from('project0-test-transaction').toString('base64'),
      summary: 'Borrow 3 USDC from Project 0',
    });
  });

  it("normalizes repay amount 'all' into repayAll before previewing", async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireProject0Action('repay').prepare({ token: 'USDC', amount: 'all' }, ctx);

    expect(result.addInput.params).toMatchObject({
      operation: 'repay',
      amount: '2',
      amountRaw: '2000000',
      repayAll: true,
    });
    expect(state.previewCalls).toEqual([{ operation: 'repay', repayAll: true, minHealthRatio: 1.1 }]);
  });
});

function rawAmount(amount: string, decimals: number): string {
  return String(BigInt(Math.round(Number(amount) * 10 ** decimals)));
}
