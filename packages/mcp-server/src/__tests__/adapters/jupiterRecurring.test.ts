import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  JUPITER_ADAPTER_ID,
  jupiterAdapter,
  jupiterRecurringCreateTimeOrderAction,
  jupiterRecurringDepositPriceOrderAction,
  jupiterRecurringQuote,
  listJupiterRecurringOrders,
} from '../../adapters/jupiter/index.js';
import { actionForKind, adapterForActionKind } from '../../adapters/index.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type { AgentWalletConfig, JupiterRecurringPolicyConfig } from '../../config.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const OTHER_WALLET = 'BvF5kZ8DjEEDk5xJDV8ePb6V3T5vUq9wKw3LtwQy5L6q';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const API_HOST = 'fake.jupiter-recurring.test';

class FakeBackend {
  constructor(private readonly walletAddress = WALLET) {}

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async capabilities(): Promise<{ address: string }> {
    return { address: this.walletAddress };
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeConfig(overrides: {
  recurringPolicy?: JupiterRecurringPolicyConfig;
  cluster?: 'mainnet-beta' | 'devnet';
} = {}): AgentWalletConfig {
  const recurringPolicy: JupiterRecurringPolicyConfig = overrides.recurringPolicy ?? {
    enabled: true,
    maxOrderCount: 100,
    minIntervalSeconds: 3600,
    allowDeprecatedPriceOrders: true,
  };
  return {
    cluster: overrides.cluster ?? 'mainnet-beta',
    rpcUrl: 'https://api.fake',
    mainnet: {
      enabled: true,
      maxSolTransfer: '10',
      maxSwapInput: '10',
      maxSlippageBps: 100,
      allowArbitraryTransactions: false,
    },
    tokens: [
      { symbol: 'USDC', mint: USDC_MINT, decimals: 6, maxTransfer: '1000' },
      { symbol: 'SOL', mint: SOL_MINT, decimals: 9, maxTransfer: '10' },
    ],
    jupiter: {
      baseUrl: `https://${API_HOST}/swap/v2`,
      swapBaseUrl: `https://${API_HOST}/swap/v2`,
      recurringBaseUrl: `https://${API_HOST}/recurring/v1`,
      apiKeyEnv: 'JUP_API_KEY',
    },
    connectors: {
      jupiter: {
        recurring: recurringPolicy,
      },
    },
  } as unknown as AgentWalletConfig;
}

function fakeFetch(
  handler: (request: CapturedRequest) => { status?: number; body: Record<string, unknown> },
  captured: CapturedRequest[],
): typeof fetch {
  return (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    let body: Record<string, unknown> | undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body.toString());
      } catch {
        body = undefined;
      }
    }
    const request: CapturedRequest = { url, method, headers, ...(body !== undefined && { body }) };
    captured.push(request);
    const response = handler(request);
    const text = JSON.stringify(response.body);
    return new Response(text, {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', 'content-length': String(text.length) },
    });
  }) as unknown as typeof fetch;
}

