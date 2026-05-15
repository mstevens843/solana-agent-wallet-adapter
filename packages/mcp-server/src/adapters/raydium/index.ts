import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  RAYDIUM_ADAPTER_ID,
  RAYDIUM_DESCRIPTION,
  RAYDIUM_NAME,
  RAYDIUM_POOL_PROGRAM_IDS,
  RAYDIUM_SUPPORTED_CLUSTERS,
  RAYDIUM_WEBSITE,
} from './constants.js';
import {
  quoteRaydiumAddLiquidity,
  raydiumAddLiquidityAction,
  raydiumCollectFeesAction,
  raydiumRemoveLiquidityAction,
  type RaydiumAddLiquidityPrepareInput,
  type RaydiumCollectFeesPrepareInput,
  type RaydiumRemoveLiquidityPrepareInput,
} from './liquidity.js';
import {
  raydiumFarmStakeAction,
  raydiumFarmUnstakeAction,
  raydiumHarvestAction,
  type RaydiumFarmPrepareInput,
} from './farm.js';
import { getRaydiumPoolSnapshot } from './pools.js';
import { getRaydiumPositionDetail, getRaydiumWalletPositions } from './positions.js';
import type { RaydiumLiquidityPoolType, RaydiumPoolType } from './client.js';

const poolSnapshotRead: AdapterRead<{ poolId: string; poolType?: RaydiumPoolType | string }, unknown> = {
  id: 'pool_snapshot',
  async read(input, ctx) {
    return getRaydiumPoolSnapshot(ctx, input);
  },
};

const walletPositionsRead: AdapterRead<{
  walletAddress?: string;
  poolId?: string;
  poolType?: RaydiumLiquidityPoolType | string;
  farmId?: string;
}, unknown> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    return getRaydiumWalletPositions(ctx, input);
  },
};

const positionDetailRead: AdapterRead<{ walletAddress?: string; positionMint: string; poolId?: string }, unknown> = {
  id: 'position_detail',
  async read(input, ctx) {
    return getRaydiumPositionDetail(ctx, input);
  },
};

export const raydiumAdapter: DAppAdapter = {
  id: RAYDIUM_ADAPTER_ID,
  name: RAYDIUM_NAME,
  website: RAYDIUM_WEBSITE,
  description: RAYDIUM_DESCRIPTION,
  supportedClusters: RAYDIUM_SUPPORTED_CLUSTERS,
  programIds: RAYDIUM_POOL_PROGRAM_IDS,
  actions: {
    add_liquidity: raydiumAddLiquidityAction,
    remove_liquidity: raydiumRemoveLiquidityAction,
    collect_fees: raydiumCollectFeesAction,
    farm_stake: raydiumFarmStakeAction,
    farm_unstake: raydiumFarmUnstakeAction,
    harvest: raydiumHarvestAction,
  },
  reads: {
    pool_snapshot: poolSnapshotRead,
    wallet_positions: walletPositionsRead,
    position_detail: positionDetailRead,
  },
};

export type {
  RaydiumAddLiquidityPrepareInput,
  RaydiumCollectFeesPrepareInput,
  RaydiumFarmPrepareInput,
  RaydiumRemoveLiquidityPrepareInput,
};
export { quoteRaydiumAddLiquidity };
export {
  RAYDIUM_ADAPTER_ID,
  RAYDIUM_DESCRIPTION,
  RAYDIUM_NAME,
  RAYDIUM_POOL_PROGRAM_IDS,
  RAYDIUM_SUPPORTED_CLUSTERS,
  RAYDIUM_WEBSITE,
};
export {
  describeRaydiumUnavailableReason,
  getRaydiumClient,
  resetRaydiumClientFactory,
  setRaydiumClientFactory,
  type RaydiumActionPreview,
  type RaydiumClient,
  type RaydiumLiquidityPoolType,
  type RaydiumPoolSnapshot,
  type RaydiumPoolType,
  type RaydiumPosition,
  type RaydiumWalletPositionsResult,
} from './client.js';
