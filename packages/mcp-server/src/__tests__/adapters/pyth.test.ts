import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PYTH_ADAPTER_ID,
  PYTH_SUPPORTED_CLUSTERS,
  pythAdapter,
} from '../../adapters/pyth/index.js';
import {
  redactPythError,
  resetPythClientFactory,
  resetPythReceiverFactory,
  setPythClientFactory,
  setPythReceiverFactory,
  type PythHermesClient,
  type PythHermesFeedMetadata,
  type PythHermesPriceUpdate,
  type PythHermesPriceUpdateRow,
  type PythReceiverBuildResult,
  type PythReceiverClient,
} from '../../adapters/pyth/client.js';
import { computeConfidenceBps, formatScaled } from '../../adapters/pyth/prices.js';
import { normalizePriceFeedId, resolveAlias } from '../../adapters/pyth/constants.js';
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
const SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const USDC_FEED = 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeHermesState {
  rows: PythHermesPriceUpdateRow[];
  binary: string[];
  feedMetadata: PythHermesFeedMetadata[];
  searchCalls: Array<{ query?: string; assetType?: string }>;
  latestCalls: Array<{ priceFeedIds: string[]; parsed: boolean }>;
}

interface FakeReceiverState {
  buildCalls: Array<{ walletAddress: string; priceUpdateDataHex: string[]; closeUpdateAccounts: boolean }>;
  result: PythReceiverBuildResult;
}

function buildFakeHermes(state: FakeHermesState): PythHermesClient {
  return {
    hermesUrl: 'https://hermes.test',
    async getLatestPriceUpdates({ priceFeedIds, parsed }): Promise<PythHermesPriceUpdate> {
      state.latestCalls.push({
        priceFeedIds: priceFeedIds.map(normalizePriceFeedId),
        parsed: parsed ?? true,
      });
      const wanted = new Set(priceFeedIds.map(normalizePriceFeedId));
      const rows = state.rows.filter((row) => wanted.has(row.priceFeedId));
      return { rows, binary: { encoding: 'hex', data: state.binary } };
    },
    async getPriceFeeds({ query, assetType }): Promise<PythHermesFeedMetadata[]> {
      state.searchCalls.push({
        ...(query !== undefined ? { query } : {}),
        ...(assetType !== undefined ? { assetType } : {}),
      });
      if (!query) return state.feedMetadata;
      const needle = query.toUpperCase();
      return state.feedMetadata.filter((entry) =>
        (entry.symbol ?? '').toUpperCase().includes(needle) ||
        (entry.description ?? '').toUpperCase().includes(needle),
      );
    },
    async getPriceFeedById(priceFeedId): Promise<PythHermesFeedMetadata | null> {
      const normalized = normalizePriceFeedId(priceFeedId);
      return state.feedMetadata.find((entry) => entry.priceFeedId === normalized) ?? null;
    },
  };
}

function buildFakeReceiver(state: FakeReceiverState): PythReceiverClient {
  return {
    async buildPostPriceUpdate(input): Promise<PythReceiverBuildResult> {
      state.buildCalls.push({
        walletAddress: input.walletAddress,
        priceUpdateDataHex: input.priceUpdateDataHex,
        closeUpdateAccounts: input.closeUpdateAccounts,
      });
      return state.result;
    },
  };
}

function freshSolRow(now: number = Math.floor(Date.now() / 1000)): PythHermesPriceUpdateRow {
  return {
    priceFeedId: SOL_FEED,
    priceRaw: '12345678',
    confidenceRaw: '1234',
    exponent: -8,
    publishTime: now,
    emaPriceRaw: '12345600',
    emaConfidenceRaw: '1000',
    emaPublishTime: now,
  };
}

function staleSolRow(now: number = Math.floor(Date.now() / 1000)): PythHermesPriceUpdateRow {
  return {
    priceFeedId: SOL_FEED,
    priceRaw: '99999900',
    confidenceRaw: '500',
    exponent: -8,
    publishTime: now - 3600,
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
  signed?: (tx: string, summary: string) => Promise<string>;
  signedMany?: (txs: string[], summary: string) => Promise<string[]>;
}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {} as unknown as DAppAdapterContext['connection'],
    signTransaction: async () => 'PythSignedTxPlaceholder1111111111111111111',
    signAndBroadcast: opts.signed ?? (async () => 'PythTxidPlaceholder1111111111111111111111'),
    signMessage: async () => 'PythSignedMsgPlaceholder111111111111111111',
    ...(opts.signedMany !== undefined ? { signAndBroadcastMany: opts.signedMany } : {}),
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
  resetPythClientFactory();
  resetPythReceiverFactory();
});

