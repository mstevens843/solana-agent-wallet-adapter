import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MARGINFI_ADAPTER_ID,
  MARGINFI_SUPPORTED_CLUSTERS,
  marginfiAdapter,
} from '../../adapters/marginfi/index.js';
import {
  getMarginfiClient,
  resetMarginfiClientFactory,
  resetMarginfiSdkLoaderForTests,
  setMarginfiClientFactory,
  setMarginfiSdkLoaderForTests,
  type MarginfiAccountDetail,
  type MarginfiAccountSummary,
  type MarginfiBankSnapshot,
  type MarginfiBuildTransactionResult,
  type MarginfiClient,
  type MarginfiHealthComponents,
  type MarginfiHealthPreview,
  type MarginfiOperation,
} from '../../adapters/marginfi/client.js';
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
const MARGINFI_ACCOUNT = '11111111111111111111111111111111';
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

interface FakeMarginfiState {
  bank: MarginfiBankSnapshot;
  accounts: MarginfiAccountSummary[];
  detail: MarginfiAccountDetail;
  previewCalls: Array<{
    operation: MarginfiOperation;
    amount?: string;
    withdrawAll?: boolean;
    repayAll?: boolean;
    createAccountIfMissing?: boolean;
  }>;
  buildCalls: Array<{ operation: MarginfiOperation; amount?: string; withdrawAll?: boolean; repayAll?: boolean }>;
  previewOverride?: Partial<MarginfiHealthPreview>;
}

