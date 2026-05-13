import { afterEach, describe, expect, it } from 'vitest';

import {
  JITO_ADAPTER_ID,
  JITO_STAKE_POOL_ADDRESS,
  JITOSOL_MINT,
  jitoAdapter,
  type JitoQuote,
  type JitoQuoteInput,
  type JitoStakeAccount,
  type JitoStakePoolSnapshot,
  type JitoWalletPositionsResult,
} from '../../adapters/jito/index.js';
import { jitoStakeSolAction, jitoWithdrawSolAction } from '../../adapters/jito/actions.js';
import {
  resetJitoClientFactory,
  setJitoClientFactory,
  type JitoBuildDepositStakeInput,
  type JitoBuildStakeSolInput,
  type JitoBuildTransactionResult,
  type JitoBuildUnstakeInput,
  type JitoBuildWithdrawSolInput,
  type JitoClient,
} from '../../adapters/jito/client.js';
import { assertSupportedCluster } from '../../adapters/types.js';
import type { AgentWalletConfig } from '../../config.js';
import type { DAppAdapterContext } from '../../adapters/types.js';
import type { PreparedAction, PreparedActionStore } from '../../preparedActions.js';

const WALLET = 'GgwYwf8XtAQRtu1ZUv9hY1Zk1wkJpz3DCH7jQAjmGGGV';
const STAKE_ACCOUNT = 'H3mUi9L76v8dyW2hAc3gCHc5VgtyT4BDr9XwihwLh7TR';

class FakeBackend {
  async getAddress(): Promise<string> {
    return WALLET;
  }
  async capabilities(): Promise<{ address: string }> {
    return { address: WALLET };
  }
}

interface FakeJitoState {
  quote: JitoQuote;
  stakeBuilds: JitoBuildStakeSolInput[];
  stakeAccount?: JitoStakeAccount;
}

function buildFakeJito(state: FakeJitoState): JitoClient {
  const buildResult = (preview: Record<string, unknown>): JitoBuildTransactionResult => ({
    transactionBase64: Buffer.from('fake-jito-transaction').toString('base64'),
    programIds: ['SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'],
    preview,
    signerCount: 0,
  });
  return {
    async getStakePoolSnapshot() {
      return fakePoolSnapshot();
    },
    async getWalletPositions(): Promise<JitoWalletPositionsResult> {
      return {
        walletAddress: WALLET,
        jitoSol: {
          mint: JITOSOL_MINT.toBase58(),
          decimals: 9,
          amount: '1',
          amountRaw: '1000000000',
          tokenAccounts: [],
        },
        totals: {
          jitoSolTokenAccounts: 0,
          stakeAccounts: 0,
          eligibleStakeAccounts: 0,
        },
      };
    },
    async getWalletStakeAccounts(): Promise<JitoStakeAccount[]> {
      return [state.stakeAccount ?? fakeStakeAccount()];
    },
    async getStakeAccount(): Promise<JitoStakeAccount> {
      return state.stakeAccount ?? fakeStakeAccount();
    },
    async quote(_connection: unknown, input: JitoQuoteInput): Promise<JitoQuote> {
      return { ...state.quote, operation: input.operation };
    },
    async buildStakeSolTransaction(_connection, input) {
      state.stakeBuilds.push(input);
      return buildResult({ operation: 'stake_sol', amountRaw: input.amountLamports.toString() });
    },
    async buildDepositStakeAccountTransaction(_connection, input: JitoBuildDepositStakeInput) {
      return buildResult({ operation: 'deposit_stake_account', stakeAccount: input.stakeAccount });
    },
    async buildUnstakeJitosolTransaction(_connection, input: JitoBuildUnstakeInput) {
      return buildResult({ operation: 'unstake_jitosol', jitoSolAmountRaw: input.jitoSolAmountRaw.toString() });
    },
    async buildWithdrawSolTransaction(_connection, input: JitoBuildWithdrawSolInput) {
      return buildResult({ operation: 'withdraw_sol', stakeAccount: input.stakeAccount });
    },
  };
}

function fakePoolSnapshot(): JitoStakePoolSnapshot {
  return {
    stakePoolAddress: JITO_STAKE_POOL_ADDRESS.toBase58(),
    jitoSolMint: JITOSOL_MINT.toBase58(),
    poolMint: JITOSOL_MINT.toBase58(),
    reserveStake: '7XvX4p9Qd3fTJSu8T6EwPcwkJQpxx1xN9P9rY9Uxpump',
    manager: WALLET,
    staker: WALLET,
    validatorList: '9XvX4p9Qd3fTJSu8T6EwPcwkJQpxx1xN9P9rY9UxList',
    totalLamports: '1000000000000',
    poolTokenSupply: '900000000000',
    exchangeRateSolPerJitoSol: '1.111111111',
    exchangeRateJitoSolPerSol: '0.9',
    lastUpdateEpoch: '700',
    fees: {
      solDeposit: { numerator: '0', denominator: '0', bps: 0 },
      solWithdrawal: { numerator: '0', denominator: '0', bps: 0 },
      stakeDeposit: { numerator: '0', denominator: '0', bps: 0 },
      stakeWithdrawal: { numerator: '0', denominator: '0', bps: 0 },
    },
    programIds: ['SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'],
    warnings: [],
  };
}

