import type { Connection } from '@solana/web3.js';

import {
  getJitoClient,
  type JitoStakeAccount,
  type JitoWalletPositionsResult,
} from './client.js';

export function getJitoWalletPositions(
  connection: Connection,
  walletAddress: string,
  input: { includeStakeAccounts?: boolean; delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean } = {},
): Promise<JitoWalletPositionsResult> {
  return getJitoClient().getWalletPositions(connection, walletAddress, input);
}

export function getJitoWalletStakeAccounts(
  connection: Connection,
  walletAddress: string,
  input: { delegatedOnly?: boolean; eligibleForJitoDepositOnly?: boolean } = {},
): Promise<JitoStakeAccount[]> {
  return getJitoClient().getWalletStakeAccounts(connection, walletAddress, input);
}
