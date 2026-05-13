import type { Connection } from '@solana/web3.js';

import {
  getJitoClient,
  type JitoDepositReceipt,
  type JitoDepositReceiptsResult,
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

export function getJitoDepositReceipts(
  connection: Connection,
  walletAddress: string,
  input: { claimableOnly?: boolean } = {},
): Promise<JitoDepositReceiptsResult> {
  return getJitoClient().getWalletDepositReceipts(connection, walletAddress, input);
}

export async function getJitoDepositReceipt(
  connection: Connection,
  receiptAddress: string,
): Promise<JitoDepositReceiptsResult> {
  const receipt = await getJitoClient().getDepositReceipt(connection, receiptAddress);
  return jitoDepositReceiptResult(receipt);
}

function jitoDepositReceiptResult(receipt: JitoDepositReceipt): JitoDepositReceiptsResult {
  return {
    walletAddress: receipt.owner,
    receipts: [receipt],
    totals: {
      receipts: 1,
      claimableReceipts: receipt.cooldownComplete ? 1 : 0,
      lstAmount: receipt.lstAmount,
      lstAmountRaw: receipt.lstAmountRaw,
    },
  };
}
