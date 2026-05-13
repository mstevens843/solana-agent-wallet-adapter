import {
  DRIFT_ADAPTER_ID,
  DRIFT_DESCRIPTION,
  DRIFT_NAME,
  DRIFT_PROGRAM_ID,
  DRIFT_SUPPORTED_CLUSTERS,
  DRIFT_VAULTS_PROGRAM_ID,
  type DriftWithdrawUnit,
} from './constants.js';
import { getUserSnapshot, summarizeUserSnapshot } from './users.js';
import {
  driftVaultDepositAction,
  getVaultSnapshot,
  getWalletVaultPositions,
  summarizeVaultPositions,
  type DriftVaultDepositInput,
} from './vaults.js';
import {
  driftVaultCancelWithdrawAction,
  driftVaultCompleteWithdrawAction,
  driftVaultRequestWithdrawAction,
  getWithdrawStatus,
  type DriftVaultCancelWithdrawInput,
  type DriftVaultCompleteWithdrawInput,
  type DriftVaultRequestWithdrawInput,
} from './withdrawals.js';
import type { AdapterRead, DAppAdapter } from '../types.js';

const userSnapshotRead: AdapterRead<
  { walletAddress?: string; subAccountId?: number },
  unknown
> = {
  id: 'user_snapshot',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const snapshot = await getUserSnapshot(ctx.connection, walletAddress, input.subAccountId);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      snapshot,
      facts: summarizeUserSnapshot(snapshot),
    };
  },
};

const vaultSnapshotRead: AdapterRead<{ vaultAddress: string }, unknown> = {
  id: 'vault_snapshot',
  async read(input, ctx) {
    const snapshot = await getVaultSnapshot(ctx.connection, input.vaultAddress);
    return {
      cluster: ctx.config.cluster,
      snapshot,
      facts: {
        vaultAddress: snapshot.vaultAddress,
        name: snapshot.name,
        manager: snapshot.manager,
        depositMint: snapshot.depositMint,
        depositSymbol: snapshot.depositSymbol ?? null,
        decimals: snapshot.decimals,
        sharePrice: snapshot.sharePrice,
        totalShares: snapshot.totalShares,
        totalValue: snapshot.totalValue,
        redeemPeriodSec: snapshot.redeemPeriodSec,
        lockupSec: snapshot.lockupSec,
        profitShareBps: snapshot.profitShareBps,
        managementFeeBps: snapshot.managementFeeBps,
        hurdleRateBps: snapshot.hurdleRateBps ?? null,
        pendingWithdrawShares: snapshot.pendingWithdrawShares,
      },
    };
  },
};

const walletVaultPositionsRead: AdapterRead<
  { walletAddress?: string; vaultAddress?: string },
  unknown
> = {
  id: 'wallet_vault_positions',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const positions = await getWalletVaultPositions(ctx.connection, walletAddress, input.vaultAddress);
    const totals = summarizeVaultPositions(positions);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      positions,
      totals,
      facts: {
        walletAddress,
        vaultCount: totals.vaultCount,
        pendingWithdrawCount: totals.pendingWithdrawCount,
        totalShares: totals.totalShares,
        totalValue: totals.totalValue,
        vaults: positions.map((entry) => ({
          vaultAddress: entry.vaultAddress,
          shares: entry.shares,
          valueAtSharePrice: entry.valueAtSharePrice,
          pendingWithdrawShares: entry.pendingWithdrawShares,
          redeemableAt: entry.redeemableAt
            ? new Date(entry.redeemableAt * 1000).toISOString()
            : null,
        })),
      },
    };
  },
};

const withdrawStatusRead: AdapterRead<
  { walletAddress?: string; vaultAddress: string },
  unknown
> = {
  id: 'withdraw_status',
  async read(input, ctx) {
    const walletAddress = input.walletAddress?.trim() || (await ctx.backend.getAddress());
    const status = await getWithdrawStatus(ctx.connection, walletAddress, input.vaultAddress);
    return {
      walletAddress,
      cluster: ctx.config.cluster,
      status,
      facts: {
        hasPendingRequest: status.hasPendingRequest,
        requestedShares: status.requestedShares,
        requestedValue: status.requestedValue ?? null,
        redeemableAt: status.redeemableAt
          ? new Date(status.redeemableAt * 1000).toISOString()
          : null,
        isReady: status.isReady,
        redeemPeriodSec: status.redeemPeriodSec,
        lockupSec: status.lockupSec,
      },
    };
  },
};

export const driftAdapter: DAppAdapter = {
  id: DRIFT_ADAPTER_ID,
  name: DRIFT_NAME,
  website: 'https://app.drift.trade',
  description: DRIFT_DESCRIPTION,
  supportedClusters: DRIFT_SUPPORTED_CLUSTERS,
  programIds: [DRIFT_VAULTS_PROGRAM_ID, DRIFT_PROGRAM_ID],
  actions: {
    vault_deposit: driftVaultDepositAction,
    vault_request_withdraw: driftVaultRequestWithdrawAction,
    vault_cancel_withdraw: driftVaultCancelWithdrawAction,
    vault_complete_withdraw: driftVaultCompleteWithdrawAction,
  },
  reads: {
    user_snapshot: userSnapshotRead,
    vault_snapshot: vaultSnapshotRead,
    wallet_vault_positions: walletVaultPositionsRead,
    withdraw_status: withdrawStatusRead,
  },
};

export type {
  DriftVaultDepositInput,
  DriftVaultRequestWithdrawInput,
  DriftVaultCancelWithdrawInput,
  DriftVaultCompleteWithdrawInput,
  DriftWithdrawUnit,
};
export {
  DRIFT_ADAPTER_ID,
  DRIFT_NAME,
  DRIFT_DESCRIPTION,
  DRIFT_SUPPORTED_CLUSTERS,
  DRIFT_VAULTS_PROGRAM_ID,
  DRIFT_PROGRAM_ID,
};
