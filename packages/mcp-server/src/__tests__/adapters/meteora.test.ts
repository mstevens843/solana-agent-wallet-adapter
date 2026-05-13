import { afterEach, describe, expect, it } from 'vitest';

import type { Connection } from '@solana/web3.js';

import {
  METEORA_ADAPTER_ID,
  meteoraAdapter,
} from '../../adapters/meteora/index.js';
import {
  resetMeteoraClientFactory,
  setMeteoraClientFactory,
  type MeteoraClient,
  type MeteoraLiquidityPreview,
  type MeteoraPoolSnapshot,
  type MeteoraPosition,
} from '../../adapters/meteora/client.js';
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
const POOL = '11111111111111111111111111111111';
const POSITION = 'So11111111111111111111111111111111111111112';
const TOKEN_X = 'So11111111111111111111111111111111111111112';
const TOKEN_Y = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeMeteoraState {
  snapshot: MeteoraPoolSnapshot;
  position: MeteoraPosition;
  buildCalls: string[];
}

function fakeMeteoraClient(state: FakeMeteoraState): MeteoraClient {
  const preview: MeteoraLiquidityPreview = {
    poolAddress: POOL,
    positionAddress: POSITION,
    tokenMints: [TOKEN_X, TOKEN_Y],
    tokenAmounts: [{ mint: TOKEN_X, amount: '0.01', symbol: 'SOL' }],
    binRange: { minBinId: 10, maxBinId: 12 },
    activeBinId: 11,
    strategyType: 'spot',
    quote: { source: 'test' },
    warnings: [],
  };
  return {
    async getPoolSnapshot() {
      return state.snapshot;
    },
    async getWalletPositions(_connection, walletAddress, poolAddress) {
      return {
        walletAddress,
        ...(poolAddress !== undefined && { poolAddress }),
        positions: [state.position],
        totals: { positions: 1, inRange: 1, outOfRange: 0 },
      };
    },
    async getPositionDetail() {
      return state.position;
    },
    async previewClaimFees() {
      return preview;
    },
    async previewClaimRewards() {
      return preview;
    },
    async previewAddLiquidity() {
      return preview;
    },
    async previewRemoveLiquidity() {
      return preview;
    },
    async previewClosePosition() {
      return preview;
    },
    async buildClaimFeesTransaction() {
      state.buildCalls.push('claim_fees');
      return { transactionBase64: 'base64-claim-fees', preview };
    },
    async buildClaimRewardsTransaction() {
      state.buildCalls.push('claim_rewards');
      return { transactionBase64: 'base64-claim-rewards', preview };
    },
    async buildAddLiquidityTransaction() {
      state.buildCalls.push('add_liquidity');
      return { transactionBase64: 'base64-add', preview };
    },
    async buildRemoveLiquidityTransaction() {
      state.buildCalls.push('remove_liquidity');
      return { transactionBase64: 'base64-remove', preview };
    },
    async buildClosePositionTransaction() {
      state.buildCalls.push('close_position');
      return { transactionBase64: 'base64-close', preview };
    },
  };
}

