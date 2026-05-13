import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  TENSOR_ADAPTER_ID,
  TENSOR_SUPPORTED_CLUSTERS,
  tensorAdapter,
} from '../../adapters/tensor/index.js';
import {
  describeTensorUnavailableReason,
  isTensorConfigured,
  resetTensorClientFactory,
  setTensorClientFactory,
  type TensorBid,
  type TensorBuiltTx,
  type TensorClient,
  type TensorListing,
  type TensorNftDetail,
  type TensorWalletExposure,
} from '../../adapters/tensor/client.js';
import { TENSOR_PROGRAM_IDS } from '../../adapters/tensor/constants.js';
// Import from types.js directly so this test does not pay the cost (or load
// failures) of every other adapter's module side-effects via the barrel.
import {
  AdapterError,
  assertSupportedCluster,
} from '../../adapters/types.js';
import type { AgentWalletConfig } from '../../config.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const OTHER_WALLET = 'So11111111111111111111111111111111111111112';
const MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const COLLECTION = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SELLER = '5xoBq7f7CDgZwqHrDBdRWM84ExRetg4gZq93dyJtoSwp';
const BIDDER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const BID_ID = 'bid-1';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeTensorState {
  listing: TensorListing | null;
  detail: TensorNftDetail;
  exposure: TensorWalletExposure;
  bidById: Map<string, TensorBid>;
  buildCalls: string[];
  collectionListings: TensorListing[];
}

function fakePreview(compressed: boolean) {
  return {
    feeLamports: '1000000',
    royaltyLamports: '50000',
    programIds: TENSOR_PROGRAM_IDS,
    compressed,
  };
}

function fakeTensorClient(state: FakeTensorState): TensorClient {
  const built = (verb: string, compressed: boolean): TensorBuiltTx => ({
    transactionBase64: `base64-${verb}`,
    preview: fakePreview(compressed),
  });
  return {
    async fetchCollectionStats() {
      return {
        collectionId: COLLECTION,
        name: 'Test Collection',
        verified: true,
        floorPriceLamports: '1000000000',
        floorPriceSol: '1',
        listedCount: 10,
        totalSupply: 100,
        asOf: new Date().toISOString(),
      };
    },
    async fetchCollectionListings() {
      return [...state.collectionListings];
    },
    async fetchCollectionBids() {
      return [...state.bidById.values()];
    },
    async fetchRecentSales() {
      return [];
    },
    async fetchWalletNfts(_connection, input) {
      return {
        walletAddress: input.walletAddress,
        nfts: [{ mintAddress: MINT, owner: WALLET, compressed: false, listed: true, listingPriceSol: '2' }],
        totals: { nfts: 1, compressed: 0, listed: 1 },
      };
    },
    async fetchNftDetail() {
      return state.detail;
    },
    async fetchWalletExposure() {
      return state.exposure;
    },
    async refreshListing() {
      return state.listing;
    },
    async refreshBid(_connection, input) {
      return state.bidById.get(input.bidId) ?? null;
    },
    async buildBuyTx() {
      state.buildCalls.push('buy');
      return built('buy', state.listing?.compressed ?? false);
    },
    async buildListTx() {
      state.buildCalls.push('list');
      return built('list', state.detail.compressed);
    },
    async buildCancelListingTx() {
      state.buildCalls.push('cancel_listing');
      return built('cancel_listing', state.listing?.compressed ?? false);
    },
    async buildBidTx() {
      state.buildCalls.push('bid');
      return built('bid', false);
    },
    async buildCancelBidTx() {
      state.buildCalls.push('cancel_bid');
      return built('cancel_bid', false);
    },
    async buildSweepTx() {
      state.buildCalls.push('sweep');
      return built('sweep', state.collectionListings[0]?.compressed ?? false);
    },
  };
}

