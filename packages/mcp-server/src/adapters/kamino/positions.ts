import type { Connection } from '@solana/web3.js';

import { getKaminoClient, type KaminoPosition } from './client.js';

export async function getPositions(
  connection: Connection,
  walletAddress: string,
): Promise<KaminoPosition[]> {
  if (!walletAddress || !walletAddress.trim()) {
    throw new Error('walletAddress is required to read Kamino positions.');
  }
  return getKaminoClient().getPositions(connection, walletAddress.trim());
}

export function summarizePositions(positions: KaminoPosition[]): {
  reserves: number;
  totalSupplied: string;
  totalEarned: string;
} {
  let totalSupplied = 0;
  let totalEarned = 0;
  for (const position of positions) {
    const supplied = Number(position.suppliedAmount);
    const earned = Number(position.earnedInterest);
    if (Number.isFinite(supplied)) totalSupplied += supplied;
    if (Number.isFinite(earned)) totalEarned += earned;
  }
  return {
    reserves: positions.length,
    totalSupplied: trimNumber(totalSupplied),
    totalEarned: trimNumber(totalEarned),
  };
}

function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/\.?0+$/, '');
}
