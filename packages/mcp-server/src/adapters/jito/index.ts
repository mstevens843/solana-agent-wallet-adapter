import {
  JITO_ADAPTER_ID,
  JITO_DESCRIPTION,
  JITO_NAME,
  JITO_STAKE_DEPOSIT_INTERCEPTOR_PROGRAM_ID,
  JITO_STAKE_POOL_ADDRESS,
  JITO_SUPPORTED_CLUSTERS,
  JITO_WEBSITE,
  JITOSOL_MINT,
  SPL_STAKE_POOL_PROGRAM_ID,
} from './constants.js';
import { getJitoStakePoolSnapshot, quoteJito } from './pool.js';
import { getJitoWalletPositions, getJitoWalletStakeAccounts } from './wallet.js';
import {
  jitoDepositStakeAccountAction,
  jitoStakeSolAction,
  jitoUnstakeJitosolAction,
  jitoWithdrawSolAction,
  type JitoDepositStakeAccountInput,
  type JitoStakeSolInput,
  type JitoUnstakeJitosolInput,
  type JitoWithdrawSolInput,
} from './actions.js';
import type { AdapterRead, DAppAdapter } from '../types.js';

const stakePoolSnapshotRead: AdapterRead<{ includeValidators?: boolean }, unknown> = {
  id: 'stake_pool_snapshot',
  async read(input, ctx) {
    return getJitoStakePoolSnapshot(ctx.connection, input);
  },
};

const walletPositionsRead: AdapterRead<{
  walletAddress?: string;
  includeStakeAccounts?: boolean;
  delegatedOnly?: boolean;
  eligibleForJitoDepositOnly?: boolean;
}, unknown> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return getJitoWalletPositions(ctx.connection, walletAddress, {
      ...(input.includeStakeAccounts !== undefined && { includeStakeAccounts: input.includeStakeAccounts }),
      ...(input.delegatedOnly !== undefined && { delegatedOnly: input.delegatedOnly }),
      ...(input.eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly: input.eligibleForJitoDepositOnly }),
    });
  },
};

const walletStakeAccountsRead: AdapterRead<{
  walletAddress?: string;
  delegatedOnly?: boolean;
  eligibleForJitoDepositOnly?: boolean;
}, unknown> = {
  id: 'wallet_stake_accounts',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return {
      walletAddress,
      stakeAccounts: await getJitoWalletStakeAccounts(ctx.connection, walletAddress, {
        ...(input.delegatedOnly !== undefined && { delegatedOnly: input.delegatedOnly }),
        ...(input.eligibleForJitoDepositOnly !== undefined && { eligibleForJitoDepositOnly: input.eligibleForJitoDepositOnly }),
      }),
    };
  },
};

const quoteRead: AdapterRead<Parameters<typeof quoteJito>[1], unknown> = {
  id: 'quote',
  async read(input, ctx) {
    return quoteJito(ctx.connection, input);
  },
};

export const jitoAdapter: DAppAdapter = {
  id: JITO_ADAPTER_ID,
  name: JITO_NAME,
  website: JITO_WEBSITE,
  description: JITO_DESCRIPTION,
  supportedClusters: JITO_SUPPORTED_CLUSTERS,
  programIds: [SPL_STAKE_POOL_PROGRAM_ID, JITO_STAKE_DEPOSIT_INTERCEPTOR_PROGRAM_ID],
  actions: {
    stake_sol: jitoStakeSolAction,
    deposit_stake_account: jitoDepositStakeAccountAction,
    unstake_jitosol: jitoUnstakeJitosolAction,
    withdraw_sol: jitoWithdrawSolAction,
  },
  reads: {
    stake_pool_snapshot: stakePoolSnapshotRead,
    wallet_positions: walletPositionsRead,
    wallet_stake_accounts: walletStakeAccountsRead,
    quote: quoteRead,
  },
};

export type {
  JitoDepositStakeAccountInput,
  JitoStakeSolInput,
  JitoUnstakeJitosolInput,
  JitoWithdrawSolInput,
};
export type {
  JitoQuote,
  JitoQuoteInput,
  JitoStakeAccount,
  JitoStakePoolSnapshot,
  JitoWalletPositionsResult,
  JitoWithdrawMode,
} from './client.js';
export {
  describeJitoStakeDepositUnavailableReason,
  describeJitoUnavailableReason,
  getJitoClient,
  isJitoConfigured,
  resetJitoClientFactory,
  setJitoClientFactory,
} from './client.js';
export {
  JITO_ADAPTER_ID,
  JITO_DESCRIPTION,
  JITO_NAME,
  JITO_STAKE_POOL_ADDRESS,
  JITO_SUPPORTED_CLUSTERS,
  JITO_WEBSITE,
  JITOSOL_MINT,
  SPL_STAKE_POOL_PROGRAM_ID,
};
