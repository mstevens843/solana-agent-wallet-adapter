import type { Connection } from '@solana/web3.js';

import { AdapterError } from '../types.js';

import { getSaveClient, type SaveReserveSnapshot } from './client.js';
import { SAVE_ADAPTER_ID, SAVE_MAIN_MARKET, resolveKnownReserve } from './constants.js';

export async function getReserveSnapshot(
  connection: Connection,
  tokenOrMint: string,
  marketAddress?: string,
): Promise<SaveReserveSnapshot> {
  const identifier = tokenOrMint.trim();
  if (!identifier) {
    throw new AdapterError(
      SAVE_ADAPTER_ID,
      'invalid_request',
      'Pass token (SOL, USDC, USDT) or reserveMint to read a Save reserve.',
    );
  }
  const known = resolveKnownReserve(identifier);
  const reserveMint = known?.mint ?? identifier;
  const market = marketAddress?.trim() || known?.market.toBase58() || SAVE_MAIN_MARKET.toBase58();
  return getSaveClient().getReserveSnapshot(connection, reserveMint, market);
}

export async function listReserveSnapshots(
  connection: Connection,
  marketAddress?: string,
): Promise<SaveReserveSnapshot[]> {
  const market = marketAddress?.trim() || SAVE_MAIN_MARKET.toBase58();
  return getSaveClient().listReserveSnapshots(connection, market);
}
