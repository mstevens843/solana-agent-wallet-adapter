import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  METEORA_ADAPTER_ID,
  METEORA_DESCRIPTION,
  METEORA_DLMM_PROGRAM_ID,
  METEORA_NAME,
  METEORA_SUPPORTED_CLUSTERS,
  METEORA_WEBSITE,
} from './constants.js';
import {
  meteoraClaimFeesAction,
  meteoraClaimRewardsAction,
  type MeteoraClaimPrepareInput,
} from './claims.js';
import {
  meteoraAddLiquidityAction,
  meteoraClosePositionAction,
  meteoraRemoveLiquidityAction,
  type MeteoraAddLiquidityPrepareInput,
  type MeteoraClosePositionPrepareInput,
  type MeteoraRemoveLiquidityPrepareInput,
} from './liquidity.js';
import { getPoolSnapshot } from './pools.js';
import { getPositionDetail, getWalletPositions } from './positions.js';

const poolSnapshotRead: AdapterRead<{ poolAddress: string }, unknown> = {
  id: 'pool_snapshot',
  async read(input, ctx) {
    return getPoolSnapshot(ctx, input.poolAddress);
  },
};

const walletPositionsRead: AdapterRead<{ walletAddress?: string; poolAddress?: string }, unknown> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    return getWalletPositions(ctx, input);
  },
};

const positionDetailRead: AdapterRead<{ poolAddress: string; positionAddress: string }, unknown> = {
  id: 'position_detail',
  async read(input, ctx) {
    return getPositionDetail(ctx, input);
  },
};

export const meteoraAdapter: DAppAdapter = {
  id: METEORA_ADAPTER_ID,
  name: METEORA_NAME,
  website: METEORA_WEBSITE,
  description: METEORA_DESCRIPTION,
  supportedClusters: METEORA_SUPPORTED_CLUSTERS,
  programIds: [METEORA_DLMM_PROGRAM_ID],
  actions: {
    claim_fees: meteoraClaimFeesAction,
    claim_rewards: meteoraClaimRewardsAction,
    add_liquidity: meteoraAddLiquidityAction,
    remove_liquidity: meteoraRemoveLiquidityAction,
    close_position: meteoraClosePositionAction,
  },
  reads: {
    pool_snapshot: poolSnapshotRead,
    wallet_positions: walletPositionsRead,
    position_detail: positionDetailRead,
  },
};

export type {
  MeteoraAddLiquidityPrepareInput,
  MeteoraClaimPrepareInput,
  MeteoraClosePositionPrepareInput,
  MeteoraRemoveLiquidityPrepareInput,
};
export {
  METEORA_ADAPTER_ID,
  METEORA_NAME,
  METEORA_WEBSITE,
  METEORA_DESCRIPTION,
  METEORA_SUPPORTED_CLUSTERS,
  METEORA_DLMM_PROGRAM_ID,
};
export {
  getMeteoraClient,
  resetMeteoraClientFactory,
  setMeteoraClientFactory,
  type MeteoraClient,
  type MeteoraPoolSnapshot,
  type MeteoraPosition,
  type MeteoraWalletPositionsResult,
} from './client.js';
