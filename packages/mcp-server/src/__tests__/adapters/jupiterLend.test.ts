import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JUPITER_ADAPTER_ID,
  jupiterAdapter,
  loadJupiterLendEarnSdkForSmokeTest,
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
  earnDetailRequests: string[];
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
    earnDetailRequests: [],
    healthCalls: 0,
    ...overrides,
  };
}

function buildFakeLendClient(state: FakeLendState): JupiterLendClient {
  return {
    async getEarnTokens(): Promise<JupiterLendEarnTokenSnapshot[]> {
      return [state.earnToken];
    },
    async getEarnTokenDetail(input): Promise<JupiterLendEarnTokenSnapshot> {
      state.earnDetailRequests.push(input.assetMint);
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
  config?: AgentWalletConfig;
}): DAppAdapterContext {
  const signAndBroadcast = opts.signed ?? (async () => 'jupiter-lend-txid');
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: opts.config ?? fakeConfig(),
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

  it('normalizes SOL earn deposits to the WSOL mint before token lookup', async () => {
    state.earnToken = {
      ...state.earnToken,
      assetMint: SOL_MINT,
      tokenSymbol: 'SOL',
      decimals: 9,
      shareDecimals: 9,
    };
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('earn_deposit').prepare(
      { assetMint: 'SOL', amount: '0.01' },
      ctx,
    );

    expect(state.earnDetailRequests).toEqual([SOL_MINT]);
    expect(result.addInput.params).toMatchObject({
      assetMint: SOL_MINT,
      amountRaw: '10000000',
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

  it('earn deposit stores programIds, minSharesOut, and earnSnapshot', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('earn_deposit').prepare(
      { assetMint: USDC_MINT, amount: '5', minSharesOut: '4.9' },
      ctx,
    );

    expect(result.addInput.params).toMatchObject({
      minSharesOut: '4.9',
      programIds: expect.arrayContaining([
        'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9',
      ]),
      earnSnapshot: expect.objectContaining({ assetMint: USDC_MINT }),
    });
  });

  it('earn withdraw surfaces withdrawal-smoothing warning when enabled', async () => {
    state.earnToken = {
      ...state.earnToken,
      withdrawalSmoothing: { enabled: true, note: 'Smoothing applies for 30 minutes.' },
    };
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('earn_withdraw').prepare(
      { assetMint: USDC_MINT, amount: '5', minUnderlyingOut: '4.95' },
      ctx,
    );

    expect(result.addInput.params).toMatchObject({
      operation: 'earn_withdraw',
      minUnderlyingOut: '4.95',
      refreshAtExecution: true,
      warnings: ['Smoothing applies for 30 minutes.'],
    });
  });

  it('borrow prepare stores positionSnapshot, oracleSnapshot, programIds, and vaultSnapshot', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireJupiterAction('borrow_borrow').prepare(
      { vaultId: 7, positionId: 1, amount: '10' },
      ctx,
    );

    expect(result.addInput.params).toMatchObject({
      vaultId: 7,
      positionId: 1,
      vaultSnapshot: expect.objectContaining({ vaultId: 7 }),
      positionSnapshot: expect.objectContaining({ positionId: 1, owner: WALLET }),
      programIds: expect.arrayContaining([
        'jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi',
      ]),
      refreshAtExecution: true,
    });
  });

  it('rejects unknown liquidation status even without preview.blocked', async () => {
    state.healthPreviewOverride = {
      after: {
        collateralAmount: '1',
        debtAmount: '60',
        healthRatio: 1.4,
        healthRatioText: '1.4',
        liquidationStatus: 'unknown',
      },
      blocked: false,
      warnings: [],
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireJupiterAction('borrow_borrow').prepare(
        { vaultId: 7, positionId: 1, amount: '5' },
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'health_check_failed',
    });
  });

  it('rejects borrow when oracle is unavailable', async () => {
    state.borrowVault = {
      ...state.borrowVault,
      oracle: { available: false, warnings: ['Oracle is down.'] },
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireJupiterAction('borrow_borrow').prepare(
        { vaultId: 7, positionId: 1, amount: '5' },
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'stale_oracle',
    });
  });

  it('rejects borrow when oracle is stale beyond maxStalenessSeconds', async () => {
    const stalePublishedAt = new Date(Date.now() - 600_000).toISOString();
    state.borrowVault = {
      ...state.borrowVault,
      oracle: {
        available: true,
        publishedAt: stalePublishedAt,
        maxStalenessSeconds: 60,
      },
    };
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireJupiterAction('borrow_borrow').prepare(
        { vaultId: 7, positionId: 1, amount: '5' },
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'stale_oracle',
    });
  });

  it('rejects execute when position ownership changed after prepare', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const prepared = await requireJupiterAction('borrow_repay').prepare(
      { vaultId: 7, positionId: 1, amount: '1' },
      ctx,
    );
    const action = await ctx.store.addAction(prepared.addInput);

    state.borrowPositions = state.borrowPositions.map((position) => ({
      ...position,
      owner: 'OtherWalletAddress1111111111111111111111111',
    }));

    await expect(
      requireJupiterAction('borrow_repay').execute(action, ctx),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'position_not_owned',
    });
  });

  it('execute refresh blocks health regression before signing', async () => {
    const store = inMemoryStore();
    const signedCalls: string[] = [];
    const ctx = makeContext({
      store,
      signed: async () => {
        signedCalls.push('signed');
        return 'should-not-be-called';
      },
    });

    const prepared = await requireJupiterAction('borrow_borrow').prepare(
      { vaultId: 7, positionId: 1, amount: '5' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);

    state.healthPreviewOverride = {
      after: {
        collateralAmount: '1',
        debtAmount: '90',
        healthRatio: 0.9,
        healthRatioText: '0.9',
        liquidationStatus: 'at_risk',
      },
      blocked: true,
      warnings: ['Projected health drops below policy after a market move.'],
    };

    await expect(
      requireJupiterAction('borrow_borrow').execute(action, ctx),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'health_check_failed',
    });
    expect(signedCalls).toEqual([]);
  });
});