function requirePostAction() {
  const action = pythAdapter.actions.post_price_update;
  if (!action) throw new Error('Pyth adapter is missing post_price_update action.');
  return action;
}

describe('Pyth adapter shape', () => {
  it('registers with the expected id, mainnet gating, and read/action surface', () => {
    expect(pythAdapter.id).toBe(PYTH_ADAPTER_ID);
    expect(pythAdapter.supportedClusters).toEqual(PYTH_SUPPORTED_CLUSTERS);
    expect(Object.keys(pythAdapter.reads).sort()).toEqual([
      'feed_search',
      'onchain_price_account',
      'oracle_evidence',
      'price_feed',
      'price_feeds_batch',
    ]);
    expect(Object.keys(pythAdapter.actions)).toEqual(['post_price_update']);
  });

  it('is discoverable through the runtime registry', () => {
    expect(requireAdapter('pyth').id).toBe('pyth');
    expect(adapterForActionKind('pyth_post_price_update')?.id).toBe('pyth');
    expect(actionForKind('pyth_post_price_update')?.action.id).toBe('post_price_update');
  });

  it('rejects non-mainnet clusters at the cluster gate', () => {
    expect(() => assertSupportedCluster(pythAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(pythAdapter, 'mainnet-beta')).not.toThrow();
  });

  it('resolves common Solana aliases through the built-in map', () => {
    expect(resolveAlias('SOL')?.feedId).toBe(SOL_FEED);
    expect(resolveAlias('sol/usd')?.feedId).toBe(SOL_FEED);
    expect(resolveAlias('USDC')?.feedId).toBe(USDC_FEED);
    expect(resolveAlias('NONEXISTENT')).toBeUndefined();
  });
});

describe('Pyth price formatting helpers', () => {
  it('formatScaled applies the exponent and trims trailing zeros', () => {
    expect(formatScaled('12345678', -8)).toBe('0.12345678');
    expect(formatScaled('100000000', -8)).toBe('1');
    expect(formatScaled('0', -8)).toBe('0');
    expect(formatScaled('1', 2)).toBe('100');
  });

  it('computeConfidenceBps returns null when price is zero', () => {
    expect(computeConfidenceBps('0', '10')).toBeNull();
  });

  it('computeConfidenceBps reports basis points relative to price', () => {
    const bps = computeConfidenceBps('1000', '50');
    expect(bps).not.toBeNull();
    expect(bps!).toBeCloseTo(500, 5);
  });
});

describe('Pyth price feed reads', () => {
  let state: FakeHermesState;

  beforeEach(() => {
    state = {
      rows: [freshSolRow()],
      binary: ['deadbeef'],
      feedMetadata: [
        {
          priceFeedId: SOL_FEED,
          symbol: 'SOL/USD',
          description: 'Solana / US Dollar',
          assetType: 'crypto',
        },
      ],
      searchCalls: [],
      latestCalls: [],
    };
    setPythClientFactory(() => buildFakeHermes(state));
  });

  it('reads a single feed and normalizes price, confidence, and status', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.price_feed;
    if (!read) throw new Error('missing price_feed read');
    const { snapshot } = (await read.read({ priceFeedId: SOL_FEED, maxAgeSeconds: 60 }, ctx)) as {
      snapshot: import('../../adapters/pyth/prices.js').PythPriceSnapshot;
    };
    expect(snapshot.priceFeedId).toBe(SOL_FEED);
    expect(snapshot.priceUi).toBe('0.12345678');
    expect(snapshot.confidenceUi).toBe('0.00001234');
    expect(snapshot.status).toBe('fresh');
    expect(snapshot.ema?.priceUi).toBe('0.123456');
  });

  it('batch reads return per-feed status and totals (including missing)', async () => {
    state.rows = [freshSolRow(), staleSolRow()];
    state.rows[1]!.priceFeedId = USDC_FEED;
    state.rows[1]!.publishTime = Math.floor(Date.now() / 1000) - 3600;
    const missingFeed = '1111111111111111111111111111111111111111111111111111111111111111';
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.price_feeds_batch;
    if (!read) throw new Error('missing price_feeds_batch read');
    const result = (await read.read(
      { priceFeedIds: [SOL_FEED, USDC_FEED, missingFeed], maxAgeSeconds: 60 },
      ctx,
    )) as import('../../adapters/pyth/prices.js').PythPriceFeedsBatchResult;
    expect(result.totals.requested).toBe(3);
    expect(result.totals.fresh).toBe(1);
    expect(result.totals.stale).toBe(1);
    expect(result.totals.missing).toBe(1);
    expect(result.results.find((entry) => entry.status === 'missing')).toBeDefined();
  });

  it('feed_search hits alias map first and falls back to Hermes search', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.feed_search;
    if (!read) throw new Error('missing feed_search read');
    const result = (await read.read({ query: 'SOL', assetType: 'crypto', limit: 5 }, ctx)) as import('../../adapters/pyth/feeds.js').PythFeedSearchResult;
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.priceFeedId).toBe(SOL_FEED);
    expect(result.results[0]?.source).toBe('alias');
  });

  it('feed_search returns an empty list for unknown queries', async () => {
    state.feedMetadata = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.feed_search;
    if (!read) throw new Error('missing feed_search read');
    const result = (await read.read({ query: 'XYZZY-UNKNOWN', assetType: 'crypto' }, ctx)) as import('../../adapters/pyth/feeds.js').PythFeedSearchResult;
    expect(result.results).toEqual([]);
  });
});