function inMemoryStore(): PreparedActionStore {
  const actions: PreparedAction[] = [];
  const store = {
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
    async getAction(id: string) {
      return actions.find((entry) => entry.id === id) ?? null;
    },
    async updateAction(id: string, patch: Partial<PreparedAction>) {
      const index = actions.findIndex((entry) => entry.id === id);
      const current = actions[index];
      if (!current) throw new Error(`Unknown ${id}`);
      actions[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
      return actions[index]!;
    },
    async deleteAction(id: string) {
      const before = actions.length;
      const next = actions.filter((entry) => entry.id !== id);
      actions.length = 0;
      actions.push(...next);
      return next.length !== before;
    },
    async archiveAction(id: string) {
      const current = await store.getAction(id);
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
    async addReceipt() {
      throw new Error('not implemented for tests');
    },
    async listReceipts() {
      return [];
    },
    async materializeDueRecurring() {
      return [];
    },
  };
  return store as unknown as PreparedActionStore;
}

function makeContext(opts: {
  config?: AgentWalletConfig;
  walletAddress?: string;
  store?: PreparedActionStore;
  signTransaction?: (tx: string, summary: string) => Promise<string>;
} = {}): DAppAdapterContext {
  return {
    backend: new FakeBackend(opts.walletAddress) as unknown as DAppAdapterContext['backend'],
    config: opts.config ?? fakeConfig(),
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: opts.signTransaction ?? (async () => 'signed-recurring-tx-base64'),
    signAndBroadcast: async () => 'unused-broadcast',
    signMessage: async () => 'unused-message-signature',
    store: opts.store ?? inMemoryStore(),
  };
}

function createTimeOrderInput(overrides: Partial<Parameters<typeof jupiterRecurringCreateTimeOrderAction.prepare>[0]> = {}) {
  return {
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    totalAmountRaw: '100000000',
    numberOfOrders: 4,
    intervalSeconds: 3600,
    automationWarningAccepted: true,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.JUP_API_KEY = 'sk-test-jupiter';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Jupiter Recurring adapter registration', () => {
  it('exposes recurring reads and actions on the Jupiter adapter', () => {
    expect(jupiterAdapter.id).toBe(JUPITER_ADAPTER_ID);
    expect(jupiterAdapter.reads.recurring_orders).toBeDefined();
    expect(jupiterAdapter.reads.recurring_order_detail).toBeDefined();
    expect(jupiterAdapter.reads.recurring_quote).toBeDefined();
    expect(jupiterAdapter.actions.recurring_create_time_order?.kind).toBe('jupiter_recurring_create_time_order');
    expect(jupiterAdapter.actions.recurring_cancel_order?.kind).toBe('jupiter_recurring_cancel_order');
    expect(jupiterAdapter.actions.recurring_deposit_price_order?.kind).toBe('jupiter_recurring_deposit_price_order');
    expect(jupiterAdapter.actions.recurring_withdraw_price_order?.kind).toBe('jupiter_recurring_withdraw_price_order');
    expect(adapterForActionKind('jupiter_recurring_create_time_order')?.id).toBe('jupiter');
    expect(actionForKind('jupiter_recurring_cancel_order')?.action.id).toBe('recurring_cancel_order');
  });
});

describe('Jupiter Recurring feature flag', () => {
  it('blocks recurring reads and writes when disabled', async () => {
    const config = fakeConfig({ recurringPolicy: { enabled: false } });
    const ctx = makeContext({ config });
    await expect(jupiterRecurringQuote(config, createTimeOrderInput())).rejects.toMatchObject({
      code: 'unsupported_method',
    });
    await expect(jupiterRecurringCreateTimeOrderAction.prepare(createTimeOrderInput(), ctx)).rejects.toMatchObject({
      code: 'unsupported_method',
    });
  });
});

describe('Jupiter Recurring quote and order reads', () => {
  it('quotes a local time order preview with per-cycle amount and warnings', async () => {
    const quote = await jupiterRecurringQuote(fakeConfig(), {
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      totalAmountRaw: '10000001',
      numberOfOrders: 3,
      intervalSeconds: 3600,
      minPrice: '50',
    });
    expect(quote).toMatchObject({
      product: 'recurring',
      totalAmountRaw: '10000001',
      totalAmount: '10.000001',
      numberOfOrders: 3,
      amountPerCycleRaw: '3333333',
      amountPerCycle: '3.333333',
      remainderRaw: '2',
      feeBps: 10,
    });
    expect(String(quote.warnings)).toContain('0.1%');
  });

  it('uses UI-provided input mint decimals for custom token DCA amounts', async () => {
    const quote = await jupiterRecurringQuote(fakeConfig(), {
      inputMint: '11111111111111111111111111111111',
      outputMint: SOL_MINT,
      inputMintDecimals: 5,
      totalAmount: '1.23456',
      numberOfOrders: 2,
      intervalSeconds: 3600,
    });

    expect(quote).toMatchObject({
      totalAmountRaw: '123456',
      totalAmount: '1.23456',
      amountPerCycleRaw: '61728',
      amountPerCycle: '0.61728',
    });
  });

  it('lists price orders and filters history sub-states locally', async () => {
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: {
        price: [
          { orderKey: 'order_done', status: 'completed', recurringType: 'price' },
          { orderKey: 'order_cancelled', status: 'cancelled', recurringType: 'price' },
        ],
      },
    }), captured));
    const result = await listJupiterRecurringOrders(fakeConfig(), {
      walletAddress: WALLET,
      state: 'cancelled',
      recurringType: 'price',
    });
    expect(result.orders.map((order) => order.orderId)).toEqual(['order_cancelled']);
    expect(captured[0]?.url).toContain('orderStatus=history');
    expect(captured[0]?.url).toContain('recurringType=price');
    expect(captured[0]?.headers['x-api-key']).toBe('sk-test-jupiter');
  });
});

