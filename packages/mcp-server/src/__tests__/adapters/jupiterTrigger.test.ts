import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@solana-agent-wallet-adapter/core';

import {
  JUPITER_ADAPTER_ID,
  jupiterAdapter,
  jupiterTriggerCancelOrderAction,
  jupiterTriggerEditOrderAction,
  jupiterTriggerOcoOrderAction,
  jupiterTriggerOtocoOrderAction,
  jupiterTriggerRegisterVaultAction,
  jupiterTriggerSingleOrderAction,
  jupiterTriggerWithdrawOrderFundsAction,
  redactJupiterSecrets,
  resetJupiterTriggerAuthCache,
  storeJupiterTriggerJwt,
  requestJupiterTriggerChallenge,
  verifyJupiterTriggerChallenge,
  readJupiterTriggerAuthStatus,
  readJupiterTriggerVault,
  listJupiterTriggerOrders,
} from '../../adapters/jupiter/index.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type { AgentWalletConfig, JupiterTriggerPolicyConfig } from '../../config.js';
import type {
  AddPreparedActionInput,
  PreparedAction,
  PreparedActionStore,
} from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const OTHER_WALLET = 'BvF5kZ8DjEEDk5xJDV8ePb6V3T5vUq9wKw3LtwQy5L6q';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const API_HOST = 'fake.jupiter.test';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeConfig(overrides: { triggerPolicy?: JupiterTriggerPolicyConfig; cluster?: 'mainnet-beta' | 'devnet' } = {}): AgentWalletConfig {
  const cluster = overrides.cluster ?? 'mainnet-beta';
  const triggerPolicy: JupiterTriggerPolicyConfig = overrides.triggerPolicy ?? {
    enabled: true,
    maxOrderLifetimeDays: 30,
    highSlippageWarnBps: 300,
  };
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
    jupiter: {
      baseUrl: `https://${API_HOST}/swap/v2`,
      swapBaseUrl: `https://${API_HOST}/swap/v2`,
      triggerBaseUrl: `https://${API_HOST}/trigger/v2`,
      apiKeyEnv: 'JUP_API_KEY',
    },
    connectors: {
      jupiter: {
        trigger: triggerPolicy,
      },
    },
  } as unknown as AgentWalletConfig;
}

function fakeFetch(handler: (request: CapturedRequest) => { status?: number; body: Record<string, unknown> }, captured: CapturedRequest[]): typeof fetch {
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
  store?: PreparedActionStore;
  signTransaction?: (tx: string, summary: string) => Promise<string>;
  signMessage?: (msg: string, summary: string) => Promise<string>;
  backend?: DAppAdapterContext['backend'];
}): DAppAdapterContext {
  return {
    backend: opts.backend ?? (new FakeBackend() as unknown as DAppAdapterContext['backend']),
    config: opts.config ?? fakeConfig(),
    connection: {} as DAppAdapterContext['connection'],
    signTransaction: opts.signTransaction ?? (async () => 'signed-trigger-tx-base64'),
    signAndBroadcast: async () => 'unused-broadcast',
    signMessage: opts.signMessage ?? (async () => 'signed-message-base64'),
    store: opts.store ?? inMemoryStore(),
  };
}

function authenticate(walletAddress = WALLET, config = fakeConfig()): void {
  storeJupiterTriggerJwt({
    walletAddress,
    cluster: config.cluster,
    apiHost: `${API_HOST}`,
    jwt: 'fake-jwt-token',
    expiresAt: Date.now() + 30 * 60 * 1000,
  });
}

beforeEach(() => {
  process.env.JUP_API_KEY = 'sk-test-jupiter';
  resetJupiterTriggerAuthCache();
});

afterEach(() => {
  resetJupiterTriggerAuthCache();
  vi.restoreAllMocks();
});

