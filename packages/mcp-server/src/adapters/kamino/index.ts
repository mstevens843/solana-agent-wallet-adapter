import {
  KAMINO_ADAPTER_ID,
  KAMINO_DESCRIPTION,
  KAMINO_NAME,
  KAMINO_SUPPORTED_CLUSTERS,
  KAMINO_WEBSITE,
  KLEND_PROGRAM_ID,
} from './constants.js';
import { buildEarningsProof } from './earningsProof.js';
import { getPositions, summarizePositions } from './positions.js';
import {
  getReserveSnapshot,
  listReserveSnapshots,
} from './reserveSnapshot.js';
import { kaminoDepositAction, type KaminoDepositInput } from './deposit.js';
import { kaminoWithdrawAction, type KaminoWithdrawInput } from './withdraw.js';
import type { DAppAdapter, AdapterRead } from '../types.js';

const getReserveSnapshotRead: AdapterRead<{ token?: string; reserveMint?: string }, unknown> = {
  id: 'reserve_snapshot',
  async read(input, ctx) {
    const token = input.token ?? input.reserveMint ?? 'SOL';
    return getReserveSnapshot(ctx.connection, token);
  },
};

const listReservesRead: AdapterRead<Record<string, never>, unknown> = {
  id: 'list_reserves',
  async read(_input, ctx) {
    return listReserveSnapshots(ctx.connection);
  },
};

const getPositionsRead: AdapterRead<{ walletAddress?: string }, unknown> = {
  id: 'positions',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const positions = await getPositions(ctx.connection, walletAddress);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      positions,
      totals: summarizePositions(positions),
    };
  },
};

const earningsProofRead: AdapterRead<{ walletAddress?: string; reserveMint?: string }, unknown> = {
  id: 'earnings_proof',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    return buildEarningsProof(ctx.connection, {
      walletAddress,
      cluster: ctx.config.cluster,
      ...(input.reserveMint?.trim() ? { reserveMint: input.reserveMint.trim() } : {}),
    });
  },
};

export const kaminoAdapter: DAppAdapter = {
  id: KAMINO_ADAPTER_ID,
  name: KAMINO_NAME,
  website: KAMINO_WEBSITE,
  description: KAMINO_DESCRIPTION,
  supportedClusters: KAMINO_SUPPORTED_CLUSTERS,
  programIds: [KLEND_PROGRAM_ID],
  actions: {
    deposit: kaminoDepositAction,
    withdraw: kaminoWithdrawAction,
  },
  reads: {
    reserve_snapshot: getReserveSnapshotRead,
    list_reserves: listReservesRead,
    positions: getPositionsRead,
    earnings_proof: earningsProofRead,
  },
};

export type { KaminoDepositInput, KaminoWithdrawInput };
export {
  KAMINO_ADAPTER_ID,
  KAMINO_NAME,
  KAMINO_WEBSITE,
  KAMINO_DESCRIPTION,
  KAMINO_SUPPORTED_CLUSTERS,
  KLEND_PROGRAM_ID,
};
