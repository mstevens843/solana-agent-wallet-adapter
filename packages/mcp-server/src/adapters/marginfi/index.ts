import {
  MARGINFI_ADAPTER_ID,
  MARGINFI_DESCRIPTION,
  MARGINFI_NAME,
  MARGINFI_PROGRAM_ID,
  MARGINFI_SUPPORTED_CLUSTERS,
  MARGINFI_WEBSITE,
} from './constants.js';
import { getMarginfiClient } from './client.js';
import { marginfiAction, type MarginfiActionInput } from './actions.js';
import type { AdapterRead, DAppAdapter } from '../types.js';

const bankSnapshotRead: AdapterRead<{ bankAddress?: string; bankMint?: string; token?: string }, unknown> = {
  id: 'bank_snapshot',
  async read(input, ctx) {
    const walletAddress = await ctx.backend.getAddress();
    return getMarginfiClient(walletAddress).then((client) => client.getBankSnapshot(ctx.connection, input));
  },
};

const walletAccountsRead: AdapterRead<{ walletAddress?: string }, unknown> = {
  id: 'wallet_accounts',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    const client = await getMarginfiClient(walletAddress);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      accounts: await client.getWalletAccounts(ctx.connection, walletAddress),
    };
  },
};

const accountDetailRead: AdapterRead<{ walletAddress?: string; marginfiAccount?: string }, unknown> = {
  id: 'account_detail',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    const client = await getMarginfiClient(walletAddress);
    return client.getAccountDetail(ctx.connection, {
      walletAddress,
      ...(input.marginfiAccount !== undefined && { marginfiAccount: input.marginfiAccount }),
    });
  },
};

const healthPreviewRead: AdapterRead<MarginfiActionInput & { operation: 'deposit' | 'withdraw' | 'borrow' | 'repay'; walletAddress?: string; minHealthRatio?: number }, unknown> = {
  id: 'health_preview',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    const client = await getMarginfiClient(walletAddress);
    return client.previewHealth(ctx.connection, {
      operation: input.operation,
      walletAddress,
      ...(input.bankAddress !== undefined && { bankAddress: input.bankAddress }),
      ...(input.bankMint !== undefined && { bankMint: input.bankMint }),
      ...(input.token !== undefined && { token: input.token }),
      ...(input.amount !== undefined && { amount: input.amount }),
      ...(input.marginfiAccount !== undefined && { marginfiAccount: input.marginfiAccount }),
      ...(input.withdrawAll !== undefined && { withdrawAll: input.withdrawAll }),
      ...(input.repayAll !== undefined && { repayAll: input.repayAll }),
      ...(input.minHealthRatio !== undefined && { minHealthRatio: input.minHealthRatio }),
    });
  },
};

export const marginfiAdapter: DAppAdapter = {
  id: MARGINFI_ADAPTER_ID,
  name: MARGINFI_NAME,
  website: MARGINFI_WEBSITE,
  description: MARGINFI_DESCRIPTION,
  supportedClusters: MARGINFI_SUPPORTED_CLUSTERS,
  programIds: [MARGINFI_PROGRAM_ID],
  actions: {
    deposit: marginfiAction('deposit'),
    withdraw: marginfiAction('withdraw'),
    borrow: marginfiAction('borrow'),
    repay: marginfiAction('repay'),
  },
  reads: {
    bank_snapshot: bankSnapshotRead,
    wallet_accounts: walletAccountsRead,
    account_detail: accountDetailRead,
    health_preview: healthPreviewRead,
  },
};

export type { MarginfiActionInput };
export {
  MARGINFI_ADAPTER_ID,
  MARGINFI_NAME,
  MARGINFI_WEBSITE,
  MARGINFI_DESCRIPTION,
  MARGINFI_SUPPORTED_CLUSTERS,
  MARGINFI_PROGRAM_ID,
};

