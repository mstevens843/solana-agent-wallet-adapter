import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WORMHOLE_ADAPTER_ID,
  WORMHOLE_SUPPORTED_CLUSTERS,
  wormholeAdapter,
} from '../../adapters/wormhole/index.js';
import {
  describeWormholeUnavailableReason,
  resetWormholeClientFactory,
  setWormholeClientFactory,
  type WormholeBuildRedeemInput,
  type WormholeBuildTransferInput,
  type WormholeBuiltTransaction,
  type WormholeClient,
  type WormholeQuoteInput,
  type WormholeQuoteSnapshot,
  type WormholeRecoverOrResumeInput,
  type WormholeStatusInput,
  type WormholeTransferStatus,
} from '../../adapters/wormhole/client.js';
import {
  wormholeRecoverOrResumeAction,
  wormholeRedeemAction,
  wormholeTransferAction,
} from '../../adapters/wormhole/actions.js';
import {
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
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DESTINATION = '0x1111111111111111111111111111111111111111';
const DESTINATION_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }

  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeWormholeState {
  quote: WormholeQuoteSnapshot;
  status: WormholeTransferStatus;
  statusError?: Error;
  quoteCalls: Array<WormholeQuoteInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
  statusCalls: Array<WormholeStatusInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
  transferBuilds: Array<WormholeBuildTransferInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
  redeemBuilds: WormholeBuildRedeemInput[];
  recoverBuilds: Array<WormholeRecoverOrResumeInput & { wormholeNetwork: 'Mainnet' | 'Testnet' }>;
}

afterEach(() => {
  resetWormholeClientFactory();
  vi.unstubAllEnvs();
});

