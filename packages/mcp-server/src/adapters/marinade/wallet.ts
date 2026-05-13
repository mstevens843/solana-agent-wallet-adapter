import type { Connection } from '@solana/web3.js';

import {
  getMarinadeClient,
  type MarinadeStakeAccount,
  type MarinadeWalletPositionsResult,
} from './client.js';

export async function readMarinadeWalletPositions(
  connection: Connection,
  walletAddress: string,
): Promise<MarinadeWalletPositionsResult> {
  return getMarinadeClient().getWalletPositions(connection, walletAddress);
}

export async function readMarinadeWalletStakeAccounts(
  connection: Connection,
  walletAddress: string,
): Promise<MarinadeStakeAccount[]> {
  return getMarinadeClient().getStakeAccounts(connection, walletAddress);
}
