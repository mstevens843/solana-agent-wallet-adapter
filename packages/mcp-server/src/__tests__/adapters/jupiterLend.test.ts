import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JUPITER_ADAPTER_ID,
  jupiterAdapter,
  resetJupiterLendClientFactory,
  setJupiterLendClientFactory,
  type JupiterLendBorrowHealthPreview,
  type JupiterLendBorrowPositionSnapshot,
  type JupiterLendBorrowVaultSnapshot,
  type JupiterLendBuildResult,
  type JupiterLendClient,
  type JupiterLendEarnEarningsSnapshot,
  type JupiterLendEarnPositionSnapshot,
  type JupiterLendEarnTokenSnapshot,
} from '../../adapters/jupiter/index.js';
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
const USDC_SHARE_MINT = '11111111111111111111111111111111';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeLendState {
  earnToken: JupiterLendEarnTokenSnapshot;
  earnPositions: JupiterLendEarnPositionSnapshot[];
  earnEarnings: JupiterLendEarnEarningsSnapshot[];
  borrowVault: JupiterLendBorrowVaultSnapshot;
  borrowPositions: JupiterLendBorrowPositionSnapshot[];
  healthPreviewOverride?: Partial<JupiterLendBorrowHealthPreview>;
  buildCalls: string[];
  healthCalls: number;
}

function fakeState(overrides: Partial<FakeLendState> = {}): FakeLendState {
  return {
    earnToken: {
      assetMint: USDC_MINT,
      shareMint: USDC_SHARE_MINT,
      tokenSymbol: 'USDC',
      decimals: 6,
      shareDecimals: 6,
      apy: 5.2,
      rewardApy: 0.3,
      exchangePrice: '1.02',
      availableLiquidity: '1000000',
      active: true,
      asOf: '2026-05-12T00:00:00.000Z',
    },
    earnPositions: [
      {
        assetMint: USDC_MINT,
        shareMint: USDC_SHARE_MINT,
        tokenSymbol: 'USDC',
        decimals: 6,
        shareDecimals: 6,
        shares: '5',
        sharesRaw: '5000000',
        underlyingAmount: '5.1',
        underlyingAmountRaw: '5100000',
        apy: 5.2,
      },
    ],
    earnEarnings: [
      {
        assetMint: USDC_MINT,
        walletAddress: WALLET,
        totalEarnings: '0.12',
        decimals: 6,
      },
    ],
    borrowVault: {
      vaultId: 7,
      vaultAddress: 'VAULT11111111111111111111111111111111',
      supplyMint: SOL_MINT,
      borrowMint: USDC_MINT,
      supplySymbol: 'SOL',
      borrowSymbol: 'USDC',
      supplyDecimals: 9,
      borrowDecimals: 6,
      ltvBps: 7500,
      liquidationThresholdBps: 8500,
      liquidationPenaltyBps: 500,
      borrowApr: 9.2,
      supplyApy: 2.1,
      active: true,
      asOf: '2026-05-12T00:00:00.000Z',
    },
    borrowPositions: [
      {
        vaultId: 7,
        vaultAddress: 'VAULT11111111111111111111111111111111',
        positionId: 1,
        positionAddress: 'POSITION1111111111111111111111111111',
        owner: WALLET,
        collateralAmount: '1',
        collateralAmountRaw: '1000000000',
        debtAmount: '50',
        debtAmountRaw: '50000000',
        healthRatio: 2.4,
        healthRatioText: '2.4',
        liquidationStatus: 'safe',
        ltvBps: 5000,
        liquidationThresholdBps: 8500,
      },
    ],
    buildCalls: [],
    healthCalls: 0,
    ...overrides,
  };
}