describe('Jupiter Trigger adapter registration', () => {
  it('exposes 7 trigger actions and 7 trigger reads on jupiterAdapter', () => {
    expect(jupiterAdapter.id).toBe(JUPITER_ADAPTER_ID);
    expect(jupiterAdapter.actions.trigger_register_vault?.kind).toBe('jupiter_trigger_register_vault');
    expect(jupiterAdapter.actions.trigger_single_order?.kind).toBe('jupiter_trigger_single_order');
    expect(jupiterAdapter.actions.trigger_oco_order?.kind).toBe('jupiter_trigger_oco_order');
    expect(jupiterAdapter.actions.trigger_otoco_order?.kind).toBe('jupiter_trigger_otoco_order');
    expect(jupiterAdapter.actions.trigger_edit_order?.kind).toBe('jupiter_trigger_edit_order');
    expect(jupiterAdapter.actions.trigger_cancel_order?.kind).toBe('jupiter_trigger_cancel_order');
    expect(jupiterAdapter.actions.trigger_withdraw_order_funds?.kind).toBe('jupiter_trigger_withdraw_order_funds');
    expect(jupiterAdapter.reads.trigger_auth_challenge).toBeDefined();
    expect(jupiterAdapter.reads.trigger_auth_verify).toBeDefined();
    expect(jupiterAdapter.reads.trigger_auth_status).toBeDefined();
    expect(jupiterAdapter.reads.trigger_vault).toBeDefined();
    expect(jupiterAdapter.reads.trigger_orders).toBeDefined();
    expect(jupiterAdapter.reads.trigger_order_detail).toBeDefined();
    expect(jupiterAdapter.reads.trigger_order_history).toBeDefined();
  });
});

describe('Jupiter Trigger feature flag', () => {
  it('blocks every trigger entry point when feature flag is disabled', async () => {
    const disabled = fakeConfig({ triggerPolicy: { enabled: false } });
    const ctx = makeContext({ config: disabled });
    authenticate(WALLET, disabled);
    await expect(jupiterAdapter.reads.trigger_vault!.read({}, ctx)).rejects.toMatchObject({
      code: 'unsupported_method',
    });
    await expect(jupiterTriggerSingleOrderAction.prepare(singleOrderInput(), ctx)).rejects.toMatchObject({
      code: 'unsupported_method',
    });
  });
});