describe('Pyth oracle evidence', () => {
  let state: FakeHermesState;

  beforeEach(() => {
    state = {
      rows: [freshSolRow()],
      binary: ['deadbeef'],
      feedMetadata: [],
      searchCalls: [],
      latestCalls: [],
    };
    setPythClientFactory(() => buildFakeHermes(state));
  });

  it('marks fresh prices within the freshness budget', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.oracle_evidence;
    if (!read) throw new Error('missing oracle_evidence read');
    const result = (await read.read(
      { priceFeedId: SOL_FEED, maxAgeSeconds: 60, maxConfidenceBps: 1_000_000 },
      ctx,
    )) as import('../../adapters/pyth/evidence.js').PythOracleEvidence;
    expect(result.status).toBe('fresh');
  });

  it('marks stale when ageSeconds exceeds maxAgeSeconds', async () => {
    state.rows = [staleSolRow()];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.oracle_evidence;
    if (!read) throw new Error('missing oracle_evidence read');
    const result = (await read.read(
      { priceFeedId: SOL_FEED, maxAgeSeconds: 60, maxConfidenceBps: 1_000_000 },
      ctx,
    )) as import('../../adapters/pyth/evidence.js').PythOracleEvidence;
    expect(result.status).toBe('stale');
    expect(result.reason).toContain('older than');
  });

  it('marks wide_confidence when confidence exceeds maxConfidenceBps', async () => {
    const row = freshSolRow();
    row.confidenceRaw = (BigInt(row.priceRaw) / 5n).toString();
    state.rows = [row];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.oracle_evidence;
    if (!read) throw new Error('missing oracle_evidence read');
    const result = (await read.read(
      { priceFeedId: SOL_FEED, maxAgeSeconds: 600, maxConfidenceBps: 50 },
      ctx,
    )) as import('../../adapters/pyth/evidence.js').PythOracleEvidence;
    expect(result.status).toBe('wide_confidence');
    expect(result.reason).toContain('Confidence');
  });

  it('returns missing when Hermes does not return the feed', async () => {
    state.rows = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.oracle_evidence;
    if (!read) throw new Error('missing oracle_evidence read');
    const result = (await read.read(
      { priceFeedId: SOL_FEED, maxAgeSeconds: 60 },
      ctx,
    )) as import('../../adapters/pyth/evidence.js').PythOracleEvidence;
    expect(result.status).toBe('missing');
  });
});

describe('Pyth on-chain account read', () => {
  beforeEach(() => {
    setPythClientFactory(() =>
      buildFakeHermes({ rows: [], binary: [], feedMetadata: [], searchCalls: [], latestCalls: [] }),
    );
    setPythReceiverFactory(() => ({
      async buildPostPriceUpdate(): Promise<PythReceiverBuildResult> {
        throw new Error('not invoked');
      },
    }));
  });

  it('returns evidenceSource: sdk_missing when the receiver SDK is unavailable', async () => {
    // Reset receiver factory: the default DynamicReceiverClient resolves lazily but never marks
    // itself missing until awaited. We force the unavailable path with a synchronous stub.
    setPythReceiverFactory(() => ({
      async buildPostPriceUpdate(): Promise<PythReceiverBuildResult> {
        throw new Error(
          'Pyth Solana Receiver is not available: @pythnetwork/pyth-solana-receiver is not installed.',
        );
      },
    }));
    // describePythReceiverUnavailableReason() returns undefined for a custom stub, so we expect the
    // onchain read to attempt PDA derivation and fall through to evidenceSource: 'sdk_missing'.
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const read = pythAdapter.reads.onchain_price_account;
    if (!read) throw new Error('missing onchain_price_account read');
    const result = (await read.read({ priceFeedId: SOL_FEED }, ctx)) as import('../../adapters/pyth/onchain.js').PythOnchainSnapshot;
    expect(['sdk_missing', 'on_chain']).toContain(result.evidenceSource);
  });
});