function buildFakeMarginfi(state: FakeMarginfiState): MarginfiClient {
  return {
    async getBankSnapshot() {
      return state.bank;
    },
    async getWalletAccounts() {
      return state.accounts;
    },
    async getAccountDetail() {
      return state.detail;
    },
    async previewHealth(_connection, input): Promise<MarginfiHealthPreview> {
      state.previewCalls.push({
        operation: input.operation,
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.withdrawAll ? { withdrawAll: true } : {}),
        ...(input.repayAll ? { repayAll: true } : {}),
        ...(input.createAccountIfMissing ? { createAccountIfMissing: true } : {}),
      });
      const amount = input.withdrawAll ? '5' : input.repayAll ? '2' : input.amount ?? '1';
      return {
        operation: input.operation,
        marginfiAccount: MARGINFI_ACCOUNT,
        bankAddress: state.bank.bankAddress,
        bankMint: state.bank.bankMint,
        tokenSymbol: state.bank.tokenSymbol,
        amount,
        amountRaw: rawAmount(amount, state.bank.decimals),
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
    async buildActionTransaction(_connection, input): Promise<MarginfiBuildTransactionResult> {
      state.buildCalls.push({
        operation: input.operation,
        ...(input.amount !== undefined && { amount: input.amount }),
        ...(input.withdrawAll ? { withdrawAll: true } : {}),
        ...(input.repayAll ? { repayAll: true } : {}),
      });
      const amount = input.withdrawAll ? '5' : input.repayAll ? '2' : input.amount ?? '1';
      return {
        transactionBase64: Buffer.from('marginfi-test-transaction').toString('base64'),
        marginfiAccount: MARGINFI_ACCOUNT,
        bankSnapshot: state.bank,
        amount,
        amountRaw: rawAmount(amount, state.bank.decimals),
      };
    },
  };
}

function fakeState(overrides: Partial<FakeMarginfiState> = {}): FakeMarginfiState {
  const health = healthyHealth();
  const bank: MarginfiBankSnapshot = {
    bankAddress: USDC_BANK,
    bankMint: USDC_MINT,
    tokenSymbol: 'USDC',
    decimals: 6,
    depositApy: 4.2,
    borrowApr: 7.1,
    utilization: 62,
    totalAssets: '1000000',
    totalLiabilities: '620000',
    depositCapacity: '500000',
    borrowCapacity: '300000',
    riskTier: 'collateral',
    operationalState: 'operational',
    lastUpdateSlot: 280_000_000,
  };
  const account: MarginfiAccountSummary = {
    marginfiAccount: MARGINFI_ACCOUNT,
    authority: WALLET,
    activeBalances: 1,
    health,
  };
  return {
    bank,
    accounts: [account],
    detail: {
      ...account,
      positions: [{
        bankAddress: USDC_BANK,
        bankMint: USDC_MINT,
        tokenSymbol: 'USDC',
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

function healthyHealth(): MarginfiHealthComponents {
  return {
    assets: '100',
    liabilities: '40',
    netValue: '60',
    healthRatio: 2.5,
    healthRatioText: '2.5',
    healthy: true,
  };
}

function blockedHealth(): MarginfiHealthComponents {
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
    connectors: { marginfi: { minHealthRatio: 1.1 } },
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
    signAndBroadcast: opts.signed ?? (async () => 'marginfi-test-txid'),
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
  resetMarginfiClientFactory();
  resetMarginfiSdkLoaderForTests();
});

function requireMarginfiAction(id: 'deposit' | 'withdraw' | 'borrow' | 'repay') {
  const action = marginfiAdapter.actions[id];
  if (!action) throw new Error(`MarginFi adapter is missing action ${id}.`);
  return action;
}

describe('MarginFi adapter shape', () => {
  it('registers with expected id, mainnet gating, actions, and reads', () => {
    expect(marginfiAdapter.id).toBe(MARGINFI_ADAPTER_ID);
    expect(marginfiAdapter.supportedClusters).toEqual(MARGINFI_SUPPORTED_CLUSTERS);
    expect(Object.keys(marginfiAdapter.actions)).toEqual(['deposit', 'withdraw', 'borrow', 'repay']);
    expect(Object.keys(marginfiAdapter.reads)).toEqual(['bank_snapshot', 'wallet_accounts', 'account_detail', 'health_preview']);
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('marginfi').id).toBe('marginfi');
    expect(adapterForActionKind('marginfi_deposit')?.id).toBe('marginfi');
    expect(actionForKind('marginfi_borrow')?.action.id).toBe('borrow');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(marginfiAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(marginfiAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('MarginFi prepare + execute', () => {
  let state: FakeMarginfiState;

  beforeEach(() => {
    state = fakeState();
    setMarginfiClientFactory(() => buildFakeMarginfi(state));
  });

  it('prepare enriches params with bank and health preview data', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMarginfiAction('deposit').prepare({ amount: '10', token: 'USDC' }, ctx);

    expect(result.addInput.kind).toBe('marginfi_deposit');
    expect(result.addInput.summary).toBe('Deposit 10 USDC to MarginFi');
    expect(result.addInput.params).toMatchObject({
      adapter: 'marginfi',
      connectorId: 'marginfi',
      operation: 'deposit',
      marginfiAccount: MARGINFI_ACCOUNT,
      bankAddress: USDC_BANK,
      bankMint: USDC_MINT,
      tokenSymbol: 'USDC',
      decimals: 6,
      amount: '10',
      amountRaw: '10000000',
      minHealthRatio: 1.1,
      refreshAtExecution: false,
    });
    expect(state.previewCalls).toEqual([{ operation: 'deposit', amount: '10' }]);
  });

  it('blocks borrow preparation when projected health is below policy', async () => {
    state.previewOverride = {
      after: blockedHealth(),
      blocked: true,
      warnings: ['Projected health ratio below policy.'],
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireMarginfiAction('borrow').prepare({ amount: '25', token: 'USDC' }, ctx),
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
        return 'marginfi-borrow-txid';
      },
    });
    const prepared = await requireMarginfiAction('borrow').prepare({ amount: '3', token: 'USDC' }, ctx);
    const action = await store.addAction(prepared.addInput);

    const result = await requireMarginfiAction('borrow').execute(action, ctx);

    expect(result.txid).toBe('marginfi-borrow-txid');
    expect(state.previewCalls).toEqual([
      { operation: 'borrow', amount: '3' },
      { operation: 'borrow', amount: '3' },
    ]);
    expect(state.buildCalls).toEqual([{ operation: 'borrow', amount: '3' }]);
    expect(signedCalls[0]).toMatchObject({
      transactionBase64: Buffer.from('marginfi-test-transaction').toString('base64'),
      summary: 'Borrow 3 USDC from MarginFi',
    });
  });

  it('stores repayAll intent as a bounded prepared action flag', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMarginfiAction('repay').prepare({ token: 'USDC', repayAll: true }, ctx);

    expect(result.addInput.kind).toBe('marginfi_repay');
    expect(result.addInput.params).toMatchObject({
      operation: 'repay',
      amount: '2',
      amountRaw: '2000000',
      repayAll: true,
    });
  });

  it("normalizes withdraw amount 'all' into withdrawAll before previewing", async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMarginfiAction('withdraw').prepare({ token: 'USDC', amount: 'all' }, ctx);

    expect(result.addInput.params).toMatchObject({
      operation: 'withdraw',
      amount: '5',
      amountRaw: '5000000',
      withdrawAll: true,
      refreshAtExecution: true,
    });
    expect(state.previewCalls).toEqual([{ operation: 'withdraw', withdrawAll: true }]);
  });

  it("rejects amount 'all' for deposit and borrow", async () => {
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireMarginfiAction('deposit').prepare({ token: 'USDC', amount: 'all' }, ctx),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'invalid_amount',
    });
    await expect(
      requireMarginfiAction('borrow').prepare({ token: 'USDC', amount: 'all' }, ctx),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'invalid_amount',
    });
    expect(state.previewCalls).toEqual([]);
  });

  it('forwards createAccountIfMissing through direct health preview reads', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const read = marginfiAdapter.reads.health_preview;
    if (!read) throw new Error('missing health preview read');

    await read.read({
      operation: 'deposit',
      token: 'USDC',
      amount: '1',
      createAccountIfMissing: true,
    }, ctx);

    expect(state.previewCalls).toEqual([{
      operation: 'deposit',
      amount: '1',
      createAccountIfMissing: true,
    }]);
  });

  it("normalizes repay health preview amount 'all' into repayAll", async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const read = marginfiAdapter.reads.health_preview;
    if (!read) throw new Error('missing health preview read');

    const preview = await read.read({
      operation: 'repay',
      token: 'USDC',
      amount: 'all',
    }, ctx) as MarginfiHealthPreview;

    expect(preview).toMatchObject({
      operation: 'repay',
      amount: '2',
      amountRaw: '2000000',
      repayAll: true,
    });
    expect(state.previewCalls).toEqual([{ operation: 'repay', repayAll: true }]);
  });
});

