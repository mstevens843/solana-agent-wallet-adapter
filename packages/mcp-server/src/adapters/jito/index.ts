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
import { getJitoDepositReceipt, getJitoDepositReceipts, getJitoWalletPositions, getJitoWalletStakeAccounts } from './wallet.js';
import {
  jitoClaimDepositReceiptAction,
  jitoDepositStakeAccountAction,
  jitoStakeSolAction,
  jitoUnstakeJitosolAction,
  jitoWithdrawSolAction,
  type JitoClaimDepositReceiptInput,
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

const depositReceiptsRead: AdapterRead<{
  walletAddress?: string;
  receiptAddress?: string;
  claimableOnly?: boolean;
}, unknown> = {
  id: 'deposit_receipts',
  async read(input, ctx) {
    if (input.receiptAddress?.trim()) {
      return getJitoDepositReceipt(ctx.connection, input.receiptAddress.trim());
    }
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return getJitoDepositReceipts(ctx.connection, walletAddress, {
      ...(input.claimableOnly !== undefined && { claimableOnly: input.claimableOnly }),
    });
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
    claim_deposit_receipt: jitoClaimDepositReceiptAction,
  },
  reads: {
    stake_pool_snapshot: stakePoolSnapshotRead,
    wallet_positions: walletPositionsRead,
    wallet_stake_accounts: walletStakeAccountsRead,
    quote: quoteRead,
    deposit_receipts: depositReceiptsRead,
  },
};

export type {
  JitoClaimDepositReceiptInput,
  JitoDepositStakeAccountInput,
  JitoStakeSolInput,
  JitoUnstakeJitosolInput,
  JitoWithdrawSolInput,
};
export type {
  JitoQuote,
  JitoQuoteInput,
  JitoDepositReceipt,
  JitoDepositReceiptsResult,
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