function buildFakeLendClient(state: FakeLendState): JupiterLendClient {
  return {
    async getEarnTokens(): Promise<JupiterLendEarnTokenSnapshot[]> {
      return [state.earnToken];
    },
    async getEarnTokenDetail(): Promise<JupiterLendEarnTokenSnapshot> {
      return state.earnToken;
    },
    async getEarnPositions(): Promise<JupiterLendEarnPositionSnapshot[]> {
      return state.earnPositions;
    },
    async getEarnEarnings(): Promise<JupiterLendEarnEarningsSnapshot[]> {
      return state.earnEarnings;
    },
    async getBorrowVaults(): Promise<JupiterLendBorrowVaultSnapshot[]> {
      return [state.borrowVault];
    },
    async getBorrowVaultDetail(): Promise<JupiterLendBorrowVaultSnapshot> {
      return state.borrowVault;
    },
    async getBorrowPositions(): Promise<JupiterLendBorrowPositionSnapshot[]> {
      return state.borrowPositions;
    },
    async previewBorrowHealth(input): Promise<JupiterLendBorrowHealthPreview> {
      state.healthCalls += 1;
      const base: JupiterLendBorrowHealthPreview = {
        vaultId: input.vaultId,
        vaultAddress: state.borrowVault.vaultAddress,
        ...(input.positionId !== undefined ? { positionId: input.positionId } : {}),
        walletAddress: input.walletAddress,
        ...(input.collateralDelta !== undefined ? { collateralDelta: input.collateralDelta } : {}),
        ...(input.debtDelta !== undefined ? { debtDelta: input.debtDelta } : {}),
        before: {
          collateralAmount: '1',
          debtAmount: '50',
          healthRatio: 2.4,
          healthRatioText: '2.4',
          liquidationStatus: 'safe',
        },
        after: {
          collateralAmount: '1',
          debtAmount: '60',
          healthRatio: 2.0,
          healthRatioText: '2.0',
          liquidationStatus: 'safe',
        },
        minHealthRatio: input.minHealthRatio,
        blocked: false,
        warnings: [],
        simulatedAt: '2026-05-12T00:00:00.000Z',
      };
      return { ...base, ...state.healthPreviewOverride };
    },
    async buildEarnDeposit(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`earn_deposit:${args.amount}`);
      return {
        transactionBase64: Buffer.from('earn-deposit-tx').toString('base64'),
        refreshAtExecution: false,
      };
    },
    async buildEarnWithdraw(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`earn_withdraw:${args.amount}`);
      return {
        transactionBase64: Buffer.from('earn-withdraw-tx').toString('base64'),
        refreshAtExecution: true,
      };
    },
    async buildEarnMint(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`earn_mint:${args.shares}`);
      return { transactionBase64: Buffer.from('earn-mint-tx').toString('base64'), refreshAtExecution: false };
    },
    async buildEarnRedeem(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`earn_redeem:${args.shares}`);
      return { transactionBase64: Buffer.from('earn-redeem-tx').toString('base64'), refreshAtExecution: true };
    },
    async buildBorrowCreatePosition(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`borrow_create:${args.vaultId}`);
      return {
        transactionBase64: Buffer.from('borrow-create-tx').toString('base64'),
        refreshAtExecution: true,
      };
    },
    async buildBorrowDepositCollateral(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`borrow_dep:${args.amount}`);
      return {
        transactionBase64: Buffer.from('borrow-dep-tx').toString('base64'),
        refreshAtExecution: false,
      };
    },
    async buildBorrowBorrow(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`borrow_borrow:${args.amount}`);
      return {
        transactionBase64: Buffer.from('borrow-borrow-tx').toString('base64'),
        refreshAtExecution: true,
      };
    },
    async buildBorrowRepay(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`borrow_repay:${args.amount}${args.repayAll ? ':all' : ''}`);
      return {
        transactionBase64: Buffer.from('borrow-repay-tx').toString('base64'),
        refreshAtExecution: false,
      };
    },
    async buildBorrowWithdrawCollateral(args): Promise<JupiterLendBuildResult> {
      state.buildCalls.push(`borrow_withdraw:${args.amount}`);
      return {
        transactionBase64: Buffer.from('borrow-withdraw-tx').toString('base64'),
        refreshAtExecution: true,
      };
    },
  };
}

function fakeConfig(): AgentWalletConfig {
  return {
    cluster: 'mainnet-beta',
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
    connectors: {
      jupiter: {
        minBorrowHealthRatio: 1.25,
        maxBorrowLtvBps: 8500,
        useSdk: true,
      },
    },
  } as unknown as AgentWalletConfig;
}

