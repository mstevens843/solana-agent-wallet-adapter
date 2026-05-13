import type { AdapterRead, DAppAdapter } from '../types.js';
import {
  ORCA_ADAPTER_ID,
  ORCA_DESCRIPTION,
  ORCA_NAME,
  ORCA_SUPPORTED_CLUSTERS,
  ORCA_WEBSITE,
  WHIRLPOOL_PROGRAM_ID,
} from './constants.js';
import { orcaCollectFeesAction, orcaCollectRewardsAction, type OrcaCollectPrepareInput } from './fees.js';
import {
  orcaDecreaseLiquidityAction,
  orcaIncreaseLiquidityAction,
  type OrcaDecreaseLiquidityPrepareInput,
  type OrcaIncreaseLiquidityPrepareInput,
} from './liquidity.js';
import { getPositionDetail, getWalletPositions } from './positions.js';
import { getWhirlpoolSnapshot } from './whirlpools.js';

const whirlpoolSnapshotRead: AdapterRead<{ whirlpoolAddress: string }, unknown> = {
  id: 'whirlpool_snapshot',
  async read(input, ctx) {
    return getWhirlpoolSnapshot(ctx, input.whirlpoolAddress);
  },
};

const walletPositionsRead: AdapterRead<{ walletAddress?: string; whirlpoolAddress?: string }, unknown> = {
  id: 'wallet_positions',
  async read(input, ctx) {
    return getWalletPositions(ctx, input);
  },
};

const positionDetailRead: AdapterRead<{ positionMint: string; whirlpoolAddress?: string }, unknown> = {
  id: 'position_detail',
  async read(input, ctx) {
    return getPositionDetail(ctx, input);
  },
};

export const orcaAdapter: DAppAdapter = {
  id: ORCA_ADAPTER_ID,
  name: ORCA_NAME,
  website: ORCA_WEBSITE,
  description: ORCA_DESCRIPTION,
  supportedClusters: ORCA_SUPPORTED_CLUSTERS,
  programIds: [WHIRLPOOL_PROGRAM_ID],
  actions: {
    increase_liquidity: orcaIncreaseLiquidityAction,
    decrease_liquidity: orcaDecreaseLiquidityAction,
    collect_fees: orcaCollectFeesAction,
    collect_rewards: orcaCollectRewardsAction,
  },
  reads: {
    whirlpool_snapshot: whirlpoolSnapshotRead,
    wallet_positions: walletPositionsRead,
    position_detail: positionDetailRead,
  },
};

export type {
  OrcaCollectPrepareInput,
  OrcaDecreaseLiquidityPrepareInput,
  OrcaIncreaseLiquidityPrepareInput,
};
export {
  ORCA_ADAPTER_ID,
  ORCA_NAME,
  ORCA_WEBSITE,
  ORCA_DESCRIPTION,
  ORCA_SUPPORTED_CLUSTERS,
  WHIRLPOOL_PROGRAM_ID,
};
