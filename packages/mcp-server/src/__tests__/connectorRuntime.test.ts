import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '@solana/web3.js';
import type { SolanaSigningClient } from '@solana-agent-wallet-adapter/core';

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
import {
  resetOrcaClientFactory,
  setOrcaClientFactory,
  type OrcaClient,
  type OrcaPosition,
  type OrcaWhirlpoolSnapshot,
} from '../adapters/orca/client.js';
import {
  resetMarginfiClientFactory,
  setMarginfiClientFactory,
  type MarginfiAccountDetail,
  type MarginfiAccountSummary,
  type MarginfiBankSnapshot,
  type MarginfiClient,
  type MarginfiHealthComponents,
  type MarginfiHealthPreview,
} from '../adapters/marginfi/client.js';
import {
  resetRaydiumClientFactory,
  setRaydiumClientFactory,
  type RaydiumClient,
  type RaydiumPoolSnapshot,
  type RaydiumPosition,
} from '../adapters/raydium/client.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const ORCA_WHIRLPOOL = '11111111111111111111111111111111';
const ORCA_POSITION_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_POOL = '11111111111111111111111111111111';
const RAYDIUM_POSITION_MINT = 'So11111111111111111111111111111111111111112';

afterEach(() => {
  resetKaminoClientFactory();
  resetOrcaClientFactory();
  resetMarginfiClientFactory();
  resetRaydiumClientFactory();
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

  it('returns normalized Orca Whirlpool position facts', async () => {
    setOrcaClientFactory(() => fakeOrcaClient());
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'orca',
      capability: 'positions',
      walletAddress: WALLET,
      whirlpoolAddress: ORCA_WHIRLPOOL,
    });

    expect(result.connector).toMatchObject({ id: 'orca', name: 'Orca' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'orca',
        label: 'Orca positions',
        tone: 'good',
        source: 'connector',
      }),
      expect.objectContaining({
        label: expect.stringContaining('Position'),
        value: expect.stringContaining('ticks 56 to 80'),
      }),
    ]));
  });

  it('prepares an Orca collect-fees action through the service', async () => {
    setOrcaClientFactory(() => fakeOrcaClient());
    const service = newService();

    const result = await service.prepareOrcaCollectFees({
      positionMint: ORCA_POSITION_MINT,
      whirlpoolAddress: ORCA_WHIRLPOOL,
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'orca_collect_fees',
      walletAddress: '11111111111111111111111111111111',
      params: {
        connectorId: 'orca',
        positionMint: ORCA_POSITION_MINT,
        whirlpoolAddress: ORCA_WHIRLPOOL,
        refreshAtExecution: true,
      },
    });
  });

  it('returns normalized Raydium pool facts', async () => {
    setRaydiumClientFactory(() => fakeRaydiumClient());
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'raydium',
      capability: 'markets',
      poolId: RAYDIUM_POOL,
      poolType: 'clmm',
    });

    expect(result.connector).toMatchObject({ id: 'raydium', name: 'Raydium' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'raydium',
        label: 'Raydium CLMM pool',
        tone: 'good',
        source: 'connector',
      }),
      expect.objectContaining({
        label: 'CLMM tick',
        value: '64',
      }),
    ]));
  });

  it('prepares a Raydium harvest action through the service', async () => {
    setRaydiumClientFactory(() => fakeRaydiumClient());
    const service = newService();

    const result = await service.prepareRaydiumHarvest({
      farmId: RAYDIUM_POOL,
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'raydium_harvest',
      walletAddress: '11111111111111111111111111111111',
      params: {
        connectorId: 'raydium',
        farmId: RAYDIUM_POOL,
        refreshAtExecution: true,
      },
    });
  });

  it('returns normalized MarginFi health preview facts', async () => {
    setMarginfiClientFactory(() => fakeMarginfiClient());
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'marginfi',
      capability: 'borrow',
      token: 'USDC',
      amount: '1',
      marginfiAccount: '11111111111111111111111111111111',
    });

    expect(result.connector).toMatchObject({ id: 'marginfi', name: 'MarginFi' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'marginfi',
        label: 'MarginFi health preview',
        tone: 'good',
        source: 'connector',
      }),
      expect.objectContaining({
        label: 'Health after',
        value: '100 assets · 40 liabilities · 60 net · 2.5',
      }),
    ]));
  });

  it('prepares a MarginFi deposit action through the service', async () => {
    setMarginfiClientFactory(() => fakeMarginfiClient());
    const service = newService();

    const result = await service.prepareMarginfiDeposit({
      token: 'USDC',
      amount: '2',
      marginfiAccount: '11111111111111111111111111111111',
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'marginfi_deposit',
      walletAddress: '11111111111111111111111111111111',
      params: {
        connectorId: 'marginfi',
        operation: 'deposit',
        bankMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '2',
        amountRaw: '2000000',
      },
    });
  });

  it('returns normalized Jupiter preview facts and redacts secrets from payloads', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-secret-jupiter');
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://jupiter.example/ultra/v1/order');
      expect(requestUrl.searchParams.get('amount')).toBe('100000000');
      expect(requestUrl.searchParams.get('slippageBps')).toBe('100');
      return jsonResponse({
        mode: 'ultra',
        router: 'iris',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '100000000',
        outAmount: '123456',
        otherAmountThreshold: '120000',
        slippageBps: 50,
        priceImpact: '0.001',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM', ammKey: 'amm', inputMint: 'in', outputMint: 'out', inAmount: '1', outAmount: '2' }, percent: 100 }],
        feeBps: 2,
        feeMint: 'So11111111111111111111111111111111111111112',
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
      expect.objectContaining({ connectorId: 'jupiter', label: 'Jupiter Swap API v2 preview', tone: 'good' }),
      expect.objectContaining({ label: 'Router', value: 'iris · ultra', tone: 'good' }),
      expect.objectContaining({ label: 'Slippage', value: '50 bps', tone: 'good' }),
      expect.objectContaining({ label: 'Fees', value: '2 bps in So11...1112' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('sk-test-secret-jupiter');
  });

  it('prepares Jupiter swaps with refresh metadata and no transaction bytes', async () => {
    const service = newService();

    const result = await service.prepareSwap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: 50,
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'swap',
      params: {
        connectorId: 'jupiter',
        product: 'swap',
        operation: 'swap',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '0.01',
        amountRaw: '10000000',
        slippageBps: 50,
        refreshAtExecution: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain('transactionBase64');
    expect(JSON.stringify(result)).not.toContain('base64-transaction');
  });

  it('blocks Jupiter swap slippage above the configured cap', async () => {
    const service = newService();

    await expect(service.prepareSwap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: 10_000,
    })).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('exceeds configured cap'),
    });
  });

  it('treats Jupiter execute failure payloads as failed and does not echo signed transactions', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain('signed-transaction-secret');
      return jsonResponse({
        status: 'Failed',
        signature: 'failed_sig',
        code: 'ROUTE_EXPIRED',
        error: 'route expired',
        signedTransaction: 'signed-transaction-secret',
      });
    }));
    const service = newService();

    await expect(service.executeSignedSwap({
      signedTransaction: 'signed-transaction-secret',
      requestId: 'req_jupiter_test',
    })).rejects.toMatchObject({
      code: 'wallet_unreachable',
      message: expect.stringContaining('ROUTE_EXPIRED'),
    });
    await expect(service.executeSignedSwap({
      signedTransaction: 'signed-transaction-secret',
      requestId: 'req_jupiter_test',
    })).rejects.not.toMatchObject({
      message: expect.stringContaining('signed-transaction-secret'),
    });
  });

  it('returns deterministic missing-capability errors for unavailable connectors', async () => {
    const service = newService();

    await expect(service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'positions',
    })).rejects.toMatchObject({
      code: 'unsupported_method',
      message: expect.stringContaining('Jupiter does not expose positions read capability'),
    });
  });

  it('executes Blink prepared actions through wallet signing and RPC broadcast', async () => {
    vi.stubEnv('AGENT_WALLET_SKIP_SIMULATION', '1');
    const store = inMemoryStore();
    const signedInputs: string[] = [];
    const sentTransactions: string[] = [];
    const client = {
      async signTransaction(transactionBase64: string, options: { cluster: string; summary?: string }) {
        signedInputs.push(transactionBase64);
        expect(options).toMatchObject({
          cluster: 'mainnet-beta',
          summary: 'Meteora: Claim fees',
        });
        return { signature: Buffer.from('signed-blink-transaction').toString('base64') };
      },
    } as unknown as SolanaSigningClient;
    const connection = {
      async sendRawTransaction(bytes: Buffer) {
        sentTransactions.push(bytes.toString('utf8'));
        return 'txid_blink';
      },
    } as unknown as Connection;
    const service = new AgentWalletActionService({
      backend: createMockBackend(),
      config: fakeConfig(),
      connection,
      client,
      preparedActions: store,
    });
    const action = await store.addAction({
      kind: 'blink_action',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'mainnet-beta',
      summary: 'Meteora: Claim fees',
      params: {
        blinkUrl: 'https://example.com/action',
        transactionBase64: 'base64-blink-transaction',
        connectorActionSource: 'blink',
      },
    });

    const result = await service.executePreparedAction(action.id);

    expect(signedInputs).toEqual(['base64-blink-transaction']);
    expect(sentTransactions).toEqual(['signed-blink-transaction']);
    expect(result.preparedAction).toMatchObject({
      id: action.id,
      status: 'approved',
      txid: 'txid_blink',
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

function fakeOrcaClient(): OrcaClient {
  const snapshot: OrcaWhirlpoolSnapshot = {
    whirlpoolAddress: ORCA_WHIRLPOOL,
    programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    configAddress: '2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ',
    tokenMintA: 'So11111111111111111111111111111111111111112',
    tokenMintB: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tickSpacing: 8,
    feeRateBps: 30,
    currentTickIndex: 64,
    currentPrice: '150',
    sqrtPrice: '123456',
    liquidity: '100000',
    rewardMints: [],
    asOfSlot: 280_000_000,
  };
  const position: OrcaPosition = {
    positionMint: ORCA_POSITION_MINT,
    whirlpoolAddress: ORCA_WHIRLPOOL,
    tickLowerIndex: 56,
    tickUpperIndex: 80,
    currentTickIndex: 64,
    inRange: true,
    liquidity: '5000',
    feesOwed: [{ mint: snapshot.tokenMintA, amount: '0.001', symbol: 'SOL' }],
    rewardsOwed: [],
  };
  const preview = {
    whirlpoolAddress: ORCA_WHIRLPOOL,
    positionMint: ORCA_POSITION_MINT,
    tokenMints: [snapshot.tokenMintA, snapshot.tokenMintB],
    tokenAmounts: [{ mint: snapshot.tokenMintA, amount: '0.001', symbol: 'SOL' }],
    tickRange: { lowerTick: 56, upperTick: 80 },
    quote: { fees: '0.001 SOL' },
  };
  return {
    async getWhirlpoolSnapshot() {
      return snapshot;
    },
    async getWalletPositions(_connection, walletAddress, whirlpoolAddress) {
      return {
        walletAddress,
        ...(whirlpoolAddress !== undefined && { whirlpoolAddress }),
        positions: [position],
        totals: { positions: 1, inRange: 1, outOfRange: 0 },
      };
    },
    async getPositionDetail() {
      return position;
    },
    async previewIncreaseLiquidity() {
      return preview;
    },
    async previewDecreaseLiquidity() {
      return preview;
    },
    async previewCollectFees() {
      return preview;
    },
    async previewCollectRewards() {
      return preview;
    },
    async buildIncreaseLiquidityTransaction() {
      return { transactionBase64: 'base64-increase', preview };
    },
    async buildDecreaseLiquidityTransaction() {
      return { transactionBase64: 'base64-decrease', preview };
    },
    async buildCollectFeesTransaction() {
      return { transactionBase64: 'base64-fees', preview };
    },
    async buildCollectRewardsTransaction() {
      return { transactionBase64: 'base64-rewards', preview };
    },
  };
}

function fakeRaydiumClient(): RaydiumClient {
  const snapshot: RaydiumPoolSnapshot = {
    poolId: RAYDIUM_POOL,
    poolType: 'clmm',
    programId: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    mintA: { mint: 'So11111111111111111111111111111111111111112', decimals: 9, symbol: 'SOL' },
    mintB: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
    price: '150',
    liquidity: '100000',
    tvl: '500000',
    feeRateBps: 25,
    tickCurrent: 64,
    tickSpacing: 8,
    rewardMints: [],
    asOfSlot: 280_000_000,
  };
  const position: RaydiumPosition = {
    positionType: 'clmm',
    poolType: 'clmm',
    poolId: RAYDIUM_POOL,
    positionMint: RAYDIUM_POSITION_MINT,
    tickLower: 56,
    tickUpper: 80,
    currentTick: 64,
    inRange: true,
    liquidity: '5000',
    feesOwed: [{ mint: snapshot.mintA.mint, amount: '0.001', symbol: 'SOL' }],
    rewardsOwed: [],
  };
  const preview = {
    poolId: RAYDIUM_POOL,
    poolType: 'clmm' as const,
    positionMint: RAYDIUM_POSITION_MINT,
    tokenMints: [snapshot.mintA.mint, snapshot.mintB.mint],
    tokenAmounts: [{ mint: snapshot.mintA.mint, amount: '0.001', symbol: 'SOL' }],
    tickRange: { lowerTick: 56, upperTick: 80 },
    rewardMints: [],
  };
  return {
    async getPoolSnapshot() {
      return snapshot;
    },
    async getWalletPositions(_connection, walletAddress, input) {
      return {
        walletAddress,
        ...(input?.poolId !== undefined && { poolId: input.poolId }),
        positions: [position],
        totals: { positions: 1, clmmPositions: 1, cpmmPositions: 0, farmPositions: 0 },
      };
    },
    async getPositionDetail() {
      return position;
    },
    async previewAddLiquidity() {
      return preview;
    },
    async previewRemoveLiquidity() {
      return preview;
    },
    async previewCollectFees() {
      return preview;
    },
    async previewFarmStake(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: snapshot.mintA.mint,
        tokenAmounts: [{ mint: snapshot.mintA.mint, amount: input.amount ?? '0', symbol: 'SOL' }],
        rewardMints: [snapshot.mintB.mint],
      };
    },
    async previewFarmUnstake(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: snapshot.mintA.mint,
        tokenAmounts: [{ mint: snapshot.mintA.mint, amount: input.amount ?? '0', symbol: 'SOL' }],
        rewardMints: [snapshot.mintB.mint],
      };
    },
    async previewHarvest(_connection, input) {
      return {
        farmId: input.farmId,
        lpMint: snapshot.mintA.mint,
        rewardMints: [snapshot.mintB.mint],
        quote: { operation: 'harvest' },
      };
    },
    async buildAddLiquidityTransaction() {
      return { transactionBase64: 'base64-raydium-add', programIds: [snapshot.programId], preview };
    },
    async buildRemoveLiquidityTransaction() {
      return { transactionBase64: 'base64-raydium-remove', programIds: [snapshot.programId], preview };
    },
    async buildCollectFeesTransaction() {
      return { transactionBase64: 'base64-raydium-fees', programIds: [snapshot.programId], preview };
    },
    async buildFarmStakeTransaction() {
      return { transactionBase64: 'base64-raydium-stake', programIds: [snapshot.programId], preview };
    },
    async buildFarmUnstakeTransaction() {
      return { transactionBase64: 'base64-raydium-unstake', programIds: [snapshot.programId], preview };
    },
    async buildHarvestTransaction() {
      return { transactionBase64: 'base64-raydium-harvest', programIds: [snapshot.programId], preview };
    },
  };
}

function fakeMarginfiClient(): MarginfiClient {
  const health = marginfiHealth();
  const bank: MarginfiBankSnapshot = {
    bankAddress: '9xQeWvG816bUx9EPfzywVzQJSPYkF1f1P9Gm2Zx8xQeW',
    bankMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenSymbol: 'USDC',
    decimals: 6,
    depositApy: 4.2,
    borrowApr: 7.1,
    utilization: 62,
    depositCapacity: '500000',
    borrowCapacity: '300000',
  };
  const account: MarginfiAccountSummary = {
    marginfiAccount: '11111111111111111111111111111111',
    authority: WALLET,
    activeBalances: 1,
    health,
  };
  const detail: MarginfiAccountDetail = {
    ...account,
    positions: [{
      bankAddress: bank.bankAddress,
      bankMint: bank.bankMint,
      tokenSymbol: bank.tokenSymbol,
      decimals: bank.decimals,
      suppliedAmount: '5',
      borrowedAmount: '2',
    }],
  };
  return {
    async getBankSnapshot() {
      return bank;
    },
    async getWalletAccounts() {
      return [account];
    },
    async getAccountDetail() {
      return detail;
    },
    async previewHealth(_connection, input): Promise<MarginfiHealthPreview> {
      const amount = input.amount ?? '1';
      return {
        operation: input.operation,
        marginfiAccount: account.marginfiAccount,
        bankAddress: bank.bankAddress,
        bankMint: bank.bankMint,
        tokenSymbol: bank.tokenSymbol,
        amount,
        amountRaw: marginfiRawAmount(amount, bank.decimals),
        before: health,
        after: health,
        minHealthRatio: input.minHealthRatio ?? 1.1,
        blocked: false,
        warnings: [],
        simulatedAt: '2026-05-12T00:00:00.000Z',
      };
    },
    async buildActionTransaction(_connection, input) {
      const amount = input.amount ?? '1';
      return {
        transactionBase64: Buffer.from('marginfi-runtime-test').toString('base64'),
        marginfiAccount: account.marginfiAccount,
        bankSnapshot: bank,
        amount,
        amountRaw: marginfiRawAmount(amount, bank.decimals),
      };
    },
  };
}

function marginfiHealth(): MarginfiHealthComponents {
  return {
    assets: '100',
    liabilities: '40',
    netValue: '60',
    healthRatio: 2.5,
    healthRatioText: '2.5',
    healthy: true,
  };
}

function marginfiRawAmount(amount: string, decimals: number): string {
  const [whole = '0', fractional = ''] = amount.trim().split('.');
  return `${whole}${fractional.padEnd(decimals, '0').slice(0, decimals)}`.replace(/^0+(?=\d)/, '') || '0';
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