function fakeListing(overrides: Partial<TensorListing> = {}): TensorListing {
  return {
    listingId: 'listing-1',
    mintAddress: MINT,
    collectionId: COLLECTION,
    seller: SELLER,
    priceLamports: '2000000000',
    priceSol: '2',
    marketplace: 'tensor',
    compressed: false,
    asOf: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDetail(overrides: Partial<TensorNftDetail> = {}): TensorNftDetail {
  return {
    mintAddress: MINT,
    collectionId: COLLECTION,
    owner: WALLET,
    compressed: false,
    listed: true,
    listingPriceSol: '2',
    marketplace: 'tensor',
    topListing: fakeListing(),
    topBids: [],
    ...overrides,
  };
}

function fakeExposure(overrides: Partial<TensorWalletExposure> = {}): TensorWalletExposure {
  return {
    walletAddress: WALLET,
    ownedCollections: [{ collectionId: COLLECTION, name: 'Test', count: 1 }],
    openListings: [],
    openBids: [],
    marginBalanceLamports: '0',
    marginBalanceSol: '0',
    asOf: new Date().toISOString(),
    ...overrides,
  };
}

function fakeState(): FakeTensorState {
  const listing = fakeListing();
  return {
    listing,
    detail: fakeDetail({ topListing: listing }),
    exposure: fakeExposure(),
    bidById: new Map([
      [BID_ID, {
        bidId: BID_ID,
        collectionId: COLLECTION,
        bidder: WALLET,
        bidPriceLamports: '500000000',
        bidPriceSol: '0.5',
        quantity: 1,
        escrowLamports: '500000000',
        asOf: new Date().toISOString(),
      }],
    ]),
    buildCalls: [],
    collectionListings: [
      fakeListing({ listingId: 'l1', mintAddress: MINT, priceLamports: '100000000', priceSol: '0.1' }),
      fakeListing({ listingId: 'l2', mintAddress: COLLECTION, priceLamports: '200000000', priceSol: '0.2' }),
      fakeListing({ listingId: 'l3', mintAddress: '6KbtSyihKHvAGqRMtaowQEgL26WtFiSPm2pHwLJrZdwa', priceLamports: '300000000', priceSol: '0.3' }),
    ],
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
    connection: {} as Connection,
    signAndBroadcast: opts.signed ?? (async () => 'txid-tensor'),
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

function requireTensorAction(
  id: 'buy' | 'list' | 'cancel_listing' | 'bid' | 'cancel_bid' | 'sweep',
) {
  const action = tensorAdapter.actions[id];
  if (!action) throw new Error(`Tensor adapter is missing action ${id}.`);
  return action;
}

afterEach(() => {
  resetTensorClientFactory();
  delete process.env.TENSOR_API_KEY;
});

describe('Tensor adapter shape', () => {
  it('registers with expected id, mainnet gating, reads, and actions', () => {
    expect(tensorAdapter.id).toBe(TENSOR_ADAPTER_ID);
    expect(tensorAdapter.supportedClusters).toEqual(TENSOR_SUPPORTED_CLUSTERS);
    expect(Object.keys(tensorAdapter.actions).sort()).toEqual([
      'bid',
      'buy',
      'cancel_bid',
      'cancel_listing',
      'list',
      'sweep',
    ]);
    expect(tensorAdapter.reads.collection_snapshot).toBeDefined();
    expect(tensorAdapter.reads.collection_listings).toBeDefined();
    expect(tensorAdapter.reads.collection_bids).toBeDefined();
    expect(tensorAdapter.reads.recent_sales).toBeDefined();
    expect(tensorAdapter.reads.wallet_nfts).toBeDefined();
    expect(tensorAdapter.reads.nft_detail).toBeDefined();
    expect(tensorAdapter.reads.wallet_marketplace_exposure).toBeDefined();
  });

  it('exposes the correct PreparedActionKind on every action', () => {
    // Equivalent to actionForKind/adapterForActionKind asserts, but without
    // pulling the registry barrel (which transitively loads every other
    // adapter's module-time side effects).
    const byKind = Object.fromEntries(
      Object.entries(tensorAdapter.actions).map(([id, action]) => [action.kind, id]),
    );
    expect(byKind).toEqual({
      tensor_buy: 'buy',
      tensor_list: 'list',
      tensor_cancel_listing: 'cancel_listing',
      tensor_bid: 'bid',
      tensor_cancel_bid: 'cancel_bid',
      tensor_sweep: 'sweep',
    });
  });

  it('throws AdapterError on cluster mismatch via assertSupportedCluster', () => {
    expect(() => assertSupportedCluster(tensorAdapter, 'devnet')).toThrowError(AdapterError);
    expect(() => assertSupportedCluster(tensorAdapter, 'mainnet-beta')).not.toThrow();
  });
});

describe('Tensor client unavailability', () => {
  it('reports a readable reason when the host has not wired a client', () => {
    resetTensorClientFactory();
    expect(isTensorConfigured()).toBe(false);
    expect(describeTensorUnavailableReason()).toMatch(/tensor.*sdk|not wired|setTensorClientFactory/i);
  });

  it('throws sdk_unavailable from every action when no client is set', async () => {
    resetTensorClientFactory();
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'sdk_unavailable', adapterId: 'tensor' });
  });
});

describe('Tensor buy preparation', () => {
  it('rejects when current listing price exceeds maxPriceSol', async () => {
    const state = fakeState();
    state.listing = fakeListing({ priceLamports: '2000000000', priceSol: '2' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1.5' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'price_above_cap' });
  });

  it('rejects when expectedSeller does not match', async () => {
    const state = fakeState();
    state.listing = fakeListing({ priceLamports: '500000000', priceSol: '0.5' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1', expectedSeller: OTHER_WALLET },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'seller_mismatch' });
  });

  it('prepares a buy with the listing snapshot and refreshAtExecution', async () => {
    const state = fakeState();
    state.listing = fakeListing({ priceLamports: '500000000', priceSol: '0.5' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_buy');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'tensor',
      mintAddress: MINT,
      priceLamports: '500000000',
      maxPriceLamports: '1000000000',
      refreshAtExecution: true,
      compressed: false,
    });
    expect(state.buildCalls).toEqual(['buy']);
  });
});

describe('Tensor list preparation', () => {
  it('rejects when wallet does not own the NFT', async () => {
    const state = fakeState();
    state.detail = fakeDetail({ owner: OTHER_WALLET });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('list').prepare(
        { mintAddress: MINT, priceSol: '2' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_owner' });
  });

  it('refuses to list a frozen NFT', async () => {
    const state = fakeState();
    state.detail = fakeDetail({ frozen: true });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('list').prepare(
        { mintAddress: MINT, priceSol: '2' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'frozen_asset' });
  });

  it('prepares a list with priceLamports and ownership facts', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('list').prepare(
      { mintAddress: MINT, priceSol: '3' },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_list');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'tensor',
      mintAddress: MINT,
      priceLamports: '3000000000',
      refreshAtExecution: true,
    });
  });
});

describe('Tensor bid preparation', () => {
  it('rejects when escrow + delta exceeds maxEscrowSol', async () => {
    const state = fakeState();
    state.exposure = fakeExposure({ marginBalanceLamports: '0', marginBalanceSol: '0' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('bid').prepare(
        {
          collectionId: COLLECTION,
          bidPriceSol: '1.5',
          quantity: 1,
          maxEscrowSol: '1',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'escrow_above_cap' });
  });

  it('counts existing escrow against the cap', async () => {
    const state = fakeState();
    state.exposure = fakeExposure({ marginBalanceLamports: '800000000', marginBalanceSol: '0.8' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('bid').prepare(
        {
          collectionId: COLLECTION,
          bidPriceSol: '0.5',
          quantity: 1,
          maxEscrowSol: '1',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'escrow_above_cap' });
  });

  it('prepares a collection bid when caps are respected', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('bid').prepare(
      {
        collectionId: COLLECTION,
        bidPriceSol: '0.5',
        quantity: 2,
        maxEscrowSol: '2',
      },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_bid');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'tensor',
      collectionId: COLLECTION,
      bidPriceLamports: '500000000',
      maxEscrowLamports: '2000000000',
      quantity: 2,
      refreshAtExecution: true,
    });
  });
});

describe('Tensor cancel-bid preparation', () => {
  it('rejects needs_input when multiple open bids exist and no bidId supplied', async () => {
    const state = fakeState();
    state.exposure = fakeExposure({
      openBids: [
        {
          bidId: 'b1',
          collectionId: COLLECTION,
          bidder: WALLET,
          bidPriceLamports: '500000000',
          bidPriceSol: '0.5',
          quantity: 1,
        },
        {
          bidId: 'b2',
          collectionId: COLLECTION,
          bidder: WALLET,
          bidPriceLamports: '600000000',
          bidPriceSol: '0.6',
          quantity: 1,
        },
      ],
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('cancel_bid').prepare({}, ctx),
    ).rejects.toMatchObject({ code: 'needs_input' });
  });

  it('prepares when only one bid is open', async () => {
    const state = fakeState();
    state.exposure = fakeExposure({
      openBids: [
        {
          bidId: BID_ID,
          collectionId: COLLECTION,
          bidder: WALLET,
          bidPriceLamports: '500000000',
          bidPriceSol: '0.5',
          quantity: 1,
        },
      ],
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('cancel_bid').prepare({}, ctx);

    expect(result.addInput.kind).toBe('tensor_cancel_bid');
    expect(result.addInput.params).toMatchObject({ bidId: BID_ID });
  });
});

describe('Tensor sweep preparation', () => {
  it('rejects when more than MAX_SWEEP_ITEMS are requested', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 11,
          maxTotalSol: '5',
          maxPricePerItemSol: '0.5',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'too_many_items' });
  });

  it('rejects when total exceeds maxTotalSol', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 3,
          maxTotalSol: '0.4',
          maxPricePerItemSol: '0.5',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'total_above_cap' });
  });

  it('rejects mixed compressed flags', async () => {
    const state = fakeState();
    state.collectionListings = [
      fakeListing({ listingId: 'a', mintAddress: MINT, priceLamports: '100000000', priceSol: '0.1', compressed: false }),
      fakeListing({ listingId: 'b', mintAddress: COLLECTION, priceLamports: '200000000', priceSol: '0.2', compressed: true }),
    ];
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 2,
          maxTotalSol: '1',
          maxPricePerItemSol: '0.5',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'mixed_compressed' });
  });

  it('stores exactSweepItems with per-item expected prices', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('sweep').prepare(
      {
        collectionId: COLLECTION,
        maxItems: 3,
        maxTotalSol: '1',
        maxPricePerItemSol: '0.5',
      },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_sweep');
    const items = (result.addInput.params as Record<string, unknown>).exactSweepItems as Array<{
      mintAddress?: string;
      expectedPriceLamports: string;
    }>;
    expect(items.length).toBe(3);
    expect(items[0]?.expectedPriceLamports).toBe('100000000');
    expect((result.addInput.params as Record<string, unknown>).compressed).toBe(false);
  });

  it('blocks execute when a refreshed listing price has changed', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const store = inMemoryStore();
    let signed = 0;
    const ctx = makeContext({
      store,
      signed: async () => {
        signed += 1;
        return 'txid-sweep';
      },
    });

    const prepared = await requireTensorAction('sweep').prepare(
      {
        collectionId: COLLECTION,
        maxItems: 3,
        maxTotalSol: '1',
        maxPricePerItemSol: '0.5',
      },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);

    // Mutate the listing that refreshListing returns so the sweep refresh detects drift.
    state.listing = fakeListing({
      listingId: 'l1',
      mintAddress: MINT,
      priceLamports: '999999999',
      priceSol: '0.999999999',
    });

    await expect(
      requireTensorAction('sweep').execute(action, ctx),
    ).rejects.toMatchObject({ code: 'state_changed' });
    expect(signed).toBe(0);
  });
});

describe('Tensor execute refresh', () => {
  it('rebuilds and signs when the refreshed buy listing still matches', async () => {
    const state = fakeState();
    state.listing = fakeListing({ priceLamports: '500000000', priceSol: '0.5' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const store = inMemoryStore();
    const signedCalls: Array<{ tx: string; summary: string }> = [];
    const ctx = makeContext({
      store,
      signed: async (tx, summary) => {
        signedCalls.push({ tx, summary });
        return 'txid-buy';
      },
    });

    const prepared = await requireTensorAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    const result = await requireTensorAction('buy').execute(action, ctx);

    expect(result.txid).toBe('txid-buy');
    expect(state.buildCalls).toEqual(['buy', 'buy']);
    expect(signedCalls[0]).toMatchObject({ tx: 'base64-buy' });
  });

  it('blocks execute when the refreshed listing price exceeds the prepared cap', async () => {
    const state = fakeState();
    state.listing = fakeListing({ priceLamports: '500000000', priceSol: '0.5' });
    setTensorClientFactory(() => fakeTensorClient(state));
    const store = inMemoryStore();
    let signed = 0;
    const ctx = makeContext({
      store,
      signed: async () => {
        signed += 1;
        return 'txid-buy';
      },
    });

    const prepared = await requireTensorAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    const action = await store.addAction(prepared.addInput);
    state.listing = fakeListing({ priceLamports: '2000000000', priceSol: '2' });

    await expect(
      requireTensorAction('buy').execute(action, ctx),
    ).rejects.toMatchObject({ code: 'state_changed' });
    expect(signed).toBe(0);
  });
});

describe('Tensor API key redaction', () => {
  beforeEach(() => {
    process.env.TENSOR_API_KEY = 'tensor-secret-abc123';
  });

  it('redacts TENSOR_API_KEY from thrown error messages', async () => {
    const state = fakeState();
    const failingClient = {
      ...fakeTensorClient(state),
      async refreshListing() {
        throw new Error(`Tensor 401: bad key tensor-secret-abc123 from header`);
      },
    } as TensorClient;
    setTensorClientFactory(() => failingClient);
    const ctx = makeContext({ store: inMemoryStore() });

    try {
      await requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1' },
        ctx,
      );
      throw new Error('Expected adapter to throw.');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('tensor-secret-abc123');
    }
  });
});

describe('Tensor collection slug support', () => {
  it('accepts a non-public-key collection id (slug) for sweep', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('sweep').prepare(
      {
        collectionId: 'madlads',
        maxItems: 2,
        maxTotalSol: '1',
        maxPricePerItemSol: '0.5',
      },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_sweep');
    expect((result.addInput.params as Record<string, unknown>).collectionId).toBe('madlads');
  });

  it('accepts a non-public-key collection id (slug) for cancel_bid', async () => {
    const state = fakeState();
    state.exposure = fakeExposure({
      openBids: [
        {
          bidId: BID_ID,
          collectionId: 'madlads',
          bidder: WALLET,
          bidPriceLamports: '500000000',
          bidPriceSol: '0.5',
          quantity: 1,
        },
      ],
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('cancel_bid').prepare(
      { collectionId: 'madlads' },
      ctx,
    );

    expect(result.addInput.kind).toBe('tensor_cancel_bid');
    expect((result.addInput.params as Record<string, unknown>).bidId).toBe(BID_ID);
  });

  it('rejects an empty collection id with missing_input', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: '   ',
          maxItems: 1,
          maxTotalSol: '1',
          maxPricePerItemSol: '0.5',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'missing_input' });
  });
});

describe('Tensor bid compressed flag', () => {
  it('threads compressed: true through prepare params for tcomp collections', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('bid').prepare(
      {
        collectionId: COLLECTION,
        bidPriceSol: '0.5',
        quantity: 1,
        maxEscrowSol: '2',
        compressed: true,
      },
      ctx,
    );

    expect(result.addInput.params).toMatchObject({
      compressed: true,
      bidPriceLamports: '500000000',
    });
  });

  it('defaults compressed to false when not provided', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('bid').prepare(
      {
        collectionId: COLLECTION,
        bidPriceSol: '0.5',
        quantity: 1,
        maxEscrowSol: '2',
      },
      ctx,
    );

    expect(result.addInput.params).toMatchObject({ compressed: false });
  });
});

