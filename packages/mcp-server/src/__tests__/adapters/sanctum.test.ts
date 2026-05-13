import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SANCTUM_ADAPTER_ID,
  SANCTUM_SUPPORTED_CLUSTERS,
  sanctumAdapter,
} from '../../adapters/sanctum/index.js';
import {
  SANCTUM_INF_MINT,
  WSOL_MINT,
} from '../../adapters/sanctum/constants.js';
import {
  resetSanctumClientFactory,
  setSanctumClientFactory,
  type SanctumClient,
  type SanctumLstListSnapshot,
  type SanctumLstMetadata,
  type SanctumTokenOrder,
  type SanctumTokenOrderInput,
} from '../../adapters/sanctum/client.js';
import {
  AdapterError,
  actionForKind,
  adapterForActionKind,
  assertSupportedCluster,
  requireAdapter,
} from '../../adapters/index.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type { AgentWalletConfig } from '../../config.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const MSOL_MINT = 'mSoLzYCxHDKzzFk9eCF7tLLqPN1UgLApYH3p3p5x8kL';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeSanctumState {
  lsts: SanctumLstMetadata[];
  orderCalls: SanctumTokenOrderInput[];
  executeCalls: Array<{ signedTx: string; orderResponse: Record<string, unknown> }>;
  routeSources: string[];
  outputAmountRaw: string;
  maxObservedFeeBps?: number;
  warnings: string[];
  transactionBase64?: string;
}

function buildFakeSanctum(state: FakeSanctumState): SanctumClient {
  return {
    async getLsts(input): Promise<SanctumLstListSnapshot> {
      return {
        rows: input.includeDisabled ? state.lsts : state.lsts.filter((row) => row.enabled),
        includeDisabled: Boolean(input.includeDisabled),
        asOfIso: new Date().toISOString(),
        apiBaseHost: 'sanctum-api.ironforge.network',
        source: 'sanctum-api',
      };
    },
    async getLst(input) {
      const key = input.mintOrSymbol.toLowerCase();
      const row = state.lsts.find((candidate) =>
        candidate.mint.toLowerCase() === key || candidate.symbol.toLowerCase() === key,
      );
      if (!row) throw new Error(`No fake Sanctum LST for ${input.mintOrSymbol}`);
      return {
        ...row,
        ...(input.includeApy ? { apys: [{ epoch: 1, apy: row.apy ?? 6.1 }] } : {}),
      };
    },
    async getTokenOrder(input) {
      state.orderCalls.push(input);
      return fakeOrder(input, state);
    },
    async executeTokenOrder(input) {
      state.executeCalls.push(input);
      return {
        signature: 'sanctum-signature-111111111111111111111111111',
        raw: { ok: true },
      };
    },
  };
}

function fakeOrder(input: SanctumTokenOrderInput, state: FakeSanctumState): SanctumTokenOrder {
  const routeSources = state.routeSources.length > 0 ? state.routeSources : input.swapSources ?? ['Inf'];
  return {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputAmountRaw: input.amountRaw,
    outputAmountRaw: state.outputAmountRaw,
    mode: input.mode ?? 'ExactIn',
    routeSources,
    requestedSources: input.swapSources ?? [],
    ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
    ...(state.maxObservedFeeBps !== undefined && { maxObservedFeeBps: state.maxObservedFeeBps }),
    transactionBase64: state.transactionBase64 ?? 'unsigned-sanctum-tx-base64',
    hasTransaction: true,
    warnings: state.warnings,
    asOfIso: new Date().toISOString(),
    apiBaseHost: 'sanctum-api.ironforge.network',
    orderResponse: {
      routeSources,
      quoteId: `quote-${state.orderCalls.length}`,
      ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
    },
  };
}

function fakeLsts(): SanctumLstMetadata[] {
  return [
    {
      mint: JITOSOL_MINT,
      symbol: 'JitoSOL',
      name: 'Jito Staked SOL',
      decimals: 9,
      enabled: true,
      apy: 7.2,
    },
    {
      mint: MSOL_MINT,
      symbol: 'mSOL',
      name: 'Marinade staked SOL',
      decimals: 9,
      enabled: true,
      apy: 6.4,
    },
    {
      mint: 'bSo13r4TkiE4LzH6B4TuJgTyK2q2H4LVHJK3hQfBvR2',
      symbol: 'bSOL',
      name: 'Disabled fake bSOL',
      decimals: 9,
      enabled: false,
    },
  ];
}

function fakeState(overrides: Partial<FakeSanctumState> = {}): FakeSanctumState {
  return {
    lsts: fakeLsts(),
    orderCalls: [],
    executeCalls: [],
    routeSources: ['Inf', 'SanctumRouter'],
    outputAmountRaw: '950000000',
    maxObservedFeeBps: 25,
    warnings: [],
    transactionBase64: 'unsigned-sanctum-tx-base64',
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
    signAndBroadcast: async () => 'unused-for-sanctum-tests',
    signTransaction: opts.signed ?? (async () => 'signed-sanctum-tx-base64'),
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
  resetSanctumClientFactory();
});

function requireSanctumAction(
  id: 'swap_lst' | 'add_infinity_liquidity' | 'remove_infinity_liquidity' | 'stake_sol_to_lst' | 'unstake_lst_to_sol',
) {
  const action = sanctumAdapter.actions[id];
  if (!action) throw new Error(`Sanctum adapter is missing action ${id}.`);
  return action;
}