function fakeStakeAccount(overrides: Partial<JitoStakeAccount> = {}): JitoStakeAccount {
  return {
    stakeAccount: STAKE_ACCOUNT,
    walletAddress: WALLET,
    withdrawer: WALLET,
    staker: WALLET,
    voter: 'Vote111111111111111111111111111111111111111',
    delegatedStakeLamports: '1000000000',
    lamports: '1002282880',
    state: 'delegated',
    locked: false,
    deactivating: false,
    eligibleForJitoDeposit: true,
    warnings: [],
    ...overrides,
  };
}

function fakeQuote(overrides: Partial<JitoQuote> = {}): JitoQuote {
  return {
    operation: 'stake_sol',
    amount: '1',
    amountRaw: '1000000000',
    expectedJitoSolAmount: '0.9',
    expectedJitoSolRaw: '900000000',
    exchangeRateSnapshot: {
      stakePoolAddress: JITO_STAKE_POOL_ADDRESS.toBase58(),
      jitoSolMint: JITOSOL_MINT.toBase58(),
      totalLamports: '1000000000000',
      poolTokenSupply: '900000000000',
      exchangeRateSolPerJitoSol: '1.111111111',
      exchangeRateJitoSolPerSol: '0.9',
      lastUpdateEpoch: '700',
    },
    warnings: [],
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

function makeContext(signed?: (transactionBase64: string, summary: string) => Promise<string>): DAppAdapterContext {
  return {
    backend: new FakeBackend() as unknown as DAppAdapterContext['backend'],
    config: fakeConfig(),
    connection: {} as DAppAdapterContext['connection'],
    signAndBroadcast: signed ?? (async () => 'tx-jito'),
    signTransaction: async () => "signed-base64-placeholder",
    signMessage: async () => "signature-base64-placeholder",
    store: {} as PreparedActionStore,
  };
}

function preparedAction(addInput: PreparedAction['kind'] extends never ? never : {
  kind: PreparedAction['kind'];
  walletAddress: string;
  cluster: PreparedAction['cluster'];
  summary: string;
  params: Record<string, unknown>;
}): PreparedAction {
  return {
    id: 'pa_jito',
    status: 'ready',
    dueAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...addInput,
  };
}

afterEach(() => {
  resetJitoClientFactory();
});

describe('Jito adapter', () => {
  it('registers first-class actions and cluster support', () => {
    expect(jitoAdapter.id).toBe(JITO_ADAPTER_ID);
    expect(jitoAdapter.actions.stake_sol?.kind).toBe('jito_stake_sol');
    expect(jitoAdapter.actions.unstake_jitosol?.kind).toBe('jito_unstake_jitosol');
    expect(() => assertSupportedCluster(jitoAdapter, 'mainnet-beta')).not.toThrow();
    expect(() => assertSupportedCluster(jitoAdapter, 'devnet')).toThrow(/mainnet-beta/);
  });

  it('prepares and executes stake SOL with the min-output guard', async () => {
    const state: FakeJitoState = { quote: fakeQuote(), stakeBuilds: [] };
    setJitoClientFactory(() => buildFakeJito(state));
    const ctx = makeContext();

    const prepared = await jitoStakeSolAction.prepare({
      solAmount: '1',
      minJitoSolAmount: '0.8',
    }, ctx);

    expect(prepared.addInput.kind).toBe('jito_stake_sol');
    expect(prepared.preview).toMatchObject({
      connectorId: 'jito',
      amountRaw: '1000000000',
      minJitoSolRaw: '800000000',
    });

    const executed = await jitoStakeSolAction.execute(preparedAction(prepared.addInput), ctx);
    expect(executed.txid).toBe('tx-jito');
    expect(state.stakeBuilds).toEqual([{ walletAddress: WALLET, amountLamports: 1000000000n }]);
  });

  it('blocks stake SOL preparation when expected output is below the minimum', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote({ expectedJitoSolAmount: '0.7', expectedJitoSolRaw: '700000000' }),
      stakeBuilds: [],
    }));

    await expect(jitoStakeSolAction.prepare({
      solAmount: '1',
      minJitoSolAmount: '0.8',
    }, makeContext())).rejects.toThrow(/below the requested minimum/);
  });

  it('blocks SOL withdrawal preparation while the stake account is still active', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      stakeAccount: fakeStakeAccount({ activationState: 'active' }),
    }));

    await expect(jitoWithdrawSolAction.prepare({
      stakeAccount: STAKE_ACCOUNT,
    }, makeContext())).rejects.toThrow(/wait until it is inactive/);
  });
});