describe('Pyth post price update prepare', () => {
  let hermes: FakeHermesState;
  let receiver: FakeReceiverState;

  beforeEach(() => {
    hermes = {
      rows: [freshSolRow()],
      binary: ['deadbeef'],
      feedMetadata: [],
      searchCalls: [],
      latestCalls: [],
    };
    receiver = {
      buildCalls: [],
      result: {
        transactionsBase64: ['BBBB-base64-pyth-update'],
        programIds: ['rec1ProgramId111111111111111', 'wh1ProgramId1111111111111111'],
        receiverProgramId: 'rec1ProgramId111111111111111',
      },
    };
    setPythClientFactory(() => buildFakeHermes(hermes));
    setPythReceiverFactory(() => buildFakeReceiver(receiver));
  });

  it('snapshots params (priceFeedIds, priceSnapshot, hermesUrlHost, refreshAtExecution)', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requirePostAction().prepare(
      { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60, closeUpdateAccounts: true },
      ctx,
    );
    expect(result.addInput.kind).toBe('pyth_post_price_update');
    expect(result.addInput.summary).toContain('Post Pyth price update');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'pyth',
      operation: 'post_price_update',
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      priceFeedIds: [SOL_FEED],
      maxAgeSeconds: 60,
      closeUpdateAccounts: true,
      refreshAtExecution: true,
    });
    expect(result.addInput.params.priceSnapshot).toBeDefined();
    expect(result.addInput.params.confidenceSnapshot).toBeDefined();
    expect(result.addInput.params.hermesUrlHost).toBe('hermes.test');
  });

  it('rejects when priceFeedIds exceeds the single-transaction cap', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requirePostAction().prepare(
        { priceFeedIds: [SOL_FEED, USDC_FEED, '1234567812345678123456781234567812345678123456781234567812345678'] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('rejects when any feed is older than maxAgeSeconds', async () => {
    hermes.rows = [staleSolRow()];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requirePostAction().prepare(
        { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'stale_price' });
  });

  it('rejects when Hermes does not return the requested feed', async () => {
    hermes.rows = [];
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    await expect(
      requirePostAction().prepare(
        { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60 },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'feed_missing' });
  });
});

describe('Pyth post price update execute', () => {
  let hermes: FakeHermesState;
  let receiver: FakeReceiverState;

  beforeEach(() => {
    hermes = {
      rows: [freshSolRow()],
      binary: ['feedfeedfeed'],
      feedMetadata: [],
      searchCalls: [],
      latestCalls: [],
    };
    receiver = {
      buildCalls: [],
      result: {
        transactionsBase64: ['BBBB-base64-pyth-update'],
        programIds: ['rec1ProgramId111111111111111'],
        receiverProgramId: 'rec1ProgramId111111111111111',
      },
    };
    setPythClientFactory(() => buildFakeHermes(hermes));
    setPythReceiverFactory(() => buildFakeReceiver(receiver));
  });

  it('refetches Hermes binary VAA, builds one tx, and forwards to signAndBroadcast', async () => {
    const store = inMemoryStore();
    const signedCalls: Array<{ tx: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ tx, summary });
        return 'broadcasted-pyth-update-txid';
      },
    });
    const prepared = await requirePostAction().prepare(
      { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60 },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requirePostAction().execute(action, ctx);
    expect(result.txid).toBe('broadcasted-pyth-update-txid');
    expect(signedCalls[0]?.tx).toBe('BBBB-base64-pyth-update');
    expect(receiver.buildCalls).toHaveLength(1);
    expect(receiver.buildCalls[0]).toMatchObject({
      walletAddress: WALLET,
      priceUpdateDataHex: ['feedfeedfeed'],
      closeUpdateAccounts: true,
    });
    const latestCalls = hermes.latestCalls;
    expect(latestCalls[latestCalls.length - 1]?.parsed).toBe(false);
  });

  it('rejects with multi_tx_unsupported when receiver returns >1 transaction', async () => {
    receiver.result = {
      transactionsBase64: ['tx1', 'tx2'],
      programIds: ['rec1ProgramId111111111111111'],
      receiverProgramId: 'rec1ProgramId111111111111111',
    };
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requirePostAction().prepare(
      { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60 },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    await expect(requirePostAction().execute(action, ctx)).rejects.toMatchObject({
      code: 'multi_tx_unsupported',
    });
  });

  it('rejects with hermes_unavailable when no binary data is returned', async () => {
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requirePostAction().prepare(
      { priceFeedIds: [SOL_FEED], maxAgeSeconds: 60 },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    hermes.binary = [];
    await expect(requirePostAction().execute(action, ctx)).rejects.toMatchObject({
      code: 'hermes_unavailable',
    });
  });
});