describe('Sanctum adapter shape', () => {
  it('registers with expected id, mainnet gating, reads, and actions', () => {
    expect(sanctumAdapter.id).toBe(SANCTUM_ADAPTER_ID);
    expect(sanctumAdapter.supportedClusters).toEqual(SANCTUM_SUPPORTED_CLUSTERS);
    expect(Object.keys(sanctumAdapter.actions).sort()).toEqual([
      'add_infinity_liquidity',
      'remove_infinity_liquidity',
      'stake_sol_to_lst',
      'swap_lst',
      'unstake_lst_to_sol',
    ]);
    expect(Object.keys(sanctumAdapter.reads).sort()).toEqual([
      'infinity_pool_snapshot',
      'lst_list',
      'lst_snapshot',
      'quote',
      'wallet_positions',
    ]);
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('sanctum').id).toBe('sanctum');
    expect(adapterForActionKind('sanctum_swap_lst')?.id).toBe('sanctum');
    expect(adapterForActionKind('sanctum_add_infinity_liquidity')?.id).toBe('sanctum');
    expect(adapterForActionKind('sanctum_unstake_lst_to_sol')?.id).toBe('sanctum');
    expect(actionForKind('sanctum_swap_lst')?.action.id).toBe('swap_lst');
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(sanctumAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(sanctumAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Sanctum reads', () => {
  it('filters disabled LST rows by default', async () => {
    const state = fakeState();
    setSanctumClientFactory(() => buildFakeSanctum(state));
    const ctx = makeContext({ store: inMemoryStore() });
    const snapshot = await sanctumAdapter.reads.lst_list?.read({}, ctx) as SanctumLstListSnapshot;
    expect(snapshot.rows.map((row) => row.symbol)).toEqual(['JitoSOL', 'mSOL']);
    const withDisabled = await sanctumAdapter.reads.lst_list?.read({ includeDisabled: true }, ctx) as SanctumLstListSnapshot;
    expect(withDisabled.rows.map((row) => row.symbol)).toContain('bSOL');
  });
});

describe('Sanctum prepare + execute', () => {
  let state: FakeSanctumState;

  beforeEach(() => {
    state = fakeState();
    setSanctumClientFactory(() => buildFakeSanctum(state));
  });

  it('prepare snapshots Infinity liquidity params without persisting the unsigned transaction', async () => {
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireSanctumAction('add_infinity_liquidity').prepare(
      {
        inputMint: JITOSOL_MINT,
        amount: '1',
        minInfAmount: '0.9',
      },
      ctx,
    );
    expect(result.addInput.kind).toBe('sanctum_add_infinity_liquidity');
    expect(result.addInput.summary).toContain('Add 1 JitoSOL');
    expect(result.addInput.params).toMatchObject({
      adapter: 'sanctum',
      connectorId: 'sanctum',
      action: 'add_infinity_liquidity',
      inputMint: JITOSOL_MINT,
      outputMint: SANCTUM_INF_MINT,
      inputSymbol: 'JitoSOL',
      outputSymbol: 'INF',
      inputAmountRaw: '1000000000',
      minOutputAmountRaw: '900000000',
      requestedSources: ['Inf'],
      routeSources: ['Inf', 'SanctumRouter'],
      refreshAtExecution: true,
    });
    expect(result.addInput.params.quoteSnapshot).toMatchObject({
      hasTransaction: true,
      outputAmountRaw: '950000000',
    });
    expect(JSON.stringify(result.addInput.params.quoteSnapshot)).not.toContain('unsigned-sanctum-tx-base64');
  });

  it('execute refreshes the order, signs transaction bytes, and submits through Sanctum execute', async () => {
    state.outputAmountRaw = '1900000000';
    const store = inMemoryStore();
    const signedCalls: Array<{ tx: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ tx, summary });
        return 'signed-by-wallet-base64';
      },
    });
    const prepared = await requireSanctumAction('swap_lst').prepare(
      {
        inputMint: JITOSOL_MINT,
        outputMint: MSOL_MINT,
        amount: '2',
        minOutputAmount: '1.8',
      },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireSanctumAction('swap_lst').execute(action, ctx);
    expect(result.txid).toBe('sanctum-signature-111111111111111111111111111');
    expect(state.orderCalls).toHaveLength(2);
    expect(state.orderCalls[1]).toMatchObject({
      inputMint: JITOSOL_MINT,
      outputMint: MSOL_MINT,
      amountRaw: '2000000000',
      signer: WALLET,
      swapSources: ['Inf', 'SanctumRouter'],
    });
    expect(signedCalls[0]).toMatchObject({
      tx: 'unsigned-sanctum-tx-base64',
      summary: 'Swap 2 JitoSOL to mSOL through Sanctum',
    });
    expect(state.executeCalls[0]).toMatchObject({
      signedTx: 'signed-by-wallet-base64',
    });
  });

  it('rejects Jupiter route sources', async () => {
    state.routeSources = ['Jupiter'];
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSanctumAction('swap_lst').prepare(
        {
          inputMint: JITOSOL_MINT,
          outputMint: MSOL_MINT,
          amount: '1',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects delayed unstake routes unless the caller explicitly allows them', async () => {
    state.routeSources = ['Inf'];
    state.warnings = ['Route requires delayed unstake'];
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireSanctumAction('unstake_lst_to_sol').prepare(
        {
          lstMint: JITOSOL_MINT,
          lstAmount: '1',
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);

    const allowed = await requireSanctumAction('unstake_lst_to_sol').prepare(
      {
        lstMint: JITOSOL_MINT,
        lstAmount: '1',
        allowDelayedUnstake: true,
      },
      ctx,
    );
    expect(allowed.addInput.kind).toBe('sanctum_unstake_lst_to_sol');
    expect(allowed.addInput.params).toMatchObject({
      inputMint: JITOSOL_MINT,
      outputMint: WSOL_MINT,
      allowDelayedUnstake: true,
    });
  });
});
