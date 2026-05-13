import type { Connection } from '@solana/web3.js';

import { getDriftVaultClient, type DriftUserSnapshot } from './client.js';

export async function getUserSnapshot(
  connection: Connection,
  walletAddress: string,
  subAccountId?: number,
): Promise<DriftUserSnapshot> {
  if (!walletAddress || !walletAddress.trim()) {
    throw new Error('walletAddress is required to read a Drift user snapshot.');
  }
  return getDriftVaultClient().getUserSnapshot(connection, walletAddress.trim(), subAccountId);
}

export function summarizeUserSnapshot(snapshot: DriftUserSnapshot): {
  depositCount: number;
  borrowCount: number;
  totalCollateral: string;
  freeCollateral: string;
  marginRatio: number;
  healthPercent?: number;
} {
  return {
    depositCount: snapshot.deposits.length,
    borrowCount: snapshot.borrows.length,
    totalCollateral: snapshot.totalCollateral,
    freeCollateral: snapshot.freeCollateral,
    marginRatio: snapshot.marginRatio,
    ...(snapshot.healthPercent !== undefined ? { healthPercent: snapshot.healthPercent } : {}),
  };
}
