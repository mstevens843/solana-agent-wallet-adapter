import {
  PROJECT0_ADAPTER_ID,
  PROJECT0_DESCRIPTION,
  PROJECT0_NAME,
  PROJECT0_PROGRAM_ID,
  PROJECT0_SUPPORTED_CLUSTERS,
  PROJECT0_WEBSITE,
} from './constants.js';
import { getProject0Client, normalizeProject0ActionInput, type Project0ActionInput } from './client.js';
import { project0Action, project0ApiBaseUrl, type Project0PrepareInput } from './actions.js';
import type { AdapterRead, DAppAdapter } from '../types.js';

const banksRead: AdapterRead<{ bankAddress?: string; bankMint?: string; token?: string }, unknown> = {
  id: 'banks',
  async read(input, ctx) {
    return getProject0Client(project0ApiBaseUrl(ctx.config)).listBanks(input);
  },
};

const strategiesRead: AdapterRead<Record<string, never>, unknown> = {
  id: 'strategies',
  async read(_input, ctx) {
    return getProject0Client(project0ApiBaseUrl(ctx.config)).listStrategies();
  },
};

const walletRead: AdapterRead<{ walletAddress?: string }, unknown> = {
  id: 'wallet',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    return getProject0Client(project0ApiBaseUrl(ctx.config)).getWallet(walletAddress);
  },
};

const accountDetailRead: AdapterRead<{ walletAddress?: string; project0Account?: string }, unknown> = {
  id: 'account_detail',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    return getProject0Client(project0ApiBaseUrl(ctx.config)).getAccountDetail(ctx.connection, {
      walletAddress,
      ...(input.project0Account !== undefined && { project0Account: input.project0Account }),
    });
  },
};

const healthPreviewRead: AdapterRead<Project0ActionInput & { walletAddress?: string }, unknown> = {
  id: 'health_preview',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || await ctx.backend.getAddress();
    return getProject0Client(project0ApiBaseUrl(ctx.config)).previewHealth(ctx.connection, normalizeProject0ActionInput({
      ...input,
      walletAddress,
    }));
  },
};

export const project0Adapter: DAppAdapter = {
  id: PROJECT0_ADAPTER_ID,
  name: PROJECT0_NAME,
  website: PROJECT0_WEBSITE,
  description: PROJECT0_DESCRIPTION,
  supportedClusters: PROJECT0_SUPPORTED_CLUSTERS,
  programIds: [PROJECT0_PROGRAM_ID],
  actions: {
    create_account: project0Action('create_account'),
    deposit: project0Action('deposit'),
    withdraw: project0Action('withdraw'),
    borrow: project0Action('borrow'),
    repay: project0Action('repay'),
  },
  reads: {
    banks: banksRead,
    strategies: strategiesRead,
    wallet: walletRead,
    account_detail: accountDetailRead,
    health_preview: healthPreviewRead,
  },
};

export type { Project0ActionInput, Project0PrepareInput };
export {
  PROJECT0_ADAPTER_ID,
  PROJECT0_NAME,
  PROJECT0_WEBSITE,
  PROJECT0_DESCRIPTION,
  PROJECT0_SUPPORTED_CLUSTERS,
  PROJECT0_PROGRAM_ID,
};
