import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DRIFT_ADAPTER_ID,
  DRIFT_SUPPORTED_CLUSTERS,
  driftAdapter,
} from '../../adapters/drift/index.js';
import {
  resetDriftVaultClientFactory,
  setDriftVaultClientFactory,
  type DriftBuildVaultCancelWithdrawResult,
  type DriftBuildVaultCompleteWithdrawResult,
  type DriftBuildVaultDepositResult,
  type DriftBuildVaultRequestWithdrawResult,
  type DriftUserSnapshot,
  type DriftVaultClient,
  type DriftVaultDepositor,
  type DriftVaultSnapshot,
  type DriftWithdrawStatus,
} from '../../adapters/drift/client.js';
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
const VAULT = '5MULTbBV6pZdoRjEEznTPCh1RDp8RnXcuKAEd5kk6BgF';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeDriftState {
  vaultSnapshot: DriftVaultSnapshot;
  userSnapshot: DriftUserSnapshot;
  positions: DriftVaultDepositor[];
  withdrawStatus: DriftWithdrawStatus;
  depositCalls: Array<{ walletAddress: string; vaultAddress: string; amountRaw: bigint; initializeDepositorIfMissing?: boolean }>;
  requestWithdrawCalls: Array<{
    walletAddress: string;
    vaultAddress: string;
    withdrawUnit: 'token' | 'shares';
    amountRaw?: bigint;
    sharesRaw?: bigint;
  }>;
  cancelWithdrawCalls: Array<{ walletAddress: string; vaultAddress: string }>;
  completeWithdrawCalls: Array<{ walletAddress: string; vaultAddress: string }>;
}

function buildFakeDrift(state: FakeDriftState): DriftVaultClient {
  return {
    async getUserSnapshot(): Promise<DriftUserSnapshot> {
      return state.userSnapshot;
    },
    async getVaultSnapshot(): Promise<DriftVaultSnapshot> {
      return state.vaultSnapshot;
    },
    async getWalletVaultPositions(_connection, _wallet, vaultAddress) {
      return vaultAddress
        ? state.positions.filter((entry) => entry.vaultAddress === vaultAddress)
        : [...state.positions];
    },
    async getWithdrawStatus(): Promise<DriftWithdrawStatus> {
      return state.withdrawStatus;
    },
    async buildVaultDepositTransaction(_connection, input): Promise<DriftBuildVaultDepositResult> {
      state.depositCalls.push(input);
      return {
        transactionBase64: 'BASE64_DEPOSIT_PLACEHOLDER',
        vaultAddress: state.vaultSnapshot.vaultAddress,
        vaultName: state.vaultSnapshot.name,
        depositMint: state.vaultSnapshot.depositMint,
        depositSymbol: state.vaultSnapshot.depositSymbol ?? 'USDC',
        decimals: state.vaultSnapshot.decimals,
        amountUi: (Number(input.amountRaw) / 10 ** state.vaultSnapshot.decimals).toString(),
        initializedDepositor: input.initializeDepositorIfMissing === true && state.positions.length === 0,
        summarySnapshot: state.vaultSnapshot,
      };
    },
    async buildVaultRequestWithdrawTransaction(_connection, input): Promise<DriftBuildVaultRequestWithdrawResult> {
      state.requestWithdrawCalls.push(input);
      return {
        transactionBase64: 'BASE64_REQUEST_WITHDRAW_PLACEHOLDER',
        vaultAddress: state.vaultSnapshot.vaultAddress,
        vaultName: state.vaultSnapshot.name,
        depositMint: state.vaultSnapshot.depositMint,
        depositSymbol: state.vaultSnapshot.depositSymbol ?? 'USDC',
        decimals: state.vaultSnapshot.decimals,
        ...(input.amountRaw
          ? { amountUi: (Number(input.amountRaw) / 10 ** state.vaultSnapshot.decimals).toString() }
          : {}),
        ...(input.sharesRaw
          ? { sharesUi: (Number(input.sharesRaw) / 10 ** state.vaultSnapshot.decimals).toString() }
          : {}),
        redeemableAt: Math.floor(Date.now() / 1000) + state.vaultSnapshot.redeemPeriodSec,
        summarySnapshot: state.vaultSnapshot,
      };
    },
    async buildVaultCancelWithdrawTransaction(_connection, input): Promise<DriftBuildVaultCancelWithdrawResult> {
      state.cancelWithdrawCalls.push(input);
      return {
        transactionBase64: 'BASE64_CANCEL_PLACEHOLDER',
        vaultAddress: state.vaultSnapshot.vaultAddress,
        vaultName: state.vaultSnapshot.name,
        cancelledShares: state.withdrawStatus.requestedShares,
        summarySnapshot: state.vaultSnapshot,
      };
    },
    async buildVaultCompleteWithdrawTransaction(_connection, input): Promise<DriftBuildVaultCompleteWithdrawResult> {
      state.completeWithdrawCalls.push(input);
      return {
        transactionBase64: 'BASE64_COMPLETE_PLACEHOLDER',
        vaultAddress: state.vaultSnapshot.vaultAddress,
        vaultName: state.vaultSnapshot.name,
        redeemedShares: state.withdrawStatus.requestedShares,
        redeemedAmountUi: state.withdrawStatus.requestedValue,
        summarySnapshot: state.vaultSnapshot,
      };
    },
  };
}

