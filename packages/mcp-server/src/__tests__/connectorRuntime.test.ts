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
import {
  resetMarinadeClientFactory,
  setMarinadeClientFactory,
  type MarinadeClient,
  type MarinadeQuoteInput,
} from '../adapters/marinade/client.js';
import { MARINADE_PROGRAM_ID, MSOL_MINT } from '../adapters/marinade/constants.js';
import {
  resetWormholeClientFactory,
  setWormholeClientFactory,
  type WormholeBuildTransferInput,
  type WormholeClient,
  type WormholeQuoteInput,
  type WormholeQuoteSnapshot,
  type WormholeTransferStatus,
} from '../adapters/wormhole/client.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const ORCA_WHIRLPOOL = '11111111111111111111111111111111';
const ORCA_POSITION_MINT = 'So11111111111111111111111111111111111111112';
const RAYDIUM_POOL = '11111111111111111111111111111111';
const RAYDIUM_POSITION_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WORMHOLE_DESTINATION = '0x1111111111111111111111111111111111111111';
const WORMHOLE_DESTINATION_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

afterEach(() => {
  resetKaminoClientFactory();
  resetOrcaClientFactory();
  resetMarginfiClientFactory();
  resetRaydiumClientFactory();
  resetMarinadeClientFactory();
  resetWormholeClientFactory();
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

  it('returns normalized Marinade wallet position facts', async () => {
    setMarinadeClientFactory(() => fakeMarinadeClient());
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'marinade',
      capability: 'positions',
      walletAddress: WALLET,
    });

    expect(result.connector).toMatchObject({ id: 'marinade', name: 'Marinade' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'marinade',
        label: 'mSOL balance',
        value: '1 mSOL',
        tone: 'good',
      }),
      expect.objectContaining({
        label: 'Unstake tickets',
        value: '1 found · 1 claimable',
      }),
    ]));
  });

  it('prepares a Marinade liquid-stake action through the service', async () => {
    setMarinadeClientFactory(() => fakeMarinadeClient());
    const service = newService();

    const result = await service.prepareMarinadeLiquidStake({
      solAmount: '0.5',
      minMsolAmount: '0.45',
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'marinade_liquid_stake',
      walletAddress: '11111111111111111111111111111111',
      params: {
        connectorId: 'marinade',
        operation: 'liquid_stake',
        solAmount: '0.5',
        solAmountRaw: '500000000',
        minMsolAmountRaw: '450000000',
        refreshAtExecution: true,
      },
    });
  });

  it('returns normalized Wormhole bridge quote facts', async () => {
    const state = fakeWormholeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const service = newService();

    const result = await service.connectorReadFacts({
      connectorId: 'wormhole',
      capability: 'bridge',
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: WORMHOLE_DESTINATION,
    });

    expect(result.connector).toMatchObject({ id: 'wormhole', name: 'Wormhole' });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectorId: 'wormhole',
        label: 'Wormhole quote',
        tone: 'good',
      }),
      expect.objectContaining({
        label: 'Bridge fee',
        value: '0.01 USDC',
      }),
    ]));
    expect(state.quoteCalls).toHaveLength(1);
  });

  it('prepares a Wormhole transfer through the service without signing', async () => {
    const state = fakeWormholeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const service = newService();

    const result = await service.prepareWormholeTransfer({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: WORMHOLE_DESTINATION,
      maxBridgeFee: '0.1',
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'wormhole_transfer',
      walletAddress: '11111111111111111111111111111111',
      params: {
        connectorId: 'wormhole',
        operation: 'transfer',
        amountRaw: '10000000',
        destinationChain: 'Base',
        destinationAddress: WORMHOLE_DESTINATION,
        destinationToken: WORMHOLE_DESTINATION_TOKEN,
        maxBridgeFee: '0.1',
        refreshAtExecution: true,
      },
    });
    expect(state.transferBuilds).toHaveLength(0);
  });

  it('returns normalized Jupiter preview facts and redacts secrets from payloads', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-secret-jupiter');
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://jupiter.example/swap/v2/order');
      expect(requestUrl.searchParams.get('amount')).toBe('10000000');
      expect(requestUrl.searchParams.get('slippageBps')).toBe('100');
      return jsonResponse({
        mode: 'ultra',
        router: 'iris',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        inAmount: '10000000',
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
      amount: '0.01',
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

  it('allows explicit zero slippage while preserving the configured cap', async () => {
    const service = newService();

    const result = await service.prepareSwap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: 0,
    });

    expect(result.preparedAction).toMatchObject({
      kind: 'swap',
      params: {
        connectorId: 'jupiter',
        slippageBps: 0,
      },
    });
  });

  it('executes a Jupiter Swap API v2 order through wallet signing and /execute', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    const unsignedTransaction = 'dW5zaWduZWQtdHJhbnNhY3Rpb24=';
    const signedTransaction = 'c2lnbmVkLXRyYW5zYWN0aW9u';
    const requests: Array<{ path: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      requests.push({ path: requestUrl.pathname, body: typeof init?.body === 'string' ? init.body : undefined });
      if (requestUrl.pathname.endsWith('/order')) {
        expect(requestUrl.origin + requestUrl.pathname).toBe('https://jupiter.example/swap/v2/order');
        expect(requestUrl.searchParams.get('inputMint')).toBe('So11111111111111111111111111111111111111112');
        expect(requestUrl.searchParams.get('outputMint')).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        expect(requestUrl.searchParams.get('amount')).toBe('10000000');
        expect(requestUrl.searchParams.get('taker')).toBe('11111111111111111111111111111111');
        return jsonResponse({
          mode: 'ultra',
          router: 'iris',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inAmount: '10000000',
          outAmount: '123456',
          otherAmountThreshold: '120000',
          slippageBps: 50,
          requestId: 'req_jupiter_test',
          transaction: unsignedTransaction,
          lastValidBlockHeight: '12345',
        });
      }
      expect(requestUrl.origin + requestUrl.pathname).toBe('https://jupiter.example/swap/v2/execute');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain(signedTransaction);
      expect(String(init?.body)).toContain('req_jupiter_test');
      return jsonResponse({
        status: 'Success',
        signature: 'tx-jupiter-success',
        code: 0,
        inputAmountResult: '10000000',
        outputAmountResult: '123456',
      });
    }));
    const signedInputs: string[] = [];
    const service = newService({
      client: {
        async signTransaction(transactionBase64: string) {
          signedInputs.push(transactionBase64);
          return { signature: signedTransaction };
        },
      } as unknown as SolanaSigningClient,
    });

    const result = await service.swap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
      slippageBps: 50,
    });

    expect(signedInputs).toEqual([unsignedTransaction]);
    expect(requests.map((request) => request.path)).toEqual(['/swap/v2/order', '/swap/v2/execute']);
    expect(result).toMatchObject({
      txid: 'tx-jupiter-success',
      status: 'Success',
      execution: {
        status: 'Success',
        code: 0,
        inputAmountResult: '10000000',
        outputAmountResult: '123456',
      },
    });
    expect(JSON.stringify(result)).not.toContain(unsignedTransaction);
    expect(JSON.stringify(result)).not.toContain(signedTransaction);
  });

  it('rejects Jupiter orders that do not include a transaction before signing', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      mode: 'manual',
      router: 'iris',
      requestId: 'req_jupiter_test',
      errorMessage: 'No transaction could be built for this order.',
    })));
    const signedInputs: string[] = [];
    const service = newService({
      client: {
        async signTransaction(transactionBase64: string) {
          signedInputs.push(transactionBase64);
          return { signature: 'signed-transaction' };
        },
      } as unknown as SolanaSigningClient,
    });

    await expect(service.swap({
      inputToken: 'SOL',
      outputToken: 'USDC',
      amount: '0.01',
    })).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('No transaction could be built'),
    });
    expect(signedInputs).toEqual([]);
  });

  it('refreshes prepared Jupiter swaps and enforces the prepared minimum output before signing', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-secret-jupiter');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      mode: 'ultra',
      router: 'iris',
      requestId: 'req_jupiter_test',
      transaction: 'dW5zaWduZWQtdHJhbnNhY3Rpb24=',
      outAmount: '119999',
      otherAmountThreshold: '119000',
    })));
    const store = inMemoryStore();
    const action = await store.addAction({
      kind: 'swap',
      walletAddress: '11111111111111111111111111111111',
      cluster: 'mainnet-beta',
      summary: 'Swap 0.01 SOL to USDC',
      params: {
        connectorId: 'jupiter',
        inputToken: 'SOL',
        outputToken: 'USDC',
        amount: '0.01',
        slippageBps: 50,
        quoteSnapshot: {
          otherAmountThreshold: '120000',
        },
      },
    });
    const signedInputs: string[] = [];
    const service = newService({
      preparedActions: store,
      client: {
        async signTransaction(transactionBase64: string) {
          signedInputs.push(transactionBase64);
          return { signature: 'signed-transaction' };
        },
      } as unknown as SolanaSigningClient,
    });

    await expect(service.executePreparedAction(action.id)).rejects.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('below the prepared minimum output'),
    });
    expect(signedInputs).toEqual([]);
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

    await service.connectorReadFacts({
      connectorId: 'jupiter',
      capability: 'positions',
    }).then(
      () => {
        throw new Error('Expected Jupiter positions read to fail.');
      },
      (err: unknown) => {
        expect(err).toMatchObject({ code: 'unsupported_method' });
        expect(err instanceof Error ? err.message : String(err)).toContain('positions');
      },
    );
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