describe('MarginFi real client hardening', () => {
  it('returns a clean AdapterError when the SDK cannot be loaded', async () => {
    setMarginfiSdkLoaderForTests(async () => {
      throw new AdapterError(MARGINFI_ADAPTER_ID, 'sdk_unavailable', 'missing sdk');
    });
    const client = await getMarginfiClient(WALLET);

    await expect(
      client.getBankSnapshot(fakeConnection(), { token: 'USDC' }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'sdk_unavailable',
    });
  });

  it('validates decimal amounts before building SDK instructions', async () => {
    const sdk = installFakeMarginfiSdk();
    const client = await getMarginfiClient(WALLET);

    await expect(
      client.previewHealth(sdk.connection, {
        operation: 'borrow',
        walletAddress: WALLET,
        token: 'USDC',
        amount: '-1',
      }),
    ).rejects.toThrow(/positive decimal string/);
    expect(sdk.account.makeBorrowIx).not.toHaveBeenCalled();
  });

  it("resolves real-client withdraw amount 'all' from the current position", async () => {
    const sdk = installFakeMarginfiSdk();
    const client = await getMarginfiClient(WALLET);

    const preview = await client.previewHealth(sdk.connection, {
      operation: 'withdraw',
      walletAddress: WALLET,
      token: 'USDC',
      amount: 'all',
    });

    expect(preview).toMatchObject({
      operation: 'withdraw',
      amount: '5',
      amountRaw: '5000000',
      withdrawAll: true,
      blocked: false,
    });
    expect(sdk.account.makeWithdrawIx).toHaveBeenCalledWith('5', sdk.bank.address, true);
  });

  it('returns an explicit unsupported error for requested account creation', async () => {
    const sdk = installFakeMarginfiSdk({ accounts: [] });
    const client = await getMarginfiClient(WALLET);

    await expect(
      client.previewHealth(sdk.connection, {
        operation: 'deposit',
        walletAddress: WALLET,
        token: 'USDC',
        amount: '1',
        createAccountIfMissing: true,
      }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'create_account_not_supported',
    });
    expect(sdk.account.makeDepositIx).not.toHaveBeenCalled();
  });
});

