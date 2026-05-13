import type { Connection } from '@solana/web3.js';

import { getSaveClient, type SaveObligation } from './client.js';
import { SAVE_MAIN_MARKET } from './constants.js';

export async function getObligation(
  connection: Connection,
  walletAddress: string,
  marketAddress?: string,
): Promise<SaveObligation | null> {
  const market = marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();
  return getSaveClient().getObligation(connection, walletAddress, market);
}

export function findDepositForReserve(
  obligation: SaveObligation | null,
  reserveMint: string,
): SaveObligation['deposits'][number] | undefined {
  if (!obligation) return undefined;
  return obligation.deposits.find((entry) => entry.reserveMint === reserveMint);
}

export function findBorrowForReserve(
  obligation: SaveObligation | null,
  reserveMint: string,
): SaveObligation['borrows'][number] | undefined {
  if (!obligation) return undefined;
  return obligation.borrows.find((entry) => entry.reserveMint === reserveMint);
}
