import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  MAGICEDEN_ADAPTER_ID,
  MAGICEDEN_SUPPORTED_CLUSTERS,
  magicedenAdapter,
} from '../../adapters/magiceden/index.js';
import {
  MagicedenApiClient,
  describeMagicedenUnavailableReason,
  resetMagicedenClientFactory,
  setMagicedenClientFactory,
  type MagicedenApiHealthSnapshot,
  type MagicedenClient,
  type MagicedenCollectionListings,
  type MagicedenListingRow,
  type MagicedenWalletNftsSnapshot,
} from '../../adapters/magiceden/client.js';
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
const SELLER = '8FE27ioQh3T7o22QsYVT5Re8NnHFqmFNbdqwiF3ywuZQ';
const MINT = 'So11111111111111111111111111111111111111112';
const LISTING_ID = 'listing-pda-1';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
}

interface FakeMagicedenState {
  health: MagicedenApiHealthSnapshot;
  listings: MagicedenListingRow[];
  wallet: MagicedenWalletNftsSnapshot;
  buildCalls: string[];
}

function fakeHealth(overrides: Partial<MagicedenApiHealthSnapshot> = {}): MagicedenApiHealthSnapshot {
  return {
    apiOperational: true,
    tradingOperational: true,
    readOnlyFallback: false,
    checkedAtIso: '2026-05-12T00:00:00.000Z',
    baseHost: 'api-mainnet.magiceden.dev',
    warnings: [],
    degradedReasons: [],
    ...overrides,
  };
}

function fakeListing(overrides: Partial<MagicedenListingRow> = {}): MagicedenListingRow {
  return {
    listingId: LISTING_ID,
    mintAddress: MINT,
    seller: SELLER,
    priceLamports: '1000000000',
    priceSol: '1',
    tokenName: 'Test NFT',
    auctionHouse: 'auction-house-1',
    ...overrides,
  };
}

function fakeWallet(overrides: Partial<MagicedenWalletNftsSnapshot> = {}): MagicedenWalletNftsSnapshot {
  return {
    walletAddress: WALLET,
    listedOnly: false,
    asOfIso: '2026-05-12T00:00:00.000Z',
    apiBaseHost: 'api-mainnet.magiceden.dev',
    rows: [
      { mintAddress: MINT, listed: false, tokenName: 'My NFT' },
    ],
    ...overrides,
  };
}

function fakeClient(state: FakeMagicedenState): MagicedenClient {
  return {
    async getApiHealth() {
      return state.health;
    },
    async getCollectionSummary() {
      return {
        collectionSymbol: 'test',
        name: 'Test',
        floorPriceLamports: '900000000',
        listedCount: state.listings.length,
        totalSupply: 100,
        royaltyBps: 500,
        verified: true,
        asOfIso: '2026-05-12T00:00:00.000Z',
        apiBaseHost: 'api-mainnet.magiceden.dev',
      };
    },
    async getCollectionListings(): Promise<MagicedenCollectionListings> {
      return {
        rows: state.listings,
        asOfIso: '2026-05-12T00:00:00.000Z',
        apiBaseHost: 'api-mainnet.magiceden.dev',
      };
    },
    async getCollectionBids() {
      return {
        rows: [],
        asOfIso: '2026-05-12T00:00:00.000Z',
        apiBaseHost: 'api-mainnet.magiceden.dev',
      };
    },
    async getRecentActivity() {
      return {
        rows: [],
        asOfIso: '2026-05-12T00:00:00.000Z',
        apiBaseHost: 'api-mainnet.magiceden.dev',
      };
    },
    async getWalletNfts() {
      return state.wallet;
    },
    async getNftDetail() {
      return {
        mintAddress: MINT,
        asOfIso: '2026-05-12T00:00:00.000Z',
        apiBaseHost: 'api-mainnet.magiceden.dev',
      };
    },
    async generateBuyTransaction() {
      state.buildCalls.push('buy');
      return { transactionBase64: 'base64-buy', programIds: ['M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K'], reusable: false };
    },
    async generateListTransaction() {
      state.buildCalls.push('list');
      return { transactionBase64: 'base64-list', programIds: [], reusable: false };
    },
    async generateCancelListingTransaction() {
      state.buildCalls.push('cancel_listing');
      return { transactionBase64: 'base64-cancel-listing', programIds: [], reusable: false };
    },
    async generateBidTransaction() {
      state.buildCalls.push('bid');
      return { transactionBase64: 'base64-bid', programIds: [], reusable: false };
    },
    async generateCancelBidTransaction() {
      state.buildCalls.push('cancel_bid');
      return { transactionBase64: 'base64-cancel-bid', programIds: [], reusable: false };
    },
  };
}

