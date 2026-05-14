import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentWalletConfig } from '../../config.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import { assertSupportedCluster } from '../../adapters/types.js';
import type { PreparedAction, PreparedActionStore } from '../../preparedActions.js';
import {
  MARINADE_ADAPTER_ID,
  MARINADE_PROGRAM_ID,
  MARINADE_STATE_ADDRESS,
  MSOL_MINT,
  marinadeAdapter,
  resetMarinadeClientFactory,
  setMarinadeClientFactory,
  type MarinadeBuildTransactionInput,
  type MarinadeBuiltTransaction,
  type MarinadeClient,
  type MarinadeQuote,
  type MarinadeQuoteInput,
  type MarinadeUnstakeTicket,
} from '../../adapters/marinade/index.js';
import {
  marinadeClaimDelayedUnstakeAction,
  marinadeDelayedUnstakeAction,
  marinadeLiquidStakeAction,
  marinadeLiquidUnstakeAction,
} from '../../adapters/marinade/actions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const TICKET = '11111111111111111111111111111111';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeMarinadeState {
  tickets: MarinadeUnstakeTicket[];
  quoteOutputRaw?: string;
  liquidStakeBuilds: MarinadeBuildTransactionInput[];
  delayedUnstakeBuilds: MarinadeBuildTransactionInput[];
  claimBuilds: MarinadeBuildTransactionInput[];
}