describe('Jupiter Trigger auth', () => {
  it('requestChallenge returns a normalized challenge and apiHost', async () => {
    const captured: CapturedRequest[] = [];
    const fetchImpl = fakeFetch(() => ({ body: { challenge: 'fake-challenge-string', expiresAt: '2026-05-13T01:00:00.000Z' } }), captured);
    vi.stubGlobal('fetch', fetchImpl);
    const config = fakeConfig();
    const result = await requestJupiterTriggerChallenge(config, { walletAddress: WALLET, challengeType: 'message' });
    expect(result.challenge).toBe('fake-challenge-string');
    expect(result.walletAddress).toBe(WALLET);
    expect(result.challengeType).toBe('message');
    expect(captured[0]?.headers['x-api-key']).toBe('sk-test-jupiter');
  });

  it('verifyChallenge caches a JWT and never returns it', async () => {
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { jwt: 'super-secret-jwt-value', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
    }), captured));
    const config = fakeConfig();
    const status = await verifyJupiterTriggerChallenge(config, {
      walletAddress: WALLET,
      challengeType: 'message',
      signature: 'signed-message-base64',
    });
    expect(status.authenticated).toBe(true);
    expect((status as unknown as Record<string, unknown>).jwt).toBeUndefined();
    // status read also redacts JWT
    const readStatus = readJupiterTriggerAuthStatus(WALLET, config);
    expect(readStatus.authenticated).toBe(true);
    expect((readStatus as unknown as Record<string, unknown>).jwt).toBeUndefined();
  });

  it('reads block when JWT is missing', async () => {
    const config = fakeConfig();
    const ctx = makeContext({ config });
    await expect(readJupiterTriggerVault(config, { walletAddress: WALLET })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(jupiterAdapter.reads.trigger_vault!.read({}, ctx)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('rejects vault read when JWT belongs to a different wallet', async () => {
    const config = fakeConfig();
    storeJupiterTriggerJwt({
      walletAddress: OTHER_WALLET,
      cluster: config.cluster,
      apiHost: API_HOST,
      jwt: 'fake-jwt-other-wallet',
      expiresAt: Date.now() + 60_000,
    });
    await expect(readJupiterTriggerVault(config, { walletAddress: WALLET })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('clamps JWT TTL to 23 hours even if Jupiter advertises 24h+', async () => {
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { jwt: 'jwt', expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() },
    }), []));
    const config = fakeConfig();
    const status = await verifyJupiterTriggerChallenge(config, {
      walletAddress: WALLET,
      challengeType: 'message',
      signature: 'sig',
    });
    expect(status.expiresAt).toBeDefined();
    const ms = new Date(status.expiresAt!).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(23 * 60 * 60 * 1000 + 5_000);
    expect(ms).toBeGreaterThan(22 * 60 * 60 * 1000);
  });
});

describe('Jupiter Trigger vault and orders', () => {
  it('vault read sets custody=privy and surfaces registration status', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { vaultAddress: 'VaultAddress11111111111111111111111111111', balances: { SOL: '0.0', USDC: '12.5' } },
    }), []));
    const snapshot = await readJupiterTriggerVault(config, { walletAddress: WALLET });
    expect(snapshot.custody).toBe('privy');
    expect(snapshot.registered).toBe(true);
    expect(snapshot.vaultAddress).toBe('VaultAddress11111111111111111111111111111');
  });

  it('orders list defaults to state=open', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { orders: [{ orderId: 'ord_1', state: 'open', orderType: 'single' }] },
    }), captured));
    const result = await listJupiterTriggerOrders(config, { walletAddress: WALLET });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].cancellable).toBe(true);
    expect(captured[0]?.url).toContain('state=open');
  });
});