function fakeConfig(cluster: 'mainnet-beta' | 'devnet' = 'mainnet-beta'): AgentWalletConfig {
  return {
    cluster,
    rpcUrl: 'https://api.fake',
    mainnet: { enabled: true, maxSolTransfer: '10', maxSwapInput: '10', maxSlippageBps: 100, allowArbitraryTransactions: false },
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
    signAndBroadcast: opts.signed ?? (async () => 'txid-magiceden'),
    signTransaction: async () => "signed-base64-stub",
    signMessage: async () => "signature-base64-stub",
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
      const next = actions.filter((entry) => entry.id !== id);
      const removed = next.length !== actions.length;
      actions.length = 0;
      actions.push(...next);
      return removed;
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

function fakeState(): FakeMagicedenState {
  return {
    health: fakeHealth(),
    listings: [fakeListing()],
    wallet: fakeWallet({
      rows: [{ mintAddress: MINT, listed: false, tokenName: 'My NFT' }],
    }),
    buildCalls: [],
  };
}

function requireMeAction(
  id: 'buy' | 'list' | 'cancel_listing' | 'bid' | 'cancel_bid',
) {
  const action = magicedenAdapter.actions[id];
  if (!action) throw new Error(`Magic Eden adapter is missing action ${id}.`);
  return action;
}

afterEach(() => {
  resetMagicedenClientFactory();
  vi.unstubAllEnvs();
});

describe('Magic Eden adapter shape', () => {
  it('registers with expected id, mainnet gating, reads, and actions', () => {
    expect(magicedenAdapter.id).toBe(MAGICEDEN_ADAPTER_ID);
    expect(magicedenAdapter.supportedClusters).toEqual(MAGICEDEN_SUPPORTED_CLUSTERS);
    expect(Object.keys(magicedenAdapter.actions).sort()).toEqual(
      ['bid', 'buy', 'cancel_bid', 'cancel_listing', 'list'].sort(),
    );
    expect(magicedenAdapter.reads.api_health).toBeDefined();
    expect(magicedenAdapter.reads.collection_snapshot).toBeDefined();
    expect(magicedenAdapter.reads.wallet_nfts).toBeDefined();
  });

  it('is discoverable via the adapter registry', () => {
    expect(requireAdapter('magiceden').id).toBe('magiceden');
    expect(adapterForActionKind('magiceden_buy')?.id).toBe('magiceden');
    expect(actionForKind('magiceden_cancel_bid')?.action.id).toBe('cancel_bid');
  });

  it('throws AdapterError on cluster mismatch', () => {
    expect(() => assertSupportedCluster(magicedenAdapter, 'devnet')).toThrowError(AdapterError);
  });
});

describe('Magic Eden readiness gating', () => {
  it('returns a structured unavailable reason when the API key is missing', () => {
    resetMagicedenClientFactory();
    vi.stubEnv('MAGICEDEN_API_KEY', '');
    vi.stubEnv('MAGICEDEN_CONNECTOR_ENABLED', 'true');
    expect(describeMagicedenUnavailableReason()).toContain('MAGICEDEN_API_KEY is not set');
  });

  it('returns a structured unavailable reason when the feature flag is off', () => {
    resetMagicedenClientFactory();
    vi.stubEnv('MAGICEDEN_API_KEY', 'secret');
    vi.stubEnv('MAGICEDEN_CONNECTOR_ENABLED', 'false');
    expect(describeMagicedenUnavailableReason()).toContain('MAGICEDEN_CONNECTOR_ENABLED is not enabled');
  });
});

describe('Magic Eden buy preparation', () => {
  it('refuses to prepare a buy when the listing price exceeds maxPriceSol', async () => {
    const state = fakeState();
    state.listings = [fakeListing({ priceLamports: '2000000000', priceSol: '2' })];
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('buy').prepare({ mintAddress: MINT, maxPriceSol: '1' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('refuses to prepare a buy when trading endpoints are degraded', async () => {
    const state = fakeState();
    state.health = fakeHealth({
      apiOperational: true,
      tradingOperational: false,
      readOnlyFallback: true,
      degradedReasons: ['probe failed'],
    });
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('buy').prepare({ mintAddress: MINT, maxPriceSol: '1' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares a buy with marketSnapshot, apiHealthSnapshot, and refreshAtExecution', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMeAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    expect(result.addInput.kind).toBe('magiceden_buy');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'magiceden',
      operation: 'buy',
      mintAddress: MINT,
      listingId: LISTING_ID,
      seller: SELLER,
      priceLamports: '1000000000',
      priceSol: '1',
      maxPriceSol: '1',
      refreshAtExecution: true,
    });
    const params = result.addInput.params as Record<string, unknown>;
    expect(params.apiHealthSnapshot).toBeTruthy();
    expect(params.marketSnapshot).toBeTruthy();
    expect(Array.isArray(params.warnings)).toBe(true);
    expect((params.warnings as string[]).join(' ')).toContain('2026-02-27');
  });

  it('rejects buy execution when the listing price has drifted', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const result = await requireMeAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    const stored = await store.addAction(result.addInput);
    state.listings = [fakeListing({ priceLamports: '1100000000', priceSol: '1.1' })];
    await expect(requireMeAction('buy').execute(stored, ctx)).rejects.toThrow(/price/);
  });
});

describe('Magic Eden list preparation', () => {
  it('refuses to list a mint the wallet does not own', async () => {
    const state = fakeState();
    state.wallet = fakeWallet({ rows: [] });
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('list').prepare({ mintAddress: MINT, priceSol: '1.5' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares a list with marketSnapshot when wallet owns the mint', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMeAction('list').prepare(
      { mintAddress: MINT, priceSol: '1.5' },
      ctx,
    );
    expect(result.addInput.kind).toBe('magiceden_list');
    expect(result.addInput.params).toMatchObject({
      connectorId: 'magiceden',
      operation: 'list',
      mintAddress: MINT,
      priceLamports: '1500000000',
      priceSol: '1.5',
    });
  });
});

describe('Magic Eden bid preparation', () => {
  it('refuses to prepare a bid when required escrow exceeds the cap', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('bid').prepare(
        { bidPriceSol: '2', maxEscrowSol: '1', collectionSymbol: 'test', quantity: 1 },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('refuses a collection bid without a collection identifier', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('bid').prepare({ bidPriceSol: '1', maxEscrowSol: '2' }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('prepares a collection bid with required escrow facts', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMeAction('bid').prepare(
      { bidPriceSol: '0.5', maxEscrowSol: '1', collectionSymbol: 'test', quantity: 1 },
      ctx,
    );
    expect(result.addInput.kind).toBe('magiceden_bid');
    expect(result.addInput.params).toMatchObject({
      collectionSymbol: 'test',
      bidPriceLamports: '500000000',
      maxEscrowLamports: '1000000000',
      requiredEscrowLamports: '500000000',
      quantity: 1,
    });
  });
});

describe('Magic Eden cancel preparation', () => {
  it('refuses cancel listing when wallet has no active listing', async () => {
    const state = fakeState();
    state.wallet = fakeWallet({ rows: [{ mintAddress: MINT, listed: false }] });
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('cancel_listing').prepare({ mintAddress: MINT }, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('refuses cancel bid when no identifier is provided', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('cancel_bid').prepare({}, ctx),
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('Magic Eden buy safety hardening', () => {
  it('refuses to prepare a buy when the active listing has priceLamports=0', async () => {
    const state = fakeState();
    state.listings = [fakeListing({ priceLamports: '0', priceSol: '0' })];
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('buy').prepare({ mintAddress: MINT, maxPriceSol: '1' }, ctx),
    ).rejects.toMatchObject({ code: 'listing_not_found' });
  });

  it('refuses to prepare a buy when the active listing has no seller', async () => {
    const state = fakeState();
    state.listings = [fakeListing({ seller: '' })];
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    await expect(
      requireMeAction('buy').prepare({ mintAddress: MINT, maxPriceSol: '1' }, ctx),
    ).rejects.toMatchObject({ code: 'listing_not_found' });
  });

  it('picks the lowest-priced active listing when multiple exist for one mint', async () => {
    const state = fakeState();
    state.listings = [
      fakeListing({ listingId: 'higher', priceLamports: '2000000000', priceSol: '2' }),
      fakeListing({ listingId: 'lower', priceLamports: '900000000', priceSol: '0.9' }),
    ];
    setMagicedenClientFactory(() => fakeClient(state));
    const ctx = makeContext({ store: inMemoryStore() });
    const result = await requireMeAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    expect(result.addInput.params).toMatchObject({
      listingId: 'lower',
      priceLamports: '900000000',
    });
  });

  it('refuses to execute a buy when the API returns a transaction touching a non-ME program', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => ({
      ...fakeClient(state),
      async generateBuyTransaction() {
        return {
          transactionBase64: 'base64-buy',
          programIds: ['11111111111111111111111111111111'],
          reusable: false,
        };
      },
    }));
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireMeAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    const stored = await store.addAction(prepared.addInput);
    await expect(requireMeAction('buy').execute(stored, ctx)).rejects.toMatchObject({
      code: 'program_mismatch',
    });
  });

  it('re-checks trading health at execute time and refuses if degraded', async () => {
    const state = fakeState();
    setMagicedenClientFactory(() => fakeClient(state));
    const store = inMemoryStore();
    const ctx = makeContext({ store });
    const prepared = await requireMeAction('buy').prepare(
      { mintAddress: MINT, maxPriceSol: '1' },
      ctx,
    );
    const stored = await store.addAction(prepared.addInput);
    state.health = fakeHealth({
      apiOperational: true,
      tradingOperational: false,
      readOnlyFallback: true,
      degradedReasons: ['probe failed at execute time'],
    });
    await expect(requireMeAction('buy').execute(stored, ctx)).rejects.toMatchObject({
      code: 'health_degraded',
    });
  });
});

describe('MagicedenApiClient transport', () => {
  function stubFetch(responder: (url: string, init?: unknown) => Response): typeof fetch {
    return (async (input: unknown, init?: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      return responder(url, init);
    }) as unknown as typeof fetch;
  }

  it('redacts MAGICEDEN_API_KEY from error messages', async () => {
    const apiKey = 'sk-magiceden-secret-token-abc123';
    const client = new MagicedenApiClient({
      apiKey,
      baseUrl: 'https://api.fake',
      fetchImpl: stubFetch(() =>
        new Response(`{"error":"db crashed: authorization=Bearer ${apiKey}"}`, {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });
    await expect(client.getCollectionListings({ collectionSymbol: 'test' })).rejects.toMatchObject({
      message: expect.not.stringContaining(apiKey),
    });
    await expect(client.getCollectionListings({ collectionSymbol: 'test' })).rejects.toMatchObject({
      message: expect.stringContaining('***'),
    });
  });

  it('normalizes rate-limit headers into the health snapshot', async () => {
    const client = new MagicedenApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.fake',
      fetchImpl: stubFetch(() =>
        new Response('[]', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'retry-after': '30',
            'x-ratelimit-remaining': '0',
          },
        }),
      ),
    });
    const snapshot = await client.getApiHealth({ includeTradingEndpoints: false });
    expect(snapshot.apiOperational).toBe(true);
    expect(snapshot.rateLimit).toMatchObject({ limited: true, retryAfterSeconds: 30, remaining: 0 });
    expect(snapshot.warnings.some((w) => w.includes('rate-limited'))).toBe(true);
  });

  it('keeps tradingOperational=true when the trading probe returns a 400 Bad Request', async () => {
    const client = new MagicedenApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.fake',
      fetchImpl: stubFetch((url) => {
        if (url.includes('/collections')) {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"error":"missing required parameters"}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const snapshot = await client.getApiHealth({ includeTradingEndpoints: true });
    expect(snapshot.apiOperational).toBe(true);
    expect(snapshot.tradingOperational).toBe(true);
    expect(snapshot.readOnlyFallback).toBe(false);
  });

  it('flags tradingOperational=false when the trading probe returns 401', async () => {
    const client = new MagicedenApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.fake',
      fetchImpl: stubFetch((url) => {
        if (url.includes('/collections')) {
          return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });
    const snapshot = await client.getApiHealth({ includeTradingEndpoints: true });
    expect(snapshot.apiOperational).toBe(true);
    expect(snapshot.tradingOperational).toBe(false);
    expect(snapshot.degradedReasons.join(' ')).toContain('auth failure');
  });
});

describe('Magic Eden execute dispatcher routing', () => {
  it('exposes every magiceden_* kind through actionForKind', () => {
    const kinds = [
      'magiceden_buy',
      'magiceden_list',
      'magiceden_cancel_listing',
      'magiceden_bid',
      'magiceden_cancel_bid',
    ] as const;
    for (const kind of kinds) {
      const match = actionForKind(kind);
      expect(match?.adapter.id).toBe('magiceden');
      expect(typeof match?.action.execute).toBe('function');
    }
  });
});