afterEach(() => {
  resetMarinadeClientFactory();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Marinade adapter', () => {
  it('registers first-class actions and mainnet-only cluster support', () => {
    expect(marinadeAdapter.id).toBe(MARINADE_ADAPTER_ID);
    expect(marinadeAdapter.actions.liquid_stake?.kind).toBe('marinade_liquid_stake');
    expect(marinadeAdapter.actions.liquid_unstake?.kind).toBe('marinade_liquid_unstake');
    expect(marinadeAdapter.actions.delayed_unstake?.kind).toBe('marinade_delayed_unstake');
    expect(marinadeAdapter.actions.claim_delayed_unstake?.kind).toBe('marinade_claim_delayed_unstake');
    expect(() => assertSupportedCluster(marinadeAdapter, 'mainnet-beta')).not.toThrow();
    expect(() => assertSupportedCluster(marinadeAdapter, 'devnet')).toThrow(/mainnet-beta/);
    expect(MSOL_MINT).toBe('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
    expect(MARINADE_PROGRAM_ID).toBe('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD');
    expect(MARINADE_STATE_ADDRESS).toBe('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC');
  });

  it('prepares and executes liquid stake with an mSOL minimum-output guard', async () => {
    const state = fakeState();
    setMarinadeClientFactory(() => fakeMarinadeClient(state));
    const ctx = makeContext();

    const prepared = await marinadeLiquidStakeAction.prepare({
      solAmount: '1',
      minMsolAmount: '0.9',
    }, ctx);

    expect(prepared.addInput.kind).toBe('marinade_liquid_stake');
    expect(prepared.preview).toMatchObject({
      connectorId: 'marinade',
      operation: 'liquid_stake',
      solAmountRaw: '1000000000',
      minMsolAmountRaw: '900000000',
      refreshAtExecution: true,
    });

    const executed = await marinadeLiquidStakeAction.execute(preparedAction(prepared.addInput), ctx);
    expect(executed.txid).toBe('tx-marinade');
    expect(state.liquidStakeBuilds).toHaveLength(1);
    expect(state.liquidStakeBuilds[0]).toMatchObject({
      walletAddress: WALLET,
      amountRaw: 1000000000n,
      minOutputAmountRaw: 900000000n,
    });
  });

  it('accepts the legacy amount alias for liquid stake drafts', async () => {
    const state = fakeState();
    setMarinadeClientFactory(() => fakeMarinadeClient(state));

    const prepared = await marinadeLiquidStakeAction.prepare({
      amount: '1',
    }, makeContext());

    expect(prepared.addInput.kind).toBe('marinade_liquid_stake');
    expect(prepared.addInput.summary).toBe('Stake 1 SOL for mSOL on Marinade');
    expect(prepared.preview).toMatchObject({
      solAmount: '1',
      solAmountRaw: '1000000000',
      inputSymbol: 'SOL',
      outputSymbol: 'mSOL',
    });
  });

  it('rejects delayed-unstake claim preparation when the ticket is not claimable', async () => {
    const state = fakeState({
      tickets: [{
        ticketAccount: TICKET,
        solAmount: '0.5',
        lamports: '500000000',
        status: 'pending',
        reason: 'Ticket cools down next epoch.',
      }],
    });
    setMarinadeClientFactory(() => fakeMarinadeClient(state));

    await expect(marinadeClaimDelayedUnstakeAction.prepare({
      ticketAccount: TICKET,
    }, makeContext())).rejects.toMatchObject({
      code: 'ticket_not_claimable',
      message: 'Ticket cools down next epoch.',
    });
  });

  it('prepares and executes delayed unstake with a SOL minimum-output guard', async () => {
    const state = fakeState();
    setMarinadeClientFactory(() => fakeMarinadeClient(state));
    const ctx = makeContext();

    const prepared = await marinadeDelayedUnstakeAction.prepare({
      msolAmount: '1',
      minSolAmount: '1',
    }, ctx);
    const executed = await marinadeDelayedUnstakeAction.execute(preparedAction(prepared.addInput), ctx);

    expect(prepared.addInput.kind).toBe('marinade_delayed_unstake');
    expect(executed.txid).toBe('tx-marinade');
    expect(state.delayedUnstakeBuilds).toEqual([
      expect.objectContaining({
        walletAddress: WALLET,
        amountRaw: 1000000000n,
        minOutputAmountRaw: 1000000000n,
      }),
    ]);
  });

  it('executes claim only while the prepared ticket remains claimable at the same time', async () => {
    const claimableAt = '2026-05-12T20:00:00.000Z';
    const state = fakeState({
      tickets: [{
        ticketAccount: ` ${TICKET} `,
        solAmount: '0.5',
        lamports: '500000000',
        claimableAt,
        status: 'claimable',
      }],
    });
    setMarinadeClientFactory(() => fakeMarinadeClient(state));
    const ctx = makeContext();

    const prepared = await marinadeClaimDelayedUnstakeAction.prepare({
      ticketAccount: TICKET,
      expectedClaimableAt: claimableAt,
    }, ctx);
    const executed = await marinadeClaimDelayedUnstakeAction.execute(preparedAction(prepared.addInput), ctx);

    expect(executed.txid).toBe('tx-marinade');
    expect(state.claimBuilds).toEqual([
      expect.objectContaining({ walletAddress: WALLET, ticketAccount: TICKET }),
    ]);
  });

  it('rejects claim execution when the ticket claimable time changed', async () => {
    const state = fakeState({
      tickets: [{
        ticketAccount: TICKET,
        solAmount: '0.5',
        lamports: '500000000',
        claimableAt: '2026-05-12T20:00:00.000Z',
        status: 'claimable',
      }],
    });
    setMarinadeClientFactory(() => fakeMarinadeClient(state));
    const ctx = makeContext();
    const prepared = await marinadeClaimDelayedUnstakeAction.prepare({
      ticketAccount: TICKET,
    }, ctx);
    state.tickets[0] = {
      ...state.tickets[0]!,
      claimableAt: '2026-05-12T21:00:00.000Z',
    };

    await expect(marinadeClaimDelayedUnstakeAction.execute(preparedAction(prepared.addInput), ctx)).rejects.toMatchObject({
      code: 'ticket_claimable_time_changed',
    });
  });

  it('enforces minimum output on read quotes', async () => {
    const state = fakeState({ quoteOutputRaw: '900000000' });
    setMarinadeClientFactory(() => fakeMarinadeClient(state));

    await expect(marinadeAdapter.reads.quote!.read({
      operation: 'liquid_stake',
      solAmount: '1',
      minMsolAmount: '1',
    }, makeContext())).rejects.toMatchObject({
      code: 'output_below_minimum',
    });
  });

  it('rejects instant unstake slippage above the configured cap before fetching Jupiter', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-jupiter');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(marinadeLiquidUnstakeAction.prepare({
      msolAmount: '0.1',
      slippageBps: 101,
    }, makeContext())).rejects.toMatchObject({
      code: 'slippage_above_cap',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes Jupiter for instant unstake before signing and executes the signed order', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-jupiter');
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/order')) {
        expect(requestUrl.searchParams.get('inputMint')).toBe(MSOL_MINT);
        expect(requestUrl.searchParams.get('amount')).toBe('100000000');
        return jsonResponse({
          requestId: `req-${fetchMock.mock.calls.length}`,
          transaction: 'unsigned-jupiter-transaction',
          inputMint: MSOL_MINT,
          outputMint: 'So11111111111111111111111111111111111111112',
          inAmount: '100000000',
          outAmount: '101000000',
          otherAmountThreshold: '100000000',
          priceImpactPct: '0.001',
          lastValidBlockHeight: 123456,
        });
      }
      expect(requestUrl.pathname.endsWith('/execute')).toBe(true);
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('signed-jupiter-transaction');
      expect(String(init?.body)).toContain('"lastValidBlockHeight":123456');
      return jsonResponse({
        status: 'Success',
        signature: 'tx-jupiter-marinade',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const signedInputs: string[] = [];
    const ctx = makeContext({
      signTransaction: async (transactionBase64) => {
        signedInputs.push(transactionBase64);
        return 'signed-jupiter-transaction';
      },
    });

    const prepared = await marinadeLiquidUnstakeAction.prepare({
      msolAmount: '0.1',
      minSolAmount: '0.1',
    }, ctx);
    const executed = await marinadeLiquidUnstakeAction.execute(preparedAction(prepared.addInput), ctx);

    expect(prepared.addInput.kind).toBe('marinade_liquid_unstake');
    expect(prepared.preview).toMatchObject({
      connectorActionSource: 'jupiter',
      route: 'jupiter',
      msolAmountRaw: '100000000',
      minSolAmountRaw: '100000000',
    });
    expect(signedInputs).toEqual(['unsigned-jupiter-transaction']);
    expect(executed.txid).toBe('tx-jupiter-marinade');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects failed Jupiter execution responses even when a signature is present', async () => {
    vi.stubEnv('JUPITER_API_KEY', 'sk-test-jupiter');
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/order')) {
        return jsonResponse({
          requestId: 'req-failed',
          transaction: 'unsigned-jupiter-transaction',
          inputMint: MSOL_MINT,
          outputMint: 'So11111111111111111111111111111111111111112',
          inAmount: '100000000',
          outAmount: '101000000',
          otherAmountThreshold: '100000000',
        });
      }
      return jsonResponse({
        status: 'Failed',
        signature: 'tx-jupiter-failed',
        error: 'route expired',
      });
    }));
    const ctx = makeContext({
      signTransaction: async () => 'signed-jupiter-transaction',
    });
    const prepared = await marinadeLiquidUnstakeAction.prepare({
      msolAmount: '0.1',
      minSolAmount: '0.1',
    }, ctx);

    await expect(marinadeLiquidUnstakeAction.execute(preparedAction(prepared.addInput), ctx)).rejects.toMatchObject({
      code: 'wallet_unreachable',
      message: expect.stringContaining('Jupiter execute failed'),
    });
  });
});