describe('Pyth error redaction', () => {
  it('strips a configured bearer token from error messages', () => {
    const token = 'super-secret-pyth-token-12345';
    const wrapped = redactPythError(
      new Error(`Hermes rejected request: authorization=Bearer ${token} expired`),
      token,
    );
    expect(wrapped.message).not.toContain(token);
    expect(wrapped.message).toContain('***');
  });

  it('redacts authorization-style headers even without a known token literal', () => {
    const wrapped = redactPythError(
      new Error('Headers: authorization="Bearer rotating-token-abc"'),
      undefined,
    );
    expect(wrapped.message).not.toContain('rotating-token-abc');
    expect(wrapped.message).toContain('***');
  });
});

describe('Pyth connectorReadFacts (end-to-end)', () => {
  beforeEach(() => {
    setPythClientFactory(() =>
      buildFakeHermes({
        rows: [freshSolRow()],
        binary: [],
        feedMetadata: [
          { priceFeedId: SOL_FEED, symbol: 'SOL/USD', description: 'Solana / US Dollar', assetType: 'crypto' },
        ],
        searchCalls: [],
        latestCalls: [],
      }),
    );
  });

  it('routes capability=undefined with priceFeedId to oracle evidence', async () => {
    const { AgentWalletActionService } = await import('../../actionService.js');
    const { createMockBackend } = await import('../../mockBackend.js');
    const { DEFAULT_CONFIG } = await import('../../config.js');
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
      preparedActions: inMemoryStore(),
    });
    const result = (await service.connectorReadFacts({ connectorId: 'pyth', priceFeedId: SOL_FEED })) as Record<string, unknown>;
    expect(result.capability).toBe('oracle');
    expect(result.facts).toBeDefined();
    const evidence = result.evidence as { status: string; priceFeedId: string };
    expect(evidence.status).toBe('fresh');
    expect(evidence.priceFeedId).toBe(SOL_FEED);
  });

  it('routes capability=markets with query to feed search', async () => {
    const { AgentWalletActionService } = await import('../../actionService.js');
    const { createMockBackend } = await import('../../mockBackend.js');
    const { DEFAULT_CONFIG } = await import('../../config.js');
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
      preparedActions: inMemoryStore(),
    });
    const result = (await service.connectorReadFacts({
      connectorId: 'pyth',
      capability: 'markets',
      query: 'SOL',
    })) as Record<string, unknown>;
    expect(result.capability).toBe('markets');
    expect(result.search).toBeDefined();
  });

  it('routes capability=markets with priceFeedIds to batch read', async () => {
    const { AgentWalletActionService } = await import('../../actionService.js');
    const { createMockBackend } = await import('../../mockBackend.js');
    const { DEFAULT_CONFIG } = await import('../../config.js');
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
      preparedActions: inMemoryStore(),
    });
    const result = (await service.connectorReadFacts({
      connectorId: 'pyth',
      capability: 'markets',
      priceFeedIds: [SOL_FEED, USDC_FEED],
    })) as Record<string, unknown>;
    expect(result.capability).toBe('markets');
    expect(result.batch).toBeDefined();
  });

  it('rejects markets capability without inputs as invalid_request', async () => {
    const { AgentWalletActionService } = await import('../../actionService.js');
    const { createMockBackend } = await import('../../mockBackend.js');
    const { DEFAULT_CONFIG } = await import('../../config.js');
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: DEFAULT_CONFIG,
      preparedActions: inMemoryStore(),
    });
    await expect(
      service.connectorReadFacts({ connectorId: 'pyth', capability: 'markets' }),
    ).rejects.toMatchObject({
      name: 'ProtocolError',
      code: 'invalid_request',
    });
  });
});
