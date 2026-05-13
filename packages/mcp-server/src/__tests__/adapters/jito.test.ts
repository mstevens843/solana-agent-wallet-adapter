import { afterEach, describe, expect, it } from 'vitest';

import {
  JITO_ADAPTER_ID,
  JITO_STAKE_POOL_ADDRESS,
  JITOSOL_MINT,
  jitoAdapter,
  type JitoDepositReceipt,
  type JitoDepositReceiptsResult,
  type JitoQuote,
  type JitoQuoteInput,
  type JitoStakeAccount,
  type JitoStakePoolSnapshot,
  type JitoWalletPositionsResult,
} from '../../adapters/jito/index.js';
import {
  jitoClaimDepositReceiptAction,
  jitoDepositStakeAccountAction,
  jitoStakeSolAction,
  jitoWithdrawSolAction,
} from '../../adapters/jito/actions.js';
import {
  resetJitoClientFactory,
  setJitoClientFactory,
  type JitoBuildClaimDepositReceiptInput,
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
const RECEIPT_ACCOUNT = '6SpuE9rVfXKMdWQDB3DT4puLjTYxkA5vV8z4MrnPjgXA';

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
  depositBuilds?: JitoBuildDepositStakeInput[];
  claimBuilds?: JitoBuildClaimDepositReceiptInput[];
  withdrawBuilds?: JitoBuildWithdrawSolInput[];
  stakeAccount?: JitoStakeAccount;
  receipt?: JitoDepositReceipt;
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
    async getWalletDepositReceipts(): Promise<JitoDepositReceiptsResult> {
      const receipt = state.receipt ?? fakeReceipt();
      return {
        walletAddress: WALLET,
        receipts: [receipt],
        totals: {
          receipts: 1,
          claimableReceipts: receipt.cooldownComplete ? 1 : 0,
          pendingReceipts: receipt.cooldownComplete ? 0 : 1,
          lstAmount: receipt.lstAmount,
          lstAmountRaw: receipt.lstAmountRaw,
        },
      };
    },
    async getStakeAccount(): Promise<JitoStakeAccount> {
      return state.stakeAccount ?? fakeStakeAccount();
    },
    async getDepositReceipt(): Promise<JitoDepositReceipt> {
      return state.receipt ?? fakeReceipt();
    },
    async quote(_connection: unknown, input: JitoQuoteInput): Promise<JitoQuote> {
      return { ...state.quote, operation: input.operation };
    },
    async buildStakeSolTransaction(_connection, input) {
      state.stakeBuilds.push(input);
      return buildResult({ operation: 'stake_sol', amountRaw: input.amountLamports.toString() });
    },
    async buildDepositStakeAccountTransaction(_connection, input: JitoBuildDepositStakeInput) {
      state.depositBuilds?.push(input);
      return buildResult({
        operation: 'deposit_stake_account',
        stakeAccount: input.stakeAccount,
        ...(input.minJitoSolRaw !== undefined && { minJitoSolRaw: input.minJitoSolRaw.toString() }),
        depositReceipt: RECEIPT_ACCOUNT,
      });
    },
    async buildUnstakeJitosolTransaction(_connection, input: JitoBuildUnstakeInput) {
      return buildResult({ operation: 'unstake_jitosol', jitoSolAmountRaw: input.jitoSolAmountRaw.toString() });
    },
    async buildWithdrawSolTransaction(_connection, input: JitoBuildWithdrawSolInput) {
      state.withdrawBuilds?.push(input);
      return buildResult({ operation: 'withdraw_sol', stakeAccount: input.stakeAccount });
    },
    async buildClaimDepositReceiptTransaction(_connection, input: JitoBuildClaimDepositReceiptInput) {
      state.claimBuilds?.push(input);
      return buildResult({ operation: 'claim_deposit_receipt', depositReceipt: input.receiptAddress });
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

function fakeReceipt(overrides: Partial<JitoDepositReceipt> = {}): JitoDepositReceipt {
  return {
    depositReceipt: RECEIPT_ACCOUNT,
    base: '7Q8FfPAuA7iG4Ru4QcR6x6aFZP5Z9znG5xDkYs8uCox4',
    owner: WALLET,
    stakePool: JITO_STAKE_POOL_ADDRESS.toBase58(),
    stakePoolDepositStakeAuthority: '8LQWqdYyHnQ9J5CLqBG2qT59d7fVMCMN2vhb4vPxtVVP',
    lstAmount: '0.9',
    lstAmountRaw: '900000000',
    depositTime: '1710000000',
    depositedAt: '2024-03-09T16:00:00.000Z',
    coolDownSeconds: '86400',
    claimableAt: '2024-03-10T16:00:00.000Z',
    cooldownComplete: true,
    secondsUntilClaimable: 0,
    initialFeeBps: 0,
    programIds: ['DPi1kH3K5FhQ33d7q2UGLZ5V5eQywdYbF9S4vkp6hWgG'],
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
    expect(jitoAdapter.actions.claim_deposit_receipt?.kind).toBe('jito_claim_deposit_receipt');
    expect(jitoAdapter.actions.unstake_jitosol?.kind).toBe('jito_unstake_jitosol');
    expect(jitoAdapter.reads.deposit_receipts?.id).toBe('deposit_receipts');
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

  it('prepares and executes stake-account deposit with the min-output guard', async () => {
    const state: FakeJitoState = { quote: fakeQuote(), stakeBuilds: [], depositBuilds: [] };
    setJitoClientFactory(() => buildFakeJito(state));
    const ctx = makeContext();

    const prepared = await jitoDepositStakeAccountAction.prepare({
      stakeAccount: STAKE_ACCOUNT,
      minJitoSolAmount: '0.8',
    }, ctx);

    expect(prepared.addInput.kind).toBe('jito_deposit_stake_account');
    expect(prepared.preview).toMatchObject({
      connectorId: 'jito',
      stakeAccount: STAKE_ACCOUNT,
      minJitoSolRaw: '800000000',
    });

    const executed = await jitoDepositStakeAccountAction.execute(preparedAction(prepared.addInput), ctx);
    expect(executed.txid).toBe('tx-jito');
    expect(executed.preview).toMatchObject({ depositReceipt: RECEIPT_ACCOUNT });
    expect(state.depositBuilds).toEqual([{
      walletAddress: WALLET,
      stakeAccount: STAKE_ACCOUNT,
      minJitoSolRaw: 800000000n,
    }]);
  });

  it('blocks stake-account deposit when the stake authority is not the wallet', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      stakeAccount: fakeStakeAccount({
        staker: '4mYtJtqRbk6sBFe8PPHYpDCC5LbRRX4puBzYgAZX4qNc',
        eligibleForJitoDeposit: false,
        ineligibleReason: 'Stake authority does not match wallet.',
      }),
    }));

    await expect(jitoDepositStakeAccountAction.prepare({
      stakeAccount: STAKE_ACCOUNT,
    }, makeContext())).rejects.toThrow(/Stake authority/);
  });

  it('reads a specific Jito deposit receipt through the adapter read', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      receipt: fakeReceipt({ lstAmount: '1.25', lstAmountRaw: '1250000000' }),
    }));

    const result = await jitoAdapter.reads.deposit_receipts?.read(
      { receiptAddress: RECEIPT_ACCOUNT },
      makeContext(),
    ) as JitoDepositReceiptsResult;

    expect(result.walletAddress).toBe(WALLET);
    expect(result.receipts[0]).toMatchObject({
      depositReceipt: RECEIPT_ACCOUNT,
      lstAmountRaw: '1250000000',
      cooldownComplete: true,
    });
    expect(result.totals).toMatchObject({ receipts: 1, claimableReceipts: 1, pendingReceipts: 0 });
  });

  it('blocks deposit receipt claim while the receipt is cooling down', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      receipt: fakeReceipt({
        cooldownComplete: false,
        secondsUntilClaimable: 3600,
        claimableAt: '2030-01-01T00:00:00.000Z',
        initialFeeBps: 50,
      }),
    }));

    await expect(jitoClaimDepositReceiptAction.prepare({
      receiptAddress: RECEIPT_ACCOUNT,
    }, makeContext())).rejects.toThrow(/claimable without early-claim fees/);
  });

  it('prepares and executes a deposit receipt claim with explicit early-claim opt-in', async () => {
    const state: FakeJitoState = {
      quote: fakeQuote(),
      stakeBuilds: [],
      claimBuilds: [],
      receipt: fakeReceipt({
        cooldownComplete: false,
        secondsUntilClaimable: 3600,
        claimableAt: '2030-01-01T00:00:00.000Z',
        initialFeeBps: 50,
      }),
    };
    setJitoClientFactory(() => buildFakeJito(state));
    const ctx = makeContext();

    const prepared = await jitoClaimDepositReceiptAction.prepare({
      receiptAddress: RECEIPT_ACCOUNT,
      allowEarlyClaim: true,
    }, ctx);

    expect(prepared.addInput.kind).toBe('jito_claim_deposit_receipt');
    expect(prepared.preview).toMatchObject({
      connectorId: 'jito',
      receiptAddress: RECEIPT_ACCOUNT,
      allowEarlyClaim: true,
    });

    const executed = await jitoClaimDepositReceiptAction.execute(preparedAction(prepared.addInput), ctx);
    expect(executed.txid).toBe('tx-jito');
    expect(state.claimBuilds).toEqual([{
      walletAddress: WALLET,
      receiptAddress: RECEIPT_ACCOUNT,
      allowEarlyClaim: true,
    }]);
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

  it('blocks SOL withdrawal preparation when withdrawAll and amountSol are both set', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      stakeAccount: fakeStakeAccount({ activationState: 'inactive' }),
    }));

    await expect(jitoWithdrawSolAction.prepare({
      stakeAccount: STAKE_ACCOUNT,
      amountSol: '0.1',
      withdrawAll: true,
    }, makeContext())).rejects.toThrow(/both withdrawAll and amountSol/);
  });

  it('blocks partial SOL withdrawal preparation when the amount exceeds the stake account balance', async () => {
    setJitoClientFactory(() => buildFakeJito({
      quote: fakeQuote(),
      stakeBuilds: [],
      stakeAccount: fakeStakeAccount({ activationState: 'inactive', lamports: '1000000000' }),
    }));

    await expect(jitoWithdrawSolAction.prepare({
      stakeAccount: STAKE_ACCOUNT,
      amountSol: '2',
    }, makeContext())).rejects.toThrow(/exceeds the stake account balance/);
  });
});
