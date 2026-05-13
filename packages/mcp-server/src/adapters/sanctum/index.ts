import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  sanctumAddInfinityLiquidityAction,
  sanctumRemoveInfinityLiquidityAction,
  sanctumStakeSolToLstAction,
  sanctumSwapLstAction,
  sanctumUnstakeLstToSolAction,
  type SanctumAddInfinityLiquidityInput,
  type SanctumRemoveInfinityLiquidityInput,
  type SanctumStakeSolToLstInput,
  type SanctumSwapLstInput,
  type SanctumUnstakeLstToSolInput,
} from './actions.js';
import {
  SANCTUM_ADAPTER_ID,
  SANCTUM_DESCRIPTION,
  SANCTUM_NAME,
  SANCTUM_PROGRAM_IDS,
  SANCTUM_SUPPORTED_CLUSTERS,
  SANCTUM_WEBSITE,
} from './constants.js';
import {
  getSanctumInfinityPoolSnapshot,
  getSanctumLstSnapshot,
  listSanctumLsts,
} from './lsts.js';
import { getSanctumWalletPositions } from './wallet.js';
import { getSanctumClient } from './client.js';

const lstListRead: AdapterRead<Parameters<typeof listSanctumLsts>[0], unknown> = {
  id: 'lst_list',
  async read(input) {
    return listSanctumLsts(input ?? {});
  },
};

const lstSnapshotRead: AdapterRead<Parameters<typeof getSanctumLstSnapshot>[0], unknown> = {
  id: 'lst_snapshot',
  async read(input) {
    return getSanctumLstSnapshot(input);
  },
};

const infinityPoolSnapshotRead: AdapterRead<Parameters<typeof getSanctumInfinityPoolSnapshot>[0], unknown> = {
  id: 'infinity_pool_snapshot',
  async read(input, ctx) {
    return getSanctumInfinityPoolSnapshot(input ?? {}, ctx);
  },
};

const walletPositionsRead: AdapterRead<Parameters<typeof getSanctumWalletPositions>[0], unknown> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    return getSanctumWalletPositions(input ?? {}, ctx);
  },
};

const quoteRead: AdapterRead<{
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps?: number;
}, unknown> = {
  id: 'quote',
  async read(input) {
    return getSanctumClient().getTokenOrder({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      amountRaw: input.amountRaw,
      ...(input.slippageBps !== undefined && { slippageBps: input.slippageBps }),
    });
  },
};

export const sanctumAdapter: DAppAdapter = {
  id: SANCTUM_ADAPTER_ID,
  name: SANCTUM_NAME,
  website: SANCTUM_WEBSITE,
  description: SANCTUM_DESCRIPTION,
  supportedClusters: SANCTUM_SUPPORTED_CLUSTERS,
  programIds: SANCTUM_PROGRAM_IDS,
  actions: {
    swap_lst: sanctumSwapLstAction,
    add_infinity_liquidity: sanctumAddInfinityLiquidityAction,
    remove_infinity_liquidity: sanctumRemoveInfinityLiquidityAction,
    stake_sol_to_lst: sanctumStakeSolToLstAction,
    unstake_lst_to_sol: sanctumUnstakeLstToSolAction,
  },
  reads: {
    lst_list: lstListRead,
    lst_snapshot: lstSnapshotRead,
    infinity_pool_snapshot: infinityPoolSnapshotRead,
    wallet_positions: walletPositionsRead,
    quote: quoteRead,
  },
};

export type {
  SanctumAddInfinityLiquidityInput,
  SanctumRemoveInfinityLiquidityInput,
  SanctumStakeSolToLstInput,
  SanctumSwapLstInput,
  SanctumUnstakeLstToSolInput,
};

export {
  SANCTUM_ADAPTER_ID,
  SANCTUM_DESCRIPTION,
  SANCTUM_NAME,
  SANCTUM_SUPPORTED_CLUSTERS,
  SANCTUM_WEBSITE,
};