function fakeState(input: Partial<FakeMarinadeState> = {}): FakeMarinadeState {
  return {
    tickets: [{
      ticketAccount: TICKET,
      solAmount: '0.5',
      lamports: '500000000',
      status: 'claimable',
    }],
    quoteOutputRaw: undefined,
    liquidStakeBuilds: [],
    delayedUnstakeBuilds: [],
    claimBuilds: [],
    ...input,
  };
}

function fakeMarinadeClient(state: FakeMarinadeState): MarinadeClient {
  const buildResult = (preview: Record<string, unknown>): MarinadeBuiltTransaction => ({
    transactionBase64: Buffer.from('fake-marinade-transaction').toString('base64'),
    programIds: [MARINADE_PROGRAM_ID],
    preview,
  });
  return {
    async getStateSnapshot() {
      return {
        connectorId: MARINADE_ADAPTER_ID,
        stateAddress: MARINADE_STATE_ADDRESS,
        programId: MARINADE_PROGRAM_ID,
        msolMint: MSOL_MINT,
        msolPrice: '1.05',
        warnings: [],
      };
    },
    async getWalletPositions() {
      return {
        connectorId: MARINADE_ADAPTER_ID,
        walletAddress: WALLET,
        msolMint: MSOL_MINT,
        msolBalanceRaw: '1000000000',
        msolBalance: '1',
        nativeStakeAccounts: [],
        unstakeTickets: state.tickets,
      };
    },
    async getStakeAccounts() {
      return [];
    },
    async getUnstakeTickets() {
      return state.tickets;
    },
    async getQuote(_connection, input: MarinadeQuoteInput): Promise<MarinadeQuote> {
      return {
        connectorId: MARINADE_ADAPTER_ID,
        operation: input.operation,
        inputAmount: '1',
        inputAmountRaw: input.inputAmountRaw.toString(),
        outputAmount: input.operation === 'liquid_stake' ? '0.95' : '1.02',
        outputAmountRaw: state.quoteOutputRaw ?? (input.operation === 'liquid_stake' ? '950000000' : '1020000000'),
        minOutputAmountRaw: input.minOutputAmountRaw?.toString(),
        route: 'marinade',
        warnings: [],
      };
    },
    async buildLiquidStakeTransaction(_connection, input) {
      state.liquidStakeBuilds.push(input);
      return buildResult({ operation: 'liquid_stake', amountRaw: input.amountRaw?.toString() });
    },
    async buildDelayedUnstakeTransaction(_connection, input) {
      state.delayedUnstakeBuilds.push(input);
      return buildResult({ operation: 'delayed_unstake', amountRaw: input.amountRaw?.toString() });
    },
    async buildClaimDelayedUnstakeTransaction(_connection, input) {
      state.claimBuilds.push(input);
      return buildResult({ operation: 'claim_delayed_unstake', ticketAccount: input.ticketAccount });
    },
  };
}

function fakeConfig(): AgentWalletConfig {
  return {
    cluster: 'mainnet-beta',
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
      baseUrl: 'https://jupiter.example/ultra/v1',
      swapBaseUrl: 'https://jupiter.example/ultra/v1',
      apiKeyEnv: 'JUPITER_API_KEY',
    },
    recurring: {},
  } as AgentWalletConfig;
}

function makeContext(overrides: Partial<DAppAdapterContext> = {}): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(),
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: async () => 'tx-marinade',
    signTransaction: async () => 'signed-marinade-tx-base64',
    signMessage: async () => 'signature-base64-placeholder',
    store: {} as PreparedActionStore,
    ...overrides,
  };
}

function preparedAction(addInput: {
  kind: PreparedAction['kind'];
  walletAddress: string;
  cluster: PreparedAction['cluster'];
  summary: string;
  params: Record<string, unknown>;
}): PreparedAction {
  return {
    id: 'pa_marinade',
    status: 'ready',
    dueAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...addInput,
  };
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