describe('Jupiter Recurring create time order', () => {
  it('requires explicit automation warning acceptance', async () => {
    const ctx = makeContext({ config: fakeConfig() });
    await expect(
      jupiterRecurringCreateTimeOrderAction.prepare(
        createTimeOrderInput({ automationWarningAccepted: false }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('stores transactionBase64, request body, and warning flags on prepare success', async () => {
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { transaction: 'prepare-create-tx-base64', requestId: 'prepare-request-id' },
    }), captured));
    const result = await jupiterRecurringCreateTimeOrderAction.prepare(createTimeOrderInput(), makeContext());
    expect(result.preview).toMatchObject({
      connectorId: 'jupiter',
      product: 'recurring',
      operation: 'create_time_order',
      automationWarningAccepted: true,
      refreshAtExecution: true,
      requestId: 'prepare-request-id',
      transactionBase64: 'prepare-create-tx-base64',
      amountPerCycleRaw: '25000000',
      feeBps: 10,
    });
    expect(captured[0]?.url).toBe(`https://${API_HOST}/recurring/v1/createOrder`);
    expect(captured[0]?.body).toMatchObject({
      user: WALLET,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      params: {
        time: {
          inAmount: 100000000,
          numberOfOrders: 4,
          interval: 3600,
          minPrice: null,
          maxPrice: null,
          startAt: null,
        },
      },
    });
    expect(JSON.stringify(result.preview)).not.toContain('sk-test-jupiter');
  });

  it('refreshes the unsigned transaction, signs it, and submits /execute', async () => {
    const captured: CapturedRequest[] = [];
    let createCalls = 0;
    vi.stubGlobal('fetch', fakeFetch((request) => {
      if (request.url.endsWith('/createOrder')) {
        createCalls += 1;
        return {
          body: {
            transaction: createCalls === 1 ? 'prepare-create-tx-base64' : 'fresh-create-tx-base64',
            requestId: createCalls === 1 ? 'prepare-request-id' : 'fresh-request-id',
          },
        };
      }
      if (request.url.endsWith('/execute')) {
        return { body: { signature: 'recurring-create-txid', order: 'recurring-order-id', status: 'success' } };
      }
      return { body: {} };
    }, captured));
    const signTransaction = vi.fn(async () => 'signed-fresh-create-tx-base64');
    const ctx = makeContext({ signTransaction });
    const prepared = await jupiterRecurringCreateTimeOrderAction.prepare(createTimeOrderInput(), ctx);
    const stored = await ctx.store.addAction(prepared.addInput);
    const executed = await jupiterRecurringCreateTimeOrderAction.execute(stored, ctx);
    expect(signTransaction).toHaveBeenCalledWith('fresh-create-tx-base64', stored.summary);
    expect(executed.txid).toBe('recurring-create-txid');
    expect(executed.preview).toMatchObject({
      operation: 'create_time_order',
      walletAddress: WALLET,
      requestId: 'fresh-request-id',
      orderId: 'recurring-order-id',
    });
    const executeCall = captured.find((entry) => entry.url.endsWith('/execute'));
    expect(executeCall?.body).toEqual({
      signedTransaction: 'signed-fresh-create-tx-base64',
      requestId: 'fresh-request-id',
    });
  });

  it('rejects execution when the prepared action belongs to another wallet', async () => {
    const ctx = makeContext({ walletAddress: OTHER_WALLET });
    const action = await inMemoryStore().addAction({
      kind: 'jupiter_recurring_create_time_order',
      walletAddress: WALLET,
      cluster: 'mainnet-beta',
      summary: 'Create Jupiter Recurring order',
      params: {
        createOrderParams: { user: WALLET },
      },
    });
    await expect(jupiterRecurringCreateTimeOrderAction.execute(action, ctx)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('Jupiter Recurring deprecated price-order management', () => {
  it('requires explicit deprecated price-order acceptance', async () => {
    await expect(
      jupiterRecurringDepositPriceOrderAction.prepare(
        { orderId: 'price_order_1', amountRaw: '5000000' },
        makeContext(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('honors policy that disables deprecated price-order management', async () => {
    const config = fakeConfig({
      recurringPolicy: {
        enabled: true,
        allowDeprecatedPriceOrders: false,
      },
    });
    await expect(
      jupiterRecurringDepositPriceOrderAction.prepare(
        { orderId: 'price_order_1', amountRaw: '5000000', priceOrderDeprecationAccepted: true },
        makeContext({ config }),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_method' });
  });

  it('prepares price-order deposits against /priceDeposit', async () => {
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch((request) => {
      if (request.url.includes('/getRecurringOrders')) {
        return {
          body: {
            price: [{ orderKey: 'price_order_1', status: 'active', recurringType: 'price' }],
          },
        };
      }
      if (request.url.endsWith('/priceDeposit')) {
        return { body: { transactionBase64: 'price-deposit-tx-base64', requestId: 'price-deposit-request-id' } };
      }
      return { body: {} };
    }, captured));
    const prepared = await jupiterRecurringDepositPriceOrderAction.prepare(
      { orderId: 'price_order_1', amountRaw: '5000000', priceOrderDeprecationAccepted: true },
      makeContext(),
    );
    const priceDepositCall = captured.find((entry) => entry.url.endsWith('/priceDeposit'));
    expect(priceDepositCall?.body).toMatchObject({
      order: 'price_order_1',
      user: WALLET,
      amount: 5000000,
    });
    expect(prepared.preview).toMatchObject({
      product: 'recurring',
      operation: 'deposit_price_order',
      recurringType: 'price',
      amountRaw: '5000000',
      priceOrderDeprecationAccepted: true,
      transactionBase64: 'price-deposit-tx-base64',
    });
  });
});