function fakeSnapshot(overrides: Partial<MeteoraPoolSnapshot> = {}): MeteoraPoolSnapshot {
  return {
    poolAddress: POOL,
    programId: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    tokenMintX: TOKEN_X,
    tokenMintY: TOKEN_Y,
    tokenXSymbol: 'SOL',
    tokenYSymbol: 'USDC',
    tokenXDecimals: 9,
    tokenYDecimals: 6,
    activeBinId: 11,
    binStep: 25,
    baseFeeBps: 8,
    dynamicFeeBps: 1,
    liquidity: '100000',
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakePosition(overrides: Partial<MeteoraPosition> = {}): MeteoraPosition {
  return {
    positionAddress: POSITION,
    owner: WALLET,
    poolAddress: POOL,
    tokenMintX: TOKEN_X,
    tokenMintY: TOKEN_Y,
    lowerBinId: 10,
    upperBinId: 12,
    activeBinId: 11,
    inRange: true,
    liquidity: '5000',
    tokenAmounts: [{ mint: TOKEN_X, amount: '0.01', symbol: 'SOL' }],
    feesOwed: [{ mint: TOKEN_X, amount: '0.0001', symbol: 'SOL' }],
    rewardsOwed: [{ mint: TOKEN_Y, amount: '2', symbol: 'USDC', rewardIndex: 0 }],
    asOfSlot: 280_000_000,
    ...overrides,
  };
}

function fakeState(overrides: Partial<FakeMeteoraState> = {}): FakeMeteoraState {
  return {
    snapshot: fakeSnapshot(),
    position: fakePosition(),
    buildCalls: [],
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
} = {}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(opts.cluster ?? 'mainnet-beta'),
    connection: {} as Connection,
    signAndBroadcast: opts.signed ?? (async () => 'meteora-test-txid'),
    store: {} as PreparedActionStore,
  };
}

function preparedAction(input: AddPreparedActionInput): PreparedAction {
  const now = new Date().toISOString();
  return {
    id: 'pa_meteora',
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
}

function requireMeteoraAction(id: 'claim_fees' | 'add_liquidity' | 'close_position') {
  const action = meteoraAdapter.actions[id];
  if (!action) throw new Error(`Missing Meteora action ${id}`);
  return action;
}

afterEach(() => {
  resetMeteoraClientFactory();
});

describe('Meteora adapter registration', () => {
  it('registers reads, actions, and supported clusters', () => {
    expect(METEORA_ADAPTER_ID).toBe('meteora');
    expect(requireAdapter('meteora')).toBe(meteoraAdapter);
    expect(adapterForActionKind('meteora_claim_fees')?.id).toBe('meteora');
    expect(actionForKind('meteora_add_liquidity')?.adapter.id).toBe('meteora');
    expect(() => assertSupportedCluster(meteoraAdapter, 'mainnet-beta')).not.toThrow();
    expect(() => assertSupportedCluster(meteoraAdapter, 'devnet')).toThrow();
  });
});

describe('Meteora reads', () => {
  it('returns a validated pool snapshot through the adapter read', async () => {
    const state = fakeState();
    setMeteoraClientFactory(() => fakeMeteoraClient(state));

    const read = meteoraAdapter.reads.pool_snapshot!;
    const snapshot = await read.read({ poolAddress: POOL }, makeContext());

    expect(snapshot).toMatchObject({
      poolAddress: POOL,
      activeBinId: 11,
      binStep: 25,
      tokenMintX: TOKEN_X,
      tokenMintY: TOKEN_Y,
    });
  });
});

describe('Meteora prepared actions', () => {
  it('prepares and executes a claim-fees action with refreshed transaction building', async () => {
    const state = fakeState();
    setMeteoraClientFactory(() => fakeMeteoraClient(state));
    const signed: string[] = [];
    const ctx = makeContext({
      signed: async (transactionBase64, summary) => {
        signed.push(`${transactionBase64}:${summary}`);
        return 'meteora-fees-txid';
      },
    });

    const action = requireMeteoraAction('claim_fees');
    const prepared = await action.prepare({ poolAddress: POOL, positionAddress: POSITION }, ctx);
    const result = await action.execute(preparedAction(prepared.addInput), ctx);

    expect(prepared.addInput.kind).toBe('meteora_claim_fees');
    expect(prepared.addInput.params).toMatchObject({
      connectorId: 'meteora',
      refreshAtExecution: true,
      poolAddress: POOL,
      positionAddress: POSITION,
      claimTypes: ['fees'],
    });
    expect(state.buildCalls).toEqual(['claim_fees']);
    expect(signed[0]).toContain('base64-claim-fees:Claim Meteora fees');
    expect(result.txid).toBe('meteora-fees-txid');
  });

  it('prepares add-liquidity with an explicit bin range and slippage cap', async () => {
    const state = fakeState();
    setMeteoraClientFactory(() => fakeMeteoraClient(state));

    const action = requireMeteoraAction('add_liquidity');
    const prepared = await action.prepare({
      poolAddress: POOL,
      positionAddress: POSITION,
      tokenXAmount: '0.01',
      minBinId: 10,
      maxBinId: 12,
      strategyType: 'spot',
      slippageBps: 50,
    }, makeContext());

    expect(prepared.addInput.kind).toBe('meteora_add_liquidity');
    expect(prepared.preview).toMatchObject({
      connectorId: 'meteora',
      action: 'add_liquidity',
      binRange: { minBinId: 10, maxBinId: 12 },
      slippageBps: 50,
      strategyType: 'spot',
    });
  });

  it('rejects close-position when the position still has liquidity', async () => {
    const state = fakeState({ position: fakePosition({ liquidity: '1' }) });
    setMeteoraClientFactory(() => fakeMeteoraClient(state));

    const action = requireMeteoraAction('close_position');

    await expect(action.prepare({ poolAddress: POOL, positionAddress: POSITION }, makeContext()))
      .rejects
      .toMatchObject({ code: 'position_not_empty' });
  });
});