describe('Wormhole adapter', () => {
  it('registers first-class reads, actions, and cluster support', () => {
    expect(wormholeAdapter.id).toBe(WORMHOLE_ADAPTER_ID);
    expect(wormholeAdapter.supportedClusters).toEqual(WORMHOLE_SUPPORTED_CLUSTERS);
    expect(Object.keys(wormholeAdapter.reads).sort()).toEqual([
      'quote',
      'supported_routes',
      'token_snapshot',
      'transfer_status',
      'wallet_bridge_exposure',
    ]);
    expect(Object.keys(wormholeAdapter.actions).sort()).toEqual([
      'recover_or_resume',
      'redeem',
      'transfer',
    ]);
    expect(requireAdapter('wormhole').id).toBe('wormhole');
    expect(adapterForActionKind('wormhole_transfer')?.id).toBe('wormhole');
    expect(actionForKind('wormhole_redeem')?.action.id).toBe('redeem');
    expect(() => assertSupportedCluster(wormholeAdapter, 'mainnet-beta')).not.toThrow();
    expect(() => assertSupportedCluster(wormholeAdapter, 'devnet')).not.toThrow();
    expect(() => assertSupportedCluster(wormholeAdapter, 'testnet')).toThrow(/mainnet-beta/);
  });

  it('returns static supported routes when the SDK client is not wired', async () => {
    const read = wormholeAdapter.reads.supported_routes;
    if (!read) throw new Error('Wormhole supported_routes read is missing.');

    const snapshot = await read.read({
      destinationChain: 'Base',
      routeType: 'auto',
    }, makeContext()) as { routes: Array<Record<string, unknown>> };

    expect(snapshot.routes).toEqual([
      expect.objectContaining({
        sourceChain: 'Solana',
        destinationChain: 'Base',
        routeType: 'token_bridge',
        supported: true,
        prepareSupported: false,
      }),
    ]);
    expect(describeWormholeUnavailableReason()).toContain('@wormhole-foundation/sdk');
  });

  it('prepares and executes a transfer with fresh quote, fee cap, and execution refresh', async () => {
    const state = fakeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const ctx = makeContext();

    const prepared = await wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
      maxBridgeFee: '0.1',
      minDestinationAmount: '9.9',
      nativeGasDropoff: '0.001',
    }, ctx);

    expect(prepared.addInput.kind).toBe('wormhole_transfer');
    expect(prepared.preview).toMatchObject({
      connectorId: 'wormhole',
      operation: 'transfer',
      sourceMint: USDC_MINT,
      amountRaw: '10000000',
      destinationChain: 'Base',
      destinationToken: DESTINATION_TOKEN,
      refreshAtExecution: true,
    });

    const executed = await wormholeTransferAction.execute(preparedAction(prepared.addInput), ctx);

    expect(executed.txid).toBe('tx-wormhole');
    expect(state.quoteCalls).toHaveLength(2);
    expect(state.transferBuilds).toHaveLength(1);
    expect(state.transferBuilds[0]).toMatchObject({
      walletAddress: WALLET,
      sourceMint: USDC_MINT,
      amountRaw: '10000000',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
      nativeGasDropoff: '0.001',
      maxBridgeFee: '0.1',
    });
  });

  it('blocks execution when the refreshed destination token mapping changes', async () => {
    const state = fakeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const ctx = makeContext();
    const prepared = await wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, ctx);
    state.quote = fakeQuote({ destinationToken: '0x2222222222222222222222222222222222222222' });

    await expect(wormholeTransferAction.execute(preparedAction(prepared.addInput), ctx)).rejects.toMatchObject({
      code: 'destination_token_changed',
    });
    expect(state.transferBuilds).toHaveLength(0);
  });

  it('blocks execution when the refreshed route type changes', async () => {
    const state = fakeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const ctx = makeContext();
    const prepared = await wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, ctx);
    state.quote = fakeQuote({
      routeType: 'cctp',
      programIds: ['CCTP11111111111111111111111111111111111111'],
    });

    await expect(wormholeTransferAction.execute(preparedAction(prepared.addInput), ctx)).rejects.toMatchObject({
      code: 'route_type_changed',
    });
    expect(state.transferBuilds).toHaveLength(0);
  });

  it('blocks transfer preparation when bridge fees exceed the caller cap', async () => {
    const state = fakeState({ quote: fakeQuote({ bridgeFee: '0.5' }) });
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
      maxBridgeFee: '0.1',
    }, makeContext())).rejects.toMatchObject({
      code: 'fee_above_cap',
    });
  });

  it('fails closed when a caller supplies an invalid bridge fee cap', async () => {
    const state = fakeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
      maxBridgeFee: 'not-a-decimal',
    }, makeContext())).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(state.quoteCalls).toHaveLength(0);
  });

  it('fails closed when mint decimals cannot be resolved', async () => {
    const state = fakeState();
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, makeContext({ parsedMintDecimals: null }))).rejects.toMatchObject({
      code: 'mint_decimals_unavailable',
    });
    expect(state.quoteCalls).toHaveLength(0);
  });

  it('rejects stale or expired quotes before preparing a transfer', async () => {
    const stale = fakeState({
      quote: fakeQuote({ asOfIso: new Date(Date.now() - 61_000).toISOString() }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(stale));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, makeContext())).rejects.toMatchObject({
      code: 'stale_quote',
    });

    const expired = fakeState({
      quote: fakeQuote({ expiresAtIso: new Date(Date.now() - 1_000).toISOString() }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(expired));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, makeContext())).rejects.toMatchObject({
      code: 'stale_quote',
    });
  });

  it('requires automatic routing to resolve to a concrete route before preparing transfer', async () => {
    const state = fakeState({ quote: fakeQuote({ routeType: 'auto' }) });
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, makeContext())).rejects.toMatchObject({
      code: 'missing_route_facts',
    });
    expect(state.transferBuilds).toHaveLength(0);
  });

  it('requires destination token and route program facts before preparing transfer variants', async () => {
    const missingToken = fakeState({ quote: fakeQuote({ destinationToken: undefined }) });
    setWormholeClientFactory(() => fakeWormholeClient(missingToken));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
    }, makeContext())).rejects.toMatchObject({
      code: 'missing_destination_token',
    });

    const missingProgramIds = fakeState({
      quote: fakeQuote({ routeType: 'cctp', programIds: undefined }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(missingProgramIds));

    await expect(wormholeTransferAction.prepare({
      sourceMint: USDC_MINT,
      amount: '10',
      destinationChain: 'Base',
      destinationAddress: DESTINATION,
      routeType: 'cctp',
    }, makeContext())).rejects.toMatchObject({
      code: 'missing_route_program_ids',
    });
  });

  it('prepares and executes redeem only when the transfer is Solana-executable', async () => {
    const state = fakeState({
      status: fakeStatus({
        destinationChain: 'Solana',
        destinationToken: USDC_MINT,
        state: 'ready_to_redeem',
        nextAction: 'redeem_on_solana',
        solanaExecutable: true,
      }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(state));
    const ctx = makeContext();

    const prepared = await wormholeRedeemAction.prepare({
      destinationChain: 'Solana',
      vaa: 'AQIDBA==',
      expectedMint: USDC_MINT,
    }, ctx);
    const executed = await wormholeRedeemAction.execute(preparedAction(prepared.addInput), ctx);

    expect(prepared.addInput.kind).toBe('wormhole_redeem');
    expect(executed.txid).toBe('tx-wormhole');
    expect(state.statusCalls).toHaveLength(2);
    expect(state.redeemBuilds).toEqual([
      expect.objectContaining({
        walletAddress: WALLET,
        destinationChain: 'Solana',
        vaa: 'AQIDBA==',
        expectedMint: USDC_MINT,
      }),
    ]);
  });

  it('refuses redeem when status cannot be resolved or the VAA is not ready', async () => {
    const unavailable = fakeState({ statusError: new Error('status unavailable') });
    setWormholeClientFactory(() => fakeWormholeClient(unavailable));

    await expect(wormholeRedeemAction.prepare({
      destinationChain: 'Solana',
      vaa: 'AQIDBA==',
    }, makeContext())).rejects.toThrow(/status unavailable/);

    const pending = fakeState({
      status: fakeStatus({
        state: 'pending_vaa',
        vaaAvailable: false,
        nextAction: 'wait_for_vaa',
        solanaExecutable: true,
      }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(pending));

    await expect(wormholeRedeemAction.prepare({
      destinationChain: 'Solana',
      vaa: 'AQIDBA==',
    }, makeContext())).rejects.toMatchObject({
      code: 'vaa_not_ready',
    });
  });

  it('refuses redeem for unknown status even when the client marks it Solana-executable', async () => {
    const state = fakeState({
      status: fakeStatus({
        state: 'unknown',
        vaaAvailable: true,
        nextAction: 'redeem_on_solana',
        solanaExecutable: true,
      }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeRedeemAction.prepare({
      destinationChain: 'Solana',
      vaa: 'AQIDBA==',
    }, makeContext())).rejects.toMatchObject({
      code: 'status_not_ready',
    });
  });

  it('refuses destination-chain redeem signing outside Solana', async () => {
    await expect(wormholeRedeemAction.prepare({
      destinationChain: 'Base',
      vaa: 'AQIDBA==',
    }, makeContext())).rejects.toMatchObject({
      code: 'unsupported_destination_signing',
    });
  });

  it('refuses recovery when the next step must be completed on another chain', async () => {
    const state = fakeState({
      status: fakeStatus({
        destinationChain: 'Base',
        nextAction: 'redeem_on_destination',
        solanaExecutable: false,
      }),
    });
    setWormholeClientFactory(() => fakeWormholeClient(state));

    await expect(wormholeRecoverOrResumeAction.prepare({
      sourceTxid: 'source-txid',
      destinationChain: 'Base',
    }, makeContext())).rejects.toMatchObject({
      code: 'destination_wallet_required',
    });
    expect(state.recoverBuilds).toHaveLength(0);
  });
});

function fakeState(input: Partial<FakeWormholeState> = {}): FakeWormholeState {
  return {
    quote: fakeQuote(),
    status: fakeStatus(),
    quoteCalls: [],
    statusCalls: [],
    transferBuilds: [],
    redeemBuilds: [],
    recoverBuilds: [],
    ...input,
  };
}

function fakeWormholeClient(state: FakeWormholeState): WormholeClient {
  const built = (transactionBase64: string, preview: Partial<WormholeBuiltTransaction> = {}): WormholeBuiltTransaction => ({
    transactionBase64,
    programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
    reusable: false,
    ...preview,
  });

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
          sourceMint: input.mintAddress,
          destinationToken: DESTINATION_TOKEN,
          bridgeFee: '0.01',
          programIds: ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'],
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
        routeType: state.quote.routeType,
        nativeGasDropoff: input.nativeGasDropoff,
      };
    },
    async getTransferStatus(_connection, input) {
      state.statusCalls.push(input);
      if (state.statusError) throw state.statusError;
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
      return built('BASE64_WORMHOLE_TRANSFER', {
        quoteSnapshot: input.quote,
        transferId: 'wh-transfer-1',
      });
    },
    async buildRedeemTransaction(_connection, input) {
      state.redeemBuilds.push(input);
      return built('BASE64_WORMHOLE_REDEEM', {
        statusSnapshot: input.status,
        vaa: input.vaa,
        transferId: input.transferId,
      });
    },
    async buildRecoverOrResumeTransaction(_connection, input) {
      state.recoverBuilds.push(input);
      return built('BASE64_WORMHOLE_RECOVER', {
        statusSnapshot: input.status,
        transferId: input.transferId,
      });
    },
  };
}

function fakeQuote(overrides: Partial<WormholeQuoteSnapshot> = {}): WormholeQuoteSnapshot {
  return {
    quoteId: 'quote-wormhole-1',
    sourceChain: 'Solana',
    destinationChain: 'Base',
    sourceMint: USDC_MINT,
    destinationToken: DESTINATION_TOKEN,
    destinationAddress: DESTINATION,
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
    ...overrides,
  };
}

function fakeStatus(overrides: Partial<WormholeTransferStatus> = {}): WormholeTransferStatus {
  return {
    transferId: 'wh-transfer-1',
    sourceChain: 'Solana',
    destinationChain: 'Solana',
    sourceTxid: 'source-txid',
    sequence: '1234',
    vaaAvailable: true,
    redeemed: false,
    state: 'ready_to_redeem',
    nextAction: 'redeem_on_solana',
    solanaExecutable: true,
    updatedAtIso: new Date().toISOString(),
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
  cluster?: 'mainnet-beta' | 'devnet';
  signed?: (transactionBase64: string, summary: string) => Promise<string>;
  parsedMintDecimals?: number | null;
} = {}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {
      async getParsedAccountInfo() {
        if (opts.parsedMintDecimals === null) return { value: null };
        return { value: { data: { parsed: { info: { decimals: opts.parsedMintDecimals ?? 6 } } } } };
      },
    } as unknown as DAppAdapterContext['connection'],
    signTransaction: async () => 'SIGNED_WORMHOLE_TRANSACTION',
    signAndBroadcast: opts.signed ?? (async () => 'tx-wormhole'),
    signMessage: async () => 'SIGNED_WORMHOLE_MESSAGE',
    store: {} as PreparedActionStore,
  };
}

function preparedAction(input: AddPreparedActionInput): PreparedAction {
  const now = new Date().toISOString();
  return {
    id: 'pa_wormhole',
    status: input.status ?? 'ready',
    dueAt: input.dueAt ?? now,
    createdAt: now,
    updatedAt: now,
    walletAddress: input.walletAddress,
    cluster: input.cluster,
    kind: input.kind,
    summary: input.summary,
    params: input.params,
  };
}