describe('Jupiter lend SDK unavailability', () => {
  beforeEach(() => {
    resetJupiterLendClientFactory();
  });

  it('default factory throws sdk_unavailable from borrow paths', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireJupiterAction('borrow_borrow').prepare(
        { vaultId: 7, positionId: 1, amount: '5' },
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'sdk_unavailable' });
  });
});

describe('Jupiter lend Earn SDK wiring', () => {
  it('imports the Earn instruction builders used by approval preparation', async () => {
    const sdk = await loadJupiterLendEarnSdkForSmokeTest();
    expect(typeof sdk.getDepositIxs).toBe('function');
    expect(typeof sdk.getWithdrawIxs).toBe('function');
    expect(typeof sdk.getMintIxs).toBe('function');
    expect(typeof sdk.getRedeemIxs).toBe('function');
    expect(typeof sdk.BN).toBe('function');
  });
});

describe('Jupiter lend REST behaviour', () => {
  let originalApiKey: string | undefined;
  let originalJupKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.JUPITER_API_KEY;
    originalJupKey = process.env.JUP_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.JUPITER_API_KEY;
    else process.env.JUPITER_API_KEY = originalApiKey;
    if (originalJupKey === undefined) delete process.env.JUP_API_KEY;
    else process.env.JUP_API_KEY = originalJupKey;
  });

  it('missing API key rejects REST Earn reads with unauthorized', async () => {
    delete process.env.JUPITER_API_KEY;
    delete process.env.JUP_API_KEY;
    const { listEarnTokens } = await import('../../adapters/jupiter/lendEarn.js');
    const config = restConfig({ useSdk: false });

    await expect(listEarnTokens(config, WALLET, {})).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'unauthorized',
    });
  });

  it('redacts API key in REST error bodies', async () => {
    process.env.JUPITER_API_KEY = 'sk-jupiter-supersecret';
    const { listEarnTokens } = await import('../../adapters/jupiter/lendEarn.js');
    const config = restConfig({ useSdk: false });
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'rejected',
          headers: { 'x-api-key': 'sk-jupiter-supersecret' },
          transaction: 'A'.repeat(200),
        }),
        { status: 401 },
      );

    // Patch global fetch for jupiterFetchJson default consumer
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(listEarnTokens(config, WALLET, {})).rejects.toMatchObject({
        message: expect.stringContaining('[redacted]'),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports non-JSON REST failures clearly when REST mode is forced', async () => {
    process.env.JUPITER_API_KEY = 'sk-jupiter-supersecret';
    const config = restConfig({ useSdk: false });
    const fetchImpl: typeof fetch = async () =>
      new Response('<html>service unavailable</html>', { status: 503 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await expect(
        requireJupiterAction('earn_deposit').prepare(
          { assetMint: SOL_MINT, amount: '0.01' },
          makeContext({ config, store: inMemoryStore() }),
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('Jupiter API returned non-JSON response'),
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

function restConfig(overrides: { useSdk?: boolean } = {}): AgentWalletConfig {
  const base = fakeConfig();
  return {
    ...base,
    jupiter: {
      ...base.jupiter,
      lendBaseUrl: 'https://api.jup.ag/lend/v1',
    },
    connectors: {
      ...base.connectors,
      jupiter: {
        ...base.connectors?.jupiter,
        useSdk: overrides.useSdk ?? false,
      },
    },
  } as AgentWalletConfig;
}