function newService(input: {
  client?: SolanaSigningClient;
  preparedActions?: PreparedActionStore;
} = {}): AgentWalletActionService {
  return new AgentWalletActionService({
    backend: createMockBackend(),
    config: fakeConfig(),
    connection: fakeConnection(),
    preparedActions: input.preparedActions ?? inMemoryStore(),
    ...(input.client !== undefined && { client: input.client }),
  });
}

function fakeConfig(): AgentWalletConfig {
  return {
    ...DEFAULT_CONFIG,
    cluster: 'mainnet-beta',
    rpcUrl: 'https://api.fake',
    jupiter: {
      baseUrl: 'https://jupiter.example/swap/v2',
      swapBaseUrl: 'https://jupiter.example/swap/v2',
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

function fakeMarinadeClient(): MarinadeClient {
  return {
    async getStateSnapshot() {
      return {
        connectorId: 'marinade',
        stateAddress: '8szGkuLTAuxqvFV8fYCoDxN8XrJLK9u2kjuYKxE6V5V',
        programId: MARINADE_PROGRAM_ID,
        msolMint: MSOL_MINT,
        msolPrice: '1.05',
        totalVirtualStakedSol: '1000000',
        availableReserveSol: '10000',
        warnings: [],
      };
    },
    async getWalletPositions(_connection, walletAddress) {
      return {
        connectorId: 'marinade',
        walletAddress,
        msolMint: MSOL_MINT,
        msolBalanceRaw: '1000000000',
        msolBalance: '1',
        estimatedSolValue: '1.05',
        nativeStakeAccounts: [],
        unstakeTickets: [{
          ticketAccount: '11111111111111111111111111111111',
          solAmount: '0.5',
          lamports: '500000000',
          status: 'claimable',
        }],
        warnings: [],
      };
    },
    async getStakeAccounts() {
      return [];
    },
    async getUnstakeTickets() {
      return [{
        ticketAccount: '11111111111111111111111111111111',
        solAmount: '0.5',
        lamports: '500000000',
        status: 'claimable',
      }];
    },
    async getQuote(_connection, input: MarinadeQuoteInput) {
      return {
        connectorId: 'marinade',
        operation: input.operation,
        inputAmount: '0.5',
        inputAmountRaw: input.inputAmountRaw.toString(),
        outputAmount: input.operation === 'liquid_stake' ? '0.47' : '0.51',
        outputAmountRaw: input.operation === 'liquid_stake' ? '470000000' : '510000000',
        minOutputAmountRaw: input.minOutputAmountRaw?.toString(),
        route: 'marinade',
        warnings: [],
      };
    },
    async buildLiquidStakeTransaction() {
      return {
        transactionBase64: Buffer.from('marinade-runtime-test').toString('base64'),
        programIds: [MARINADE_PROGRAM_ID],
        preview: { operation: 'liquid_stake' },
      };
    },
    async buildDelayedUnstakeTransaction() {
      return {
        transactionBase64: Buffer.from('marinade-runtime-test').toString('base64'),
        programIds: [MARINADE_PROGRAM_ID],
        preview: { operation: 'delayed_unstake' },
      };
    },
    async buildClaimDelayedUnstakeTransaction() {
      return {
        transactionBase64: Buffer.from('marinade-runtime-test').toString('base64'),
        programIds: [MARINADE_PROGRAM_ID],
        preview: { operation: 'claim_delayed_unstake' },
      };
    },
  };
}

interface FakeWormholeRuntimeState {
  quote: WormholeQuoteSnapshot;
  status: WormholeTransferStatus;
  quoteCalls: Array<WormholeQuoteInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
  transferBuilds: Array<WormholeBuildTransferInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
}

function fakeWormholeState(input: Partial<FakeWormholeRuntimeState> = {}): FakeWormholeRuntimeState {
  return {
    quote: {
      quoteId: 'quote-runtime-wormhole',
      sourceChain: 'Solana',
      destinationChain: 'Base',
      sourceMint: USDC_MINT,
      destinationToken: WORMHOLE_DESTINATION_TOKEN,
      destinationAddress: WORMHOLE_DESTINATION,
      amount: '10',
      amountRaw: '10000000',
      routeType: 'token_bridge',
      mode: 'automatic',
      estimatedDestinationAmount: '9.99',
      bridgeFee: '0.01',
      bridgeFeeToken: 'USDC',
      manualRedemptionRequired: false,
      relayerSupported: true,
      programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
      asOfIso: new Date().toISOString(),
    },
    status: {
      transferId: 'wh-runtime-transfer',
      sourceChain: 'Solana',
      destinationChain: 'Solana',
      vaaAvailable: true,
      redeemed: false,
      state: 'ready_to_redeem',
      nextAction: 'redeem_on_solana',
      solanaExecutable: true,
      updatedAtIso: new Date().toISOString(),
    },
    quoteCalls: [],
    transferBuilds: [],
    ...input,
  };
}

function fakeWormholeClient(state: FakeWormholeRuntimeState): WormholeClient {
  return {
    async getSupportedRoutes(_connection, input) {
      return {
        sourceChain: input.sourceChain ?? 'Solana',
        wormholeNetwork: input.wormholeNetwork,
        destinationChain: input.destinationChain,
        mintAddress: input.mintAddress,
        routeType: input.routeType,
        routes: [{
          sourceChain: input.sourceChain ?? 'Solana',
          destinationChain: input.destinationChain ?? 'Base',
          routeType: input.routeType ?? 'token_bridge',
          mode: 'automatic',
          supported: true,
          prepareSupported: true,
          manualRedemptionRequired: false,
          relayerSupported: true,
        }],
        asOfIso: new Date().toISOString(),
      };
    },
    async getTokenSnapshot(_connection, input) {
      return {
        mintAddress: input.mintAddress,
        sourceChain: 'Solana',
        wormholeNetwork: input.wormholeNetwork,
        decimals: 6,
        symbol: 'USDC',
        supportedRoutes: [],
        asOfIso: new Date().toISOString(),
      };
    },
    async quoteTransfer(_connection, input) {
      state.quoteCalls.push(input);
      return {
        ...state.quote,
        sourceChain: input.sourceChain,
        sourceMint: input.sourceMint,
        amount: input.amount,
        amountRaw: input.amountRaw,
        destinationChain: input.destinationChain,
        destinationAddress: input.destinationAddress,
        routeType: input.routeType,
        nativeGasDropoff: input.nativeGasDropoff,
        asOfIso: new Date().toISOString(),
      };
    },
    async getTransferStatus() {
      return state.status;
    },
    async getWalletBridgeExposure(_connection, input) {
      return {
        walletAddress: input.walletAddress,
        sourceChain: 'Solana',
        pendingTransfers: [state.status],
        asOfIso: new Date().toISOString(),
      };
    },
    async buildTransferTransaction(_connection, input) {
      state.transferBuilds.push(input);
      return {
        transactionBase64: 'BASE64_WORMHOLE_RUNTIME',
        programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
        reusable: false,
        quoteSnapshot: input.quote,
      };
    },
    async buildRedeemTransaction() {
      return {
        transactionBase64: 'BASE64_WORMHOLE_REDEEM_RUNTIME',
        programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
        reusable: false,
      };
    },
    async buildRecoverOrResumeTransaction() {
      return {
        transactionBase64: 'BASE64_WORMHOLE_RECOVER_RUNTIME',
        programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
        reusable: false,
      };
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