function fakeConnection(): DAppAdapterContext['connection'] {
  return {
    rpcEndpoint: 'https://api.fake',
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    })),
  } as unknown as DAppAdapterContext['connection'];
}

function installFakeMarginfiSdk(options: { accounts?: Record<string, any>[] } = {}): {
  connection: DAppAdapterContext['connection'];
  account: Record<string, any>;
  bank: { address: PublicKey; mint: PublicKey; tokenSymbol: string; mintDecimals: number };
} {
  const bankAddress = new PublicKey(USDC_BANK);
  const bankMint = new PublicKey(USDC_MINT);
  const instruction = new TransactionInstruction({
    keys: [],
    programId: SystemProgram.programId,
    data: Buffer.alloc(0),
  });
  const bank = {
    address: bankAddress,
    mint: bankMint,
    tokenSymbol: 'USDC',
    mintDecimals: 6,
    computeInterestRates: vi.fn(() => ({ lendingRate: 0.04, borrowingRate: 0.07 })),
    computeUtilizationRate: vi.fn(() => 0.6),
    computeRemainingCapacity: vi.fn(() => ({ depositCapacity: '1000', borrowCapacity: '500' })),
    getTotalAssetQuantity: vi.fn(() => '1000'),
    getTotalLiabilityQuantity: vi.fn(() => '400'),
    config: {},
  };
  const balance = {
    bankPk: bankAddress,
    assetShares: '5',
    liabilityShares: '2',
    computeQuantityUi: vi.fn(() => ({ assets: '5', liabilities: '2' })),
    computeUsdValue: vi.fn(() => ({ assets: '5', liabilities: '2' })),
  };
  const account: Record<string, any> = {
    address: new PublicKey(MARGINFI_ACCOUNT),
    authority: new PublicKey(WALLET),
    activeBalances: [balance],
    computeHealthComponents: vi.fn(() => ({ assets: '100', liabilities: '40' })),
    simulateBorrowLendTransaction: vi.fn(async () => ({ marginfiAccount: account })),
    makeDepositIx: vi.fn(async () => ({ instructions: [instruction], keys: [] })),
    makeWithdrawIx: vi.fn(async () => ({ instructions: [instruction], keys: [] })),
    makeBorrowIx: vi.fn(async () => ({ instructions: [instruction], keys: [] })),
    makeRepayIx: vi.fn(async () => ({ instructions: [instruction], keys: [] })),
  };
  const sdkClient = {
    wallet: { publicKey: new PublicKey(WALLET) },
    getMarginfiAccountsForAuthority: vi.fn(async () => options.accounts ?? [account]),
    getBankByPk: vi.fn((address: PublicKey) => address.toBase58() === bankAddress.toBase58() ? bank : null),
    getBankByMint: vi.fn((mint: PublicKey) => mint.toBase58() === bankMint.toBase58() ? bank : null),
    getBankByTokenSymbol: vi.fn((token: string) => token.toUpperCase() === 'USDC' ? bank : null),
    getOraclePriceByBank: vi.fn(() => ({ priceRealtime: { price: '1' }, timestamp: '1700000000' })),
  };
  account.client = sdkClient;
  setMarginfiSdkLoaderForTests(async () => ({
    MarginfiClient: {
      fetch: vi.fn(async () => sdkClient),
    },
    MarginfiAccountWrapper: {
      fetch: vi.fn(async () => account),
    },
    MarginRequirementType: { Maintenance: 'maintenance' },
    getConfig: vi.fn(() => ({ environment: 'production' })),
  }));
  return {
    connection: fakeConnection(),
    account,
    bank,
  };
}

function rawAmount(amount: string, decimals: number): string {
  const [whole = '0', fractional = ''] = amount.trim().split('.');
  return `${whole}${fractional.padEnd(decimals, '0').slice(0, decimals)}`.replace(/^0+(?=\d)/, '') || '0';
}