function makeContext(opts: {
  store: PreparedActionStore;
  signed?: (transactionBase64: string, summary: string) => Promise<string>;
}): DAppAdapterContext {
  const signAndBroadcast = opts.signed ?? (async () => 'jupiter-lend-txid');
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(),
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: signAndBroadcast,
    signAndBroadcast,
    signMessage: async () => 'signed-message',
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

function requireJupiterAction(id: string) {
  const action = jupiterAdapter.actions[id];
  if (!action) throw new Error(`Jupiter adapter is missing action ${id}.`);
  return action;
}

afterEach(() => {
  resetJupiterLendClientFactory();
});

describe('Jupiter lend adapter shape', () => {
  it('registers with jupiter id, mainnet gating, and the documented lend actions/reads', () => {
    expect(jupiterAdapter.id).toBe(JUPITER_ADAPTER_ID);
    expect(jupiterAdapter.supportedClusters).toEqual(['mainnet-beta']);
    const actionIds = new Set(Object.keys(jupiterAdapter.actions));
    for (const id of [
      'borrow_borrow',
      'borrow_create_position',
      'borrow_deposit_collateral',
      'borrow_repay',
      'borrow_withdraw_collateral',
      'earn_deposit',
      'earn_mint',
      'earn_redeem',
      'earn_withdraw',
    ]) {
      expect(actionIds.has(id)).toBe(true);
    }
    const readIds = new Set(Object.keys(jupiterAdapter.reads));
    for (const id of [
      'borrow_health_preview',
      'borrow_positions',
      'borrow_vault_detail',
      'borrow_vaults',
      'earn_earnings',
      'earn_positions',
      'earn_token_detail',
      'earn_tokens',
    ]) {
      expect(readIds.has(id)).toBe(true);
    }
  });

  it('is discoverable via the adapter registry by action kind', () => {
    expect(requireAdapter('jupiter').id).toBe('jupiter');
    expect(adapterForActionKind('jupiter_lend_earn_deposit')?.id).toBe('jupiter');
    expect(actionForKind('jupiter_lend_borrow_borrow')?.action.id).toBe('borrow_borrow');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(jupiterAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(jupiterAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Jupiter lend prepare and execute', () => {
  let state: FakeLendState;

  beforeEach(() => {
    state = fakeState();
    setJupiterLendClientFactory(() => buildFakeLendClient(state));
  });

  it('earn deposit prepare records snapshot, raw amount, and refresh metadata', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('earn_deposit').prepare(
      { assetMint: USDC_MINT, amount: '5' },
      ctx,
    );

    expect(result.addInput.kind).toBe('jupiter_lend_earn_deposit');
    expect(result.addInput.summary).toBe('Deposit 5 USDC into Jupiter Earn');
    expect(result.addInput.params).toMatchObject({
      adapter: 'jupiter',
      connectorId: 'jupiter',
      product: 'lend',
      operation: 'earn_deposit',
      assetMint: USDC_MINT,
      amount: '5',
      amountRaw: '5000000',
      refreshAtExecution: false,
    });
  });

  it('borrow prepare runs health gate and blocks when projected health falls below policy', async () => {
    state.healthPreviewOverride = {
      after: {
        collateralAmount: '1',
        debtAmount: '70',
        healthRatio: 1.05,
        healthRatioText: '1.05',
        liquidationStatus: 'at_risk',
      },
      blocked: true,
      warnings: ['Projected health ratio below 1.25.'],
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireJupiterAction('borrow_borrow').prepare(
        { vaultId: 7, positionId: 1, amount: '20' },
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'health_check_failed',
    });
  });

  it('borrow execute rechecks health and signs the refreshed transaction', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ transactionBase64: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'jupiter-borrow-tx';
      },
    });

    const prepared = await requireJupiterAction('borrow_borrow').prepare(
      { vaultId: 7, positionId: 1, amount: '10' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);

    const result = await requireJupiterAction('borrow_borrow').execute(action, ctx);

    expect(result.txid).toBe('jupiter-borrow-tx');
    expect(state.healthCalls).toBe(2);
    expect(state.buildCalls).toContain('borrow_borrow:10');
    expect(signedCalls[0]?.transactionBase64).toBe(
      Buffer.from('borrow-borrow-tx').toString('base64'),
    );
    expect(signedCalls[0]?.summary).toBe('Borrow 10 USDC from Jupiter Borrow');
  });

  it('repay-all is stored as an explicit flag', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('borrow_repay').prepare(
      { vaultId: 7, positionId: 1, repayAll: true },
      ctx,
    );

    expect(result.addInput.kind).toBe('jupiter_lend_borrow_repay');
    expect(result.addInput.params).toMatchObject({
      operation: 'borrow_repay',
      vaultId: 7,
      positionId: 1,
      repayAll: true,
    });
  });
});