describe('Jupiter Trigger single order prepare', () => {
  it('rejects below 10 USD minimum order value', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    const input = singleOrderInput({ amount: '0.001', triggerPriceUsd: 100 });
    await expect(jupiterTriggerSingleOrderAction.prepare(input, ctx)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects expiration beyond maxOrderLifetimeDays', async () => {
    const config = fakeConfig({ triggerPolicy: { enabled: true, maxOrderLifetimeDays: 7 } });
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await expect(
      jupiterTriggerSingleOrderAction.prepare(singleOrderInput({ expiresAt: farFuture }), ctx),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects slippage above warn threshold without acceptHighSlippage', async () => {
    const config = fakeConfig({ triggerPolicy: { enabled: true, maxOrderLifetimeDays: 30, highSlippageWarnBps: 200 } });
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    await expect(
      jupiterTriggerSingleOrderAction.prepare(singleOrderInput({ slippageBps: 500 }), ctx),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects create order when vault is not registered', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { registered: false } }), []));
    await expect(jupiterTriggerSingleOrderAction.prepare(singleOrderInput(), ctx)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('stores transactionBase64, vault snapshot, and acceptance flags on prepare success', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    let call = 0;
    vi.stubGlobal('fetch', fakeFetch((request) => {
      call += 1;
      if (request.url.endsWith('/vault?walletAddress=' + WALLET)) {
        return { body: { vaultAddress: 'V', registered: true } };
      }
      if (request.url.endsWith('/order/create-single')) {
        return { body: { transaction: 'unsigned-tx-base64' } };
      }
      return { body: {} };
    }, []));
    const result = await jupiterTriggerSingleOrderAction.prepare(singleOrderInput(), ctx);
    expect(result.preview).toMatchObject({
      connectorId: 'jupiter',
      product: 'trigger',
      operation: 'single_order',
      automationWarningAccepted: true,
      custodyWarningAccepted: true,
      refreshAtExecution: true,
      transactionBase64: 'unsigned-tx-base64',
      orderType: 'single',
    });
    // never store JWT, signature, or apiKey
    expect(JSON.stringify(result.preview)).not.toContain('fake-jwt-token');
    expect(JSON.stringify(result.preview)).not.toContain('sk-test-jupiter');
    expect(call).toBeGreaterThanOrEqual(2);
  });
});

describe('Jupiter Trigger single order execute', () => {
  it('re-fetches a fresh deposit tx, signs via ctx.signTransaction, and POSTs signed base64 to Jupiter', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', fakeFetch((request) => {
      if (request.url.includes('/vault')) {
        return { body: { vaultAddress: 'V', registered: true } };
      }
      if (request.url.endsWith('/order/create-single')) {
        return { body: { transaction: 'fresh-deposit-tx-base64' } };
      }
      if (request.url.endsWith('/order/submit')) {
        return { body: { depositTxid: 'on-chain-deposit-txid', orderId: 'new-order-id' } };
      }
      return { body: {} };
    }, captured));
    const signTransaction = vi.fn(async () => 'signed-fresh-tx-base64');
    const ctx = makeContext({ config, signTransaction });
    const prepared = await jupiterTriggerSingleOrderAction.prepare(singleOrderInput(), ctx);
    const stored = await ctx.store.addAction(prepared.addInput);
    const executed = await jupiterTriggerSingleOrderAction.execute(stored, ctx);
    expect(signTransaction).toHaveBeenCalledWith('fresh-deposit-tx-base64', expect.any(String));
    expect(executed.txid).toBe('on-chain-deposit-txid');
    const submitCall = captured.find((c) => c.url.endsWith('/order/submit'));
    expect(submitCall?.body).toMatchObject({ signedTransaction: 'signed-fresh-tx-base64' });
    // signAndBroadcast not used (would double-spend nonce)
    expect(submitCall?.body?.signedTransaction).toBe('signed-fresh-tx-base64');
  });

  it('rejects execute when connected wallet differs from action wallet', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch((request) => {
      if (request.url.includes('/vault')) return { body: { vaultAddress: 'V', registered: true } };
      return { body: { transaction: 'fresh-tx' } };
    }, []));
    const prepared = await jupiterTriggerSingleOrderAction.prepare(singleOrderInput(), ctx);
    const stored = await ctx.store.addAction(prepared.addInput);
    const ctxDifferentWallet = makeContext({
      config,
      backend: {
        async getAddress() {
          return OTHER_WALLET;
        },
        async capabilities() {
          return { address: OTHER_WALLET };
        },
      } as unknown as DAppAdapterContext['backend'],
    });
    authenticate(OTHER_WALLET, config);
    await expect(jupiterTriggerSingleOrderAction.execute(stored, ctxDifferentWallet)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('Jupiter Trigger OCO and OTOCO validation', () => {
  it('OCO rejects sell where take-profit <= stop-loss', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { vaultAddress: 'V', registered: true } }), []));
    await expect(jupiterTriggerOcoOrderAction.prepare({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: '1',
      triggerMint: SOL_MINT,
      takeProfitPriceUsd: 100,
      stopLossPriceUsd: 150,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, ctx)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('OTOCO rejects take-profit <= stop-loss', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { vaultAddress: 'V', registered: true } }), []));
    await expect(jupiterTriggerOtocoOrderAction.prepare({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: '1',
      triggerMint: SOL_MINT,
      entryCondition: 'below',
      entryPriceUsd: 100,
      takeProfitPriceUsd: 90,
      stopLossPriceUsd: 95,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, ctx)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('OCO blocks stop-loss slippage above hard cap unless acceptHighSlippage=true', async () => {
    const config = fakeConfig({
      triggerPolicy: { enabled: true, maxOrderLifetimeDays: 30, highSlippageWarnBps: 300, maxStopLossSlippageBps: 200 },
    });
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { vaultAddress: 'V', registered: true } }), []));
    const input = {
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: '1',
      triggerMint: SOL_MINT,
      takeProfitPriceUsd: 200,
      stopLossPriceUsd: 100,
      stopLossSlippageBps: 500,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    await expect(jupiterTriggerOcoOrderAction.prepare(input, ctx)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('Jupiter Trigger cancel and withdraw eligibility', () => {
  it('cancel rejects when order is not in a cancellable state', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { orderId: 'ord_1', state: 'filled' } }), []));
    await expect(jupiterTriggerCancelOrderAction.prepare({ orderId: 'ord_1' }, ctx)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('withdraw rejects when order has no withdrawable funds', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { orderId: 'ord_2', state: 'open' } }), []));
    await expect(jupiterTriggerWithdrawOrderFundsAction.prepare({ orderId: 'ord_2' }, ctx)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('cancel summary surfaces the "expired funds remain in vault" warning', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { orderId: 'ord_3', state: 'open' } }), []));
    const result = await jupiterTriggerCancelOrderAction.prepare({ orderId: 'ord_3' }, ctx);
    expect(result.addInput.summary).toContain('Expired or cancelled order funds remain in the Jupiter Trigger vault');
    expect(result.preview).toMatchObject({ operation: 'cancel_order' });
  });
});

