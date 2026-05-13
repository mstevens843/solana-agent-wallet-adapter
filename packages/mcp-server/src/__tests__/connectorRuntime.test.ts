import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '@solana/web3.js';

import { AgentWalletActionService } from '../actionService.js';
import { DEFAULT_CONFIG, type AgentWalletConfig } from '../config.js';
import { createMockBackend } from '../mockBackend.js';
import type {
  AddPreparedActionInput,
  AddRecurringPaymentInput,
  PreparedAction,
  PreparedActionStore,
  RecurringPayment,
} from '../preparedActions.js';
import {
  resetKaminoClientFactory,
  setKaminoClientFactory,
  type KaminoClient,
  type KaminoPosition,
  type KaminoReserveSnapshot,
} from '../adapters/kamino/client.js';
import { clearReserveSnapshotCache } from '../adapters/kamino/reserveSnapshot.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';

afterEach(() => {
  resetKaminoClientFactory();
  clearReserveSnapshotCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AgentWalletActionService connector runtime', () => {
  it('returns normalized Kamino position facts', async () => {
    setKaminoClientFactory(() => fakeKaminoClient({
      positions: [{
        reserveAddress: 'ReserveAddressForSolPlaceholder111111111111',
        reserveMint: 'So11111111111111111111111111111111111111112',
        reserveSymbol: 'SOL',
        decimals: 9,
        suppliedAmount: '2',
        currentValue: '2.1',
        earnedInterest: '0.1',
        supplyApy: 5.4,
        withdrawAvailable: '2.1',
        asOfSlot: 280_000_000,
      }],
    }));
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'kamino',
      capability: 'positions',
      walletAddress: WALLET,
    });

    expect(result.connector).toMatchObject({ id: 'kamino', name: 'Kamino Finance' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'kamino',
        label: 'Kamino positions',
        tone: 'good',
        source: 'connector',
      }),
      expect.objectContaining({
        label: 'SOL supplied',
        value: '2 supplied · 2.1 current · 0.1 earned',
      }),
    ]));
  });

  it('returns normalized Jupiter preview facts and redacts secrets from payloads', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-secret-jupiter');
      return jsonResponse({
        mode: 'ultra',
        router: 'jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '100000000',
        outAmount: '123456',
        otherAmountThreshold: '120000',
        slippageBps: 50,
        priceImpact: '0.001',
        requestId: 'req_jupiter_test',
        transaction: 'base64-transaction',
        apiKey: 'sk-test-secret-jupiter',
      });
    }));
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'swap',
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.1',
    });

    expect(result.connector).toMatchObject({ id: 'jupiter' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ connectorId: 'jupiter', label: 'Jupiter preview', tone: 'good' }),
      expect.objectContaining({ label: 'Slippage', value: '50 bps', tone: 'good' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('sk-test-secret-jupiter');
  });

  it('returns deterministic missing-capability errors for unavailable connectors', async () => {
    const service = newService();

    await expect(service.connectorReadFacts({
      connectorId: 'meteora',
      capability: 'positions',
    })).rejects.toMatchObject({
      code: 'unsupported_method',
      message: expect.stringContaining('Meteora does not expose positions read capability'),
    });
  });
});

function newService(): AgentWalletActionService {
  return new AgentWalletActionService({
    backend: createMockBackend(),
    config: fakeConfig(),
    connection: fakeConnection(),
    preparedActions: inMemoryStore(),
  });
}

function fakeConfig(): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'mainnet-beta',
    rpcUrl: 'https://api.fake',
    jupiter: {
      baseUrl: 'https://jupiter.example/ultra/v1',
      apiKeyEnv: 'JUPITER_API_KEY',
    },
  };
}

function fakeConnection(): Connection {
  return {
    async getParsedAccountInfo() {
      return { value: null };
    },
  } as unknown as Connection;
}

function fakeKaminoClient(input: {
  snapshot?: Partial<KaminoReserveSnapshot>;
  positions?: KaminoPosition[];
} = {}): KaminoClient {
  const snapshot: KaminoReserveSnapshot = {
    reserveAddress: 'ReserveAddressForSolPlaceholder111111111111',
    reserveMint: 'So11111111111111111111111111111111111111112',
    reserveSymbol: 'SOL',
    decimals: 9,
    supplyApy: 5.4,
    borrowApy: 7.2,
    utilization: 68,
    totalSupply: '10000',
    totalBorrow: '6800',
    depositLimit: '50000',
    depositLimitRemaining: '40000',
    withdrawalDelaySec: 0,
    withdrawAvailable: '3200',
    lastUpdateSlot: 280_000_000,
    asOfBlockTime: 1_770_000_000,
    ...input.snapshot,
  };
  return {
    async getReserveSnapshot() {
      return snapshot;
    },
    async listReserveSnapshots() {
      return [snapshot];
    },
    async getPositions() {
      return input.positions ?? [];
    },
    async buildDepositTransaction() {
      throw new Error('not used in connector runtime tests');
    },
    async buildWithdrawTransaction() {
      throw new Error('not used in connector runtime tests');
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function inMemoryStore(): PreparedActionStore {
  const actions: PreparedAction[] = [];
  const recurringPayments: RecurringPayment[] = [];
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
      if (!current) throw new Error(`Unknown action: ${id}`);
      actions[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
      return actions[index]!;
    },
    async deleteAction(id) {
      const before = actions.length;
      const next = actions.filter((entry) => entry.id !== id);
      actions.length = 0;
      actions.push(...next);
      return actions.length !== before;
    },
    async archiveAction(id) {
      const action = actions.find((entry) => entry.id === id);
      if (!action) throw new Error(`Unknown action: ${id}`);
      return action;
    },
    async addRecurringPayment(input: AddRecurringPaymentInput): Promise<RecurringPayment> {
      const now = new Date().toISOString();
      const recurring: RecurringPayment = {
        id: `rp_${recurringPayments.length + 1}`,
        ...input,
        status: input.status ?? 'active',
        startAt: input.startAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      recurringPayments.push(recurring);
      return recurring;
    },
    async listRecurringPayments() {
      return [...recurringPayments];
    },
    async listRecurringPaymentViews() {
      return [];
    },
    async updateRecurringPayment(id, patch) {
      const index = recurringPayments.findIndex((entry) => entry.id === id);
      const current = recurringPayments[index];
      if (!current) throw new Error(`Unknown recurring payment: ${id}`);
      recurringPayments[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
      return recurringPayments[index]!;
    },
    async deleteRecurringPayment(id) {
      const before = recurringPayments.length;
      const next = recurringPayments.filter((entry) => entry.id !== id);
      recurringPayments.length = 0;
      recurringPayments.push(...next);
      return recurringPayments.length !== before;
    },
    async materializeDueRecurring() {
      return [];
    },
    async listReceipts() {
      return [];
    },
  };
}
