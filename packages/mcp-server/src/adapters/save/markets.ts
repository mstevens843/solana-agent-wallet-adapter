import type { Connection } from '@solana/web3.js';

import { getSaveClient, type SaveMarketSnapshot } from './client.js';
import { SAVE_MAIN_MARKET } from './constants.js';

export async function getMarketSnapshot(
  connection: Connection,
  marketAddress?: string,
): Promise<SaveMarketSnapshot> {
  const target = marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();
  return getSaveClient().getMarketSnapshot(connection, target);
}