describe('Jupiter Trigger redaction', () => {
  it('redactJupiterSecrets strips jwt, apikey, bearer, and signedTransaction fields', () => {
    const payload = {
      jwt: 'secret-jwt-value',
      apiKey: 'sk-secret',
      authorization: 'Bearer xyz',
      signedTransaction: 'signed-base64-blob',
      challenge: 'challenge-string',
      orderId: 'preserved-order-id',
    };
    const redacted = redactJupiterSecrets(payload) as Record<string, unknown>;
    expect(redacted.jwt).toBe('[redacted]');
    expect(redacted.apiKey).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.signedTransaction).toBe('[redacted]');
    expect(redacted.challenge).toBe('[redacted]');
    expect(redacted.orderId).toBe('preserved-order-id');
  });
});

describe('Jupiter Trigger edit order', () => {
  it('stores newTriggerPriceUsd/newSlippageBps in params and surfaces the automation+vault warnings', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({ body: { orderId: 'ord_4', state: 'open' } }), []));
    const result = await jupiterTriggerEditOrderAction.prepare({
      orderId: 'ord_4',
      newTriggerPriceUsd: 175,
      newSlippageBps: 150,
    }, ctx);
    expect(result.preview).toMatchObject({
      operation: 'edit_order',
      orderId: 'ord_4',
      newTriggerPriceUsd: 175,
      newSlippageBps: 150,
      automationWarningAccepted: true,
    });
    expect(result.addInput.summary).toContain('Future Trigger fills');
  });
});

describe('Jupiter Trigger register vault prepare', () => {
  it('returns unsigned vault registration transaction in params with custody warning', async () => {
    const config = fakeConfig();
    authenticate(WALLET, config);
    const ctx = makeContext({ config });
    vi.stubGlobal('fetch', fakeFetch(() => ({
      body: { transaction: 'unsigned-vault-register-tx', vault: { vaultAddress: 'V' } },
    }), []));
    const result = await jupiterTriggerRegisterVaultAction.prepare({}, ctx);
    expect(result.preview).toMatchObject({
      operation: 'register_vault',
      transactionBase64: 'unsigned-vault-register-tx',
    });
    expect(result.addInput.summary).toContain('Privy custody');
  });
});

function singleOrderInput(overrides: Partial<{
  amount: string;
  triggerPriceUsd: number;
  triggerCondition: 'above' | 'below';
  slippageBps: number;
  expiresAt: string;
}> = {}) {
  return {
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: overrides.amount ?? '1',
    triggerMint: SOL_MINT,
    triggerCondition: overrides.triggerCondition ?? 'above',
    triggerPriceUsd: overrides.triggerPriceUsd ?? 250,
    slippageBps: overrides.slippageBps ?? 50,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}