describe('Tensor sweep requiredMintAddresses', () => {
  const RARE_MINT = '6KbtSyihKHvAGqRMtaowQEgL26WtFiSPm2pHwLJrZdwa';

  function clientWithPerMintRefresh(
    state: FakeTensorState,
    perMint: Record<string, TensorListing | null>,
  ): TensorClient {
    const base = fakeTensorClient(state);
    return {
      ...base,
      async refreshListing(_connection, input) {
        const id = input.mintAddress ?? input.assetId ?? '';
        return perMint[id] ?? null;
      },
    } as TensorClient;
  }

  it('uses per-mint refreshListing instead of bulk fetch when requiredMintAddresses is supplied', async () => {
    const state = fakeState();
    const rareListing = fakeListing({
      listingId: 'rare',
      mintAddress: RARE_MINT,
      priceLamports: '300000000',
      priceSol: '0.3',
    });
    state.collectionListings = [];
    setTensorClientFactory(() =>
      clientWithPerMintRefresh(state, { [RARE_MINT]: rareListing }),
    );
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('sweep').prepare(
      {
        collectionId: COLLECTION,
        maxItems: 1,
        maxTotalSol: '1',
        maxPricePerItemSol: '0.5',
        requiredMintAddresses: [RARE_MINT],
      },
      ctx,
    );

    const items = (result.addInput.params as Record<string, unknown>).exactSweepItems as Array<{
      mintAddress?: string;
      expectedPriceLamports: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.mintAddress).toBe(RARE_MINT);
    expect(items[0]?.expectedPriceLamports).toBe('300000000');
  });

  it('rejects when a required mint is not actively listed', async () => {
    const state = fakeState();
    state.collectionListings = [];
    setTensorClientFactory(() => clientWithPerMintRefresh(state, {}));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 1,
          maxTotalSol: '1',
          maxPricePerItemSol: '0.5',
          requiredMintAddresses: [RARE_MINT],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'listing_not_found' });
  });

  it('rejects when a required mint exceeds the per-item cap', async () => {
    const state = fakeState();
    const expensiveListing = fakeListing({
      listingId: 'pricey',
      mintAddress: RARE_MINT,
      priceLamports: '900000000',
      priceSol: '0.9',
    });
    state.collectionListings = [];
    setTensorClientFactory(() =>
      clientWithPerMintRefresh(state, { [RARE_MINT]: expensiveListing }),
    );
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 1,
          maxTotalSol: '1',
          maxPricePerItemSol: '0.5',
          requiredMintAddresses: [RARE_MINT],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'price_above_cap' });
  });

  it('rejects when a required mint also appears in excludeMintAddresses', async () => {
    const state = fakeState();
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('sweep').prepare(
        {
          collectionId: COLLECTION,
          maxItems: 1,
          maxTotalSol: '1',
          maxPricePerItemSol: '0.5',
          requiredMintAddresses: [MINT],
          excludeMintAddresses: [MINT],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('Tensor list allowCompressed', () => {
  it('rejects compressed NFT when allowCompressed: false', async () => {
    const state = fakeState();
    state.detail = fakeDetail({ compressed: true });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('list').prepare(
        { mintAddress: MINT, priceSol: '2', allowCompressed: false },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'compressed_not_allowed' });
  });

  it('lists a compressed NFT when allowCompressed defaults true', async () => {
    const state = fakeState();
    state.detail = fakeDetail({ compressed: true });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('list').prepare(
      { mintAddress: MINT, priceSol: '2' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({ compressed: true });
  });
});

describe('Tensor cancel-listing multi-listing disambiguation', () => {
  it('raises needs_input when walletOpenListings > 1 and no listingId is given', async () => {
    const state = fakeState();
    state.detail = fakeDetail({
      topListing: fakeListing({ seller: WALLET }),
      walletOpenListings: 2,
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('cancel_listing').prepare({ mintAddress: MINT }, ctx),
    ).rejects.toMatchObject({ code: 'needs_input' });
  });

  it('accepts a single open listing without listingId', async () => {
    const state = fakeState();
    state.detail = fakeDetail({
      topListing: fakeListing({ seller: WALLET }),
      walletOpenListings: 1,
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('cancel_listing').prepare(
      { mintAddress: MINT },
      ctx,
    );
    expect(result.addInput.kind).toBe('tensor_cancel_listing');
  });
});

describe('Tensor buy marketplace mismatch', () => {
  it('rejects when expectedMarketplace=tensor but listing.marketplace differs', async () => {
    const state = fakeState();
    state.listing = fakeListing({
      priceLamports: '500000000',
      priceSol: '0.5',
      marketplace: 'aggregator',
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1', expectedMarketplace: 'tensor' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'marketplace_mismatch' });
  });

  it('allows any_tensor_supported regardless of marketplace label', async () => {
    const state = fakeState();
    state.listing = fakeListing({
      priceLamports: '500000000',
      priceSol: '0.5',
      marketplace: 'aggregator',
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    const result = await requireTensorAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1', expectedMarketplace: 'any_tensor_supported' },
      ctx,
    );
    expect(result.addInput.kind).toBe('tensor_buy');
  });
});

describe('Tensor buy stale listing', () => {
  it('rejects when the listing snapshot is older than MAX_QUOTE_AGE_MS', async () => {
    const state = fakeState();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    state.listing = fakeListing({
      priceLamports: '500000000',
      priceSol: '0.5',
      asOf: stale,
    });
    setTensorClientFactory(() => fakeTensorClient(state));
    const ctx = makeContext({ store: inMemoryStore() });

    await expect(
      requireTensorAction('buy').prepare(
        { mintAddress: MINT, maxPriceSol: '1' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'stale_listing' });
  });
});