function fakeVaultSnapshot(overrides: Partial<DriftVaultSnapshot> = {}): DriftVaultSnapshot {
  return {
    vaultAddress: VAULT,
    name: 'JLP Delta Neutral',
    manager: 'MnGr1234567890abcdefghijklmnopqrstuvwxyzABCD',
    programId: 'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR',
    depositMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    depositSymbol: 'USDC',
    decimals: 6,
    totalShares: '1000000',
    totalValue: '1050000',
    sharePrice: '1.05',
    redeemPeriodSec: 60 * 60 * 24 * 7,
    lockupSec: 0,
    profitShareBps: 1500,
    managementFeeBps: 200,
    pendingWithdrawShares: '0',
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeUserSnapshot(): DriftUserSnapshot {
  return {
    walletAddress: WALLET,
    subAccountId: 0,
    userAccountAddress: 'USerAcct123456789012345678901234567890abCDe',
    deposits: [
      { marketIndex: 0, mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', amount: '1.5' },
    ],
    borrows: [],
    totalCollateral: '210',
    freeCollateral: '210',
    marginRatio: 1,
    asOfSlot: 280_000_000,
  };
}

function fakeDepositor(overrides: Partial<DriftVaultDepositor> = {}): DriftVaultDepositor {
  return {
    vaultAddress: VAULT,
    walletAddress: WALLET,
    depositorAddress: 'DpStRdEpoSiTor1234567890abcdefghijklmnopqrst',
    shares: '100',
    valueAtSharePrice: '105',
    pendingWithdrawShares: '0',
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeWithdrawStatus(overrides: Partial<DriftWithdrawStatus> = {}): DriftWithdrawStatus {
  return {
    vaultAddress: VAULT,
    walletAddress: WALLET,
    hasPendingRequest: false,
    requestedShares: '0',
    isReady: false,
    redeemPeriodSec: 60 * 60 * 24 * 7,
    lockupSec: 0,
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
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: opts.signed ?? (async () => 'TxidPlaceholderForDriftTests1111111111111111'),
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
  resetDriftVaultClientFactory();
});

function requireDriftAction(
  id:
    | 'vault_deposit'
    | 'vault_request_withdraw'
    | 'vault_cancel_withdraw'
    | 'vault_complete_withdraw',
) {
  const action = driftAdapter.actions[id];
  if (!action) throw new Error(`Drift adapter is missing action ${id}.`);
  return action;
}

describe('Drift adapter shape', () => {
  it('registers with expected id, mainnet gating, and four vault actions', () => {
    expect(driftAdapter.id).toBe(DRIFT_ADAPTER_ID);
    expect(driftAdapter.supportedClusters).toEqual(DRIFT_SUPPORTED_CLUSTERS);
    expect(Object.keys(driftAdapter.actions).sort()).toEqual([
      'vault_cancel_withdraw',
      'vault_complete_withdraw',
      'vault_deposit',
      'vault_request_withdraw',
    ]);
    expect(driftAdapter.reads.user_snapshot).toBeDefined();
    expect(driftAdapter.reads.vault_snapshot).toBeDefined();
    expect(driftAdapter.reads.wallet_vault_positions).toBeDefined();
    expect(driftAdapter.reads.withdraw_status).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('drift').id).toBe('drift');
    expect(adapterForActionKind('drift_vault_deposit')?.id).toBe('drift');
    expect(actionForKind('drift_vault_request_withdraw')?.action.id).toBe('vault_request_withdraw');
    expect(actionForKind('drift_vault_cancel_withdraw')?.action.id).toBe('vault_cancel_withdraw');
    expect(actionForKind('drift_vault_complete_withdraw')?.action.id).toBe('vault_complete_withdraw');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(driftAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(driftAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Drift vault deposit prepare + execute', () => {
  let fakeState: FakeDriftState;

  beforeEach(() => {
    fakeState = {
      vaultSnapshot: fakeVaultSnapshot(),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor()],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
  });

  it('prepare enriches params with vault facts and stores a drift_vault_deposit action', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_deposit').prepare(
      { vaultAddress: VAULT, amount: '25' },
      ctx,
    );
    expect(result.addInput.kind).toBe('drift_vault_deposit');
    expect(result.addInput.summary).toBe('Deposit 25 USDC into Drift vault JLP Delta Neutral');
    expect(result.addInput.params).toMatchObject({
      adapter: 'drift',
      vaultAddress: VAULT,
      depositMint: fakeState.vaultSnapshot.depositMint,
      depositSymbol: 'USDC',
      decimals: 6,
      amount: '25',
      amountRaw: (25_000_000n).toString(),
      sharePrice: '1.05',
      depositorExists: true,
      refreshAtExecution: true,
    });
  });

  it('rejects deposit when vault depositor account is missing and opt-in not set', async () => {
    fakeState.positions = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_deposit').prepare(
        { vaultAddress: VAULT, amount: '25' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('accepts deposit when depositor missing and initializeDepositorIfMissing is true', async () => {
    fakeState.positions = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_deposit').prepare(
      { vaultAddress: VAULT, amount: '10', initializeDepositorIfMissing: true },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      depositorExists: false,
      initializeDepositorIfMissing: true,
    });
  });

  it('rejects deposit when mint differs from vault deposit mint', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_deposit').prepare(
        { vaultAddress: VAULT, amount: '25', mint: 'So11111111111111111111111111111111111111112' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects deposit with invalid vault address', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_deposit').prepare(
        { vaultAddress: 'not-a-pubkey', amount: '25' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('execute calls signAndBroadcast with the rebuilt transaction and returns a txid', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ summary: string; transactionBase64: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (transactionBase64, summary) => {
        signedCalls.push({ transactionBase64, summary });
        return 'broadcasted-drift-deposit';
      },
    });
    const prepared = await requireDriftAction('vault_deposit').prepare(
      { vaultAddress: VAULT, amount: '10' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireDriftAction('vault_deposit').execute(action, ctx);
    expect(result.txid).toBe('broadcasted-drift-deposit');
    expect(signedCalls[0]?.transactionBase64).toBe('BASE64_DEPOSIT_PLACEHOLDER');
    expect(signedCalls[0]?.summary).toContain('Drift vault');
    expect(fakeState.depositCalls).toHaveLength(1);
    expect(fakeState.depositCalls[0]?.amountRaw).toBe(10_000_000n);
  });
});

describe('Drift vault request withdraw prepare', () => {
  let fakeState: FakeDriftState;

  beforeEach(() => {
    fakeState = {
      vaultSnapshot: fakeVaultSnapshot(),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor({ shares: '100', valueAtSharePrice: '105' })],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
  });

  it('rejects when wallet has no shares to withdraw', async () => {
    fakeState.positions = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_request_withdraw').prepare(
        { vaultAddress: VAULT, amount: '5' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when a pending withdraw request already exists', async () => {
    fakeState.positions = [fakeDepositor({ shares: '100', valueAtSharePrice: '105', pendingWithdrawShares: '40' })];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_request_withdraw').prepare(
        { vaultAddress: VAULT, amount: '5' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('supports withdrawUnit: shares with explicit shares input', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_request_withdraw').prepare(
      { vaultAddress: VAULT, shares: '50', withdrawUnit: 'shares' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      withdrawUnit: 'shares',
      shares: '50',
      sharesRaw: (50_000_000n).toString(),
    });
    expect(typeof result.addInput.params.redeemableAt).toBe('string');
  });

  it('supports withdrawUnit: token (default) with amount input', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_request_withdraw').prepare(
      { vaultAddress: VAULT, amount: '10' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      withdrawUnit: 'token',
      amount: '10',
      amountRaw: (10_000_000n).toString(),
    });
  });

  it('rejects when token amount exceeds position value', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_request_withdraw').prepare(
        { vaultAddress: VAULT, amount: '500' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when shares exceed position shares', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_request_withdraw').prepare(
        { vaultAddress: VAULT, shares: '500', withdrawUnit: 'shares' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Drift vault cancel withdraw', () => {
  let fakeState: FakeDriftState;

  beforeEach(() => {
    fakeState = {
      vaultSnapshot: fakeVaultSnapshot(),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor()],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
  });

  it('rejects cancel when no pending request exists', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_cancel_withdraw').prepare({ vaultAddress: VAULT }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares cancel when a pending request exists', async () => {
    fakeState.withdrawStatus = fakeWithdrawStatus({
      hasPendingRequest: true,
      requestedShares: '25',
      requestedAt: Math.floor(Date.now() / 1000),
      redeemableAt: Math.floor(Date.now() / 1000) + 60 * 60,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_cancel_withdraw').prepare(
      { vaultAddress: VAULT },
      ctx,
    );
    expect(result.addInput.kind).toBe('drift_vault_cancel_withdraw');
    expect(result.addInput.params).toMatchObject({ pendingShares: '25' });
  });
});

describe('Drift vault complete withdraw', () => {
  let fakeState: FakeDriftState;

  beforeEach(() => {
    fakeState = {
      vaultSnapshot: fakeVaultSnapshot(),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor()],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
  });

  it('rejects complete before redeem period elapses', async () => {
    fakeState.withdrawStatus = fakeWithdrawStatus({
      hasPendingRequest: true,
      requestedShares: '25',
      isReady: false,
      redeemableAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_complete_withdraw').prepare({ vaultAddress: VAULT }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects complete when no pending request exists', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_complete_withdraw').prepare({ vaultAddress: VAULT }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares complete once redeem period elapsed and request is ready', async () => {
    fakeState.withdrawStatus = fakeWithdrawStatus({
      hasPendingRequest: true,
      requestedShares: '25',
      requestedValue: '26.25',
      isReady: true,
      redeemableAt: Math.floor(Date.now() / 1000) - 60,
    });
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireDriftAction('vault_complete_withdraw').prepare(
      { vaultAddress: VAULT },
      ctx,
    );
    expect(result.addInput.kind).toBe('drift_vault_complete_withdraw');
    expect(result.addInput.params).toMatchObject({ redeemableShares: '25' });
  });
});

describe('Drift adapter SDK unavailable', () => {
  it('throws a clear error if no factory is wired and a prepare runs', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_deposit').prepare(
        { vaultAddress: VAULT, amount: '5' },
        ctx,
      ),
    ).rejects.toThrowError(/Drift adapter is not configured/);
  });
});

describe('Drift vault program guard', () => {
  it('rejects prepare when vault snapshot reports a non-canonical program id', async () => {
    const fakeState: FakeDriftState = {
      vaultSnapshot: fakeVaultSnapshot({ programId: 'ImpostorProgram111111111111111111111111111' }),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor()],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requireDriftAction('vault_deposit').prepare({ vaultAddress: VAULT, amount: '5' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Drift wallet vault positions read returns facts', () => {
  it('includes per-vault facts and totals', async () => {
    const fakeState: FakeDriftState = {
      vaultSnapshot: fakeVaultSnapshot(),
      userSnapshot: fakeUserSnapshot(),
      positions: [fakeDepositor({ shares: '40', valueAtSharePrice: '42', pendingWithdrawShares: '0' })],
      withdrawStatus: fakeWithdrawStatus(),
      depositCalls: [],
      requestWithdrawCalls: [],
      cancelWithdrawCalls: [],
      completeWithdrawCalls: [],
    };
    setDriftVaultClientFactory(() => buildFakeDrift(fakeState));
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = driftAdapter.reads.wallet_vault_positions;
    if (!read) throw new Error('wallet_vault_positions read missing');
    const result = (await read.read({}, ctx)) as Record<string, unknown> & {
      facts: Record<string, unknown>;
    };
    expect(result.facts).toMatchObject({
      walletAddress: WALLET,
      vaultCount: 1,
      pendingWithdrawCount: 0,
      totalShares: '40',
      totalValue: '42',
    });
    expect(Array.isArray((result.facts as { vaults: unknown[] }).vaults)).toBe(true);
  });
});
